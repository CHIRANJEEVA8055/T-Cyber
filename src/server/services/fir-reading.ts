import { extractFromLines, type ExtractedCandidate, type SourceLine } from "@/domain/extraction";
import { decideMo, type MoDecision } from "../ai/mo-classify";
import { MO_VERTICALS } from "@/domain/mo-verticals";
import { proposeCaseFromFir, type FirProposal } from "@/domain/extraction/fir-intake";
import { briefFromFir, firstStepsFromFir, foundDetails, scriptOf } from "@/domain/extraction/fir-brief";
import { parseDocument } from "../documents/parse";
import { validateUpload } from "../storage";
import { AppError } from "../errors";
import { localGenerate, localModelStatus } from "../ai/local-model";

/**
 * Reads an FIR copy for the New FIR window, in four steps reported as they finish. Rules do the reading wherever
 * the copy has an English text layer. The local model is used only to transcribe scanned pages and to translate
 * Telugu or Hindi; what it produces is shown as the model's reading, to be checked against the original.
 */

export type StepKey = "read" | "brief" | "classify" | "details" | "plan";
export interface StepEvent {
  key: StepKey;
  status: "start" | "done" | "failed";
  label: string;
  sub: string;
}

export interface FirReading {
  fileName: string;
  sizeBytes: number;
  pages: number | null;
  mimeType: string;
  readable: boolean;
  note: string | null;
  how: "TEXT" | "TRANSLATED" | "TRANSCRIBED";
  language: "English" | "Telugu" | "Hindi";
  modelUsed: string | null;
  /** The model's transcription or translation, page by page, when one was made. */
  modelText: string | null;
  /** The text the rules read, page by page (the copy's own text, or the model's English): shown beside the details. */
  pageTexts: { page: number; text: string }[];
  ms: number;
  proposal: FirProposal | null;
  brief: (Omit<ReturnType<typeof briefFromFir>, "vertical"> & { mo: MoDecision; vertical: { label: string; why: string } }) | null;
  found: ReturnType<typeof foundDetails> | null;
  steps: ReturnType<typeof firstStepsFromFir>;
}

/** The vertical as the brief shows it: the label and what decided it. */
export function verticalOfDecision(d: MoDecision): { label: string; why: string } {
  const v = MO_VERTICALS.find((x) => x.key === d.key)!;
  return { label: `${v.label}${d.subtype ? ` · ${d.subtype}` : ""}`, why: d.basis === "MODEL" ? `Classified by the local model: ${d.reason}` : d.reason };
}

export const TRANSCRIBE = "You transcribe scanned police documents. Write out all the text on the page exactly as it appears, line by line, in its original language. Do not summarise, translate, correct or add anything. Keep every number, date, amount, account number, phone number, UPI ID, email address and name exactly as printed. If a character cannot be read, write ? in its place.";
const TRANSLATE = (lang: string) =>
  `Translate the following ${lang} text from a police FIR into English, line by line, keeping the same line breaks. Keep every number, date, amount, account number, phone number, UPI ID, email address and identifier exactly as written. Write names in English letters. Output only the translation, nothing else.`;

/** JPEG page images embedded in a scanned PDF (DCTDecode streams), in order. */
export function pdfJpegs(pdf: Buffer, max = 12): Buffer[] {
  const out: Buffer[] = [];
  const s = pdf.toString("latin1");
  let from = 0;
  while (out.length < max) {
    const at = s.indexOf("/DCTDecode", from);
    if (at < 0) break;
    const streamAt = s.indexOf("stream", at);
    if (streamAt < 0) break;
    let start = streamAt + "stream".length;
    if (s[start] === "\r") start++;
    if (s[start] === "\n") start++;
    const end = s.indexOf("endstream", start);
    if (end < 0) break;
    const bytes = pdf.subarray(start, end);
    if (bytes[0] === 0xff && bytes[1] === 0xd8) out.push(bytes);
    from = end;
  }
  return out;
}

function linesFrom(text: string, page: number): SourceLine[] {
  return text
    .split(/\r?\n/)
    .map((t) => t.trimEnd())
    .filter((t) => t.trim())
    .map((t, i) => ({ page, line: i + 1, row: null, text: t }));
}

export async function readFirCopy(file: { name: string; buffer: Buffer }, onStep: (e: StepEvent) => void = () => {}): Promise<FirReading> {
  const started = Date.now();
  const { mimeType } = validateUpload(file.name, file.buffer);
  if (!["application/pdf", "text/plain", "image/png", "image/jpeg"].includes(mimeType)) {
    throw new AppError("An FIR copy can be read from a PDF, a scanned image (JPG or PNG) or a text file. Enter the details by hand, or choose another copy.", "VALIDATION", { file: "Choose a PDF, JPG, PNG or text copy." });
  }
  const base = { fileName: file.name, sizeBytes: file.buffer.length, mimeType };
  const failed = (note: string, pages: number | null, how: FirReading["how"] = "TEXT", language: FirReading["language"] = "English"): FirReading => {
    onStep({ key: "read", status: "failed", label: "Reading the copy", sub: note });
    return { ...base, pages, readable: false, note, how, language, modelUsed: null, modelText: null, pageTexts: [], ms: Date.now() - started, proposal: null, brief: null, found: null, steps: [] };
  };

  onStep({ key: "read", status: "start", label: "Reading the copy", sub: "Page by page" });
  const parsed = await parseDocument(file.buffer, mimeType);
  let lines: SourceLine[] = parsed.segments.map((s) => ({ page: s.page ?? null, line: s.line ?? null, row: s.row ?? null, text: s.text }));
  let how: FirReading["how"] = "TEXT";
  let modelUsed: string | null = null;
  let modelText: string | null = null;
  const pages = parsed.pageCount;

  // No text layer: transcribe the page images with the local model.
  if (parsed.status !== "TEXT_EXTRACTED" || lines.length === 0) {
    const images = mimeType === "application/pdf" ? pdfJpegs(file.buffer) : mimeType.startsWith("image/") ? [file.buffer] : [];
    if (!images.length) return failed("This copy has no text layer and no page images the reader can use. Upload a photo or scan of each page (JPG or PNG), or enter the details by hand.", pages);
    const status = await localModelStatus();
    if (!status.reachable || !status.hasModel) return failed(`This copy is a scan, and scans are read by the local model. ${status.note} Meanwhile, enter the details by hand.`, pages, "TRANSCRIBED");
    lines = [];
    const parts: string[] = [];
    for (const [i, img] of images.entries()) {
      onStep({ key: "read", status: "start", label: `Reading ${images.length} ${images.length === 1 ? "page" : "pages"}`, sub: `The local model is transcribing page ${i + 1} of ${images.length}` });
      const r = await localGenerate({ prompt: "Transcribe this page.", system: TRANSCRIBE, images: [img] });
      if (!r.ok) return failed(`${r.error} Enter the details by hand.`, pages, "TRANSCRIBED");
      modelUsed = r.model;
      lines.push(...linesFrom(r.text, i + 1));
      parts.push(`— Page ${i + 1} —\n${r.text}`);
    }
    how = "TRANSCRIBED";
    modelText = parts.join("\n\n");
  }

  // Telugu or Hindi: translate page by page so the rules can read it.
  const script = scriptOf(lines.map((l) => l.text).join(" "));
  const language: FirReading["language"] = script === "TELUGU" ? "Telugu" : script === "HINDI" ? "Hindi" : "English";
  if (script !== "LATIN") {
    const status = await localModelStatus();
    if (!status.reachable || !status.hasModel) return failed(`This copy is in ${language}. Translation is done by the local model. ${status.note} Meanwhile, enter the details by hand.`, pages, how, language);
    const byPage = new Map<number, SourceLine[]>();
    for (const l of lines) byPage.set(l.page ?? 1, [...(byPage.get(l.page ?? 1) ?? []), l]);
    const translated: SourceLine[] = [];
    const parts: string[] = [];
    for (const [page, pl] of byPage) {
      onStep({ key: "read", status: "start", label: `Reading ${byPage.size} ${byPage.size === 1 ? "page" : "pages"}`, sub: `${language} translated to English, page ${page} of ${byPage.size}` });
      const r = await localGenerate({ prompt: pl.map((l) => l.text).join("\n"), system: TRANSLATE(language) });
      if (!r.ok) return failed(`${r.error} Enter the details by hand.`, pages, how, language);
      modelUsed = r.model;
      translated.push(...linesFrom(r.text, page));
      parts.push(`— Page ${page} —\n${r.text}`);
    }
    lines = translated;
    how = "TRANSLATED";
    modelText = parts.join("\n\n");
  }
  const pagesRead = new Set(lines.map((l) => l.page)).size || 1;
  onStep({
    key: "read",
    status: "done",
    label: `Read ${pagesRead} ${pagesRead === 1 ? "page" : "pages"}`,
    sub: how === "TRANSLATED" ? `${language} translated to English by the local model` : how === "TRANSCRIBED" ? "Scanned pages transcribed by the local model" : "From the copy’s own text, page by page",
  });

  onStep({ key: "brief", status: "start", label: "Writing the brief", sub: "Who, what, when and how much, from what the FIR states" });
  const candidates: ExtractedCandidate[] = extractFromLines(lines);
  const proposal = proposeCaseFromFir(lines, candidates);
  // Pages with no text layer in a text PDF are scanned attachments: said plainly, never passed over in silence.
  if (proposal.form && pages && how === "TEXT") {
    const withText = new Set(lines.map((l) => l.page));
    proposal.form.pagesWithoutText = Array.from({ length: pages }, (_, i) => i + 1).filter((p) => !withText.has(p));
  }
  const briefed = briefFromFir(proposal, lines, candidates);
  onStep({ key: "brief", status: "done", label: "Wrote the brief", sub: briefed.headline });

  // The investigation vertical (MO table): as the FIR states it, or else decided by the local model from the brief.
  onStep({ key: "classify", status: "start", label: "Placing it in a vertical", sub: "From the station's MO table: as the FIR states it, or by the local model from the brief" });
  const mo = await decideMo({
    firText: lines.map((l) => l.text).join("\n"),
    facts: [briefed.headline, ...briefed.sentences.map((x) => x.text), proposal.fields.narrative ?? ""].filter(Boolean).join("\n"),
    sections: proposal.fields.legalSections ?? null,
  });
  const brief = { ...briefed, mo, vertical: verticalOfDecision(mo) };
  onStep({ key: "classify", status: "done", label: `Placed in ${brief.vertical.label}`, sub: brief.vertical.why });

  onStep({ key: "details", status: "start", label: "Pulling out the details", sub: "Names, numbers, accounts, payments and dates, with page references" });
  const found = foundDetails(proposal, candidates);
  onStep({ key: "details", status: "done", label: `Found ${found.total} details`, sub: `${found.read} read cleanly · ${found.check} to check` });

  onStep({ key: "plan", status: "start", label: "Planning the first steps", sub: "Statements and panchanama, then hold and record requests" });
  const steps = firstStepsFromFir(proposal, candidates);
  onStep({ key: "plan", status: "done", label: `Planned ${steps.length} first steps`, sub: "Nothing is drafted or sent until the case is open and you approve it" });

  const byPage = new Map<number, string[]>();
  for (const l of lines) byPage.set(l.page ?? 1, [...(byPage.get(l.page ?? 1) ?? []), l.text]);
  const pageTexts = [...byPage.entries()].sort((a, b) => a[0] - b[0]).map(([page, t]) => ({ page, text: t.join("\n") }));
  return { ...base, pages: pages ?? pagesRead, readable: true, note: null, how, language, modelUsed, modelText, pageTexts, ms: Date.now() - started, proposal, brief, found, steps };
}
