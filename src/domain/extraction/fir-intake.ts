import { formatInr } from "@/domain/money";
import { utcToIstInput } from "@/domain/time";
import type { ExtractedCandidate, SourceLine } from "./index";
import { moneyOf, readCctnsForm, type FirForm } from "./cctns-proposal";

/**
 * Reads an FIR copy before the case exists, to fill the New FIR form. Pure and rule-based: it only
 * transcribes what the FIR states (never infers sections, roles beyond the FIR's own labels, or how a
 * shared loss splits between victims). Identifiers and payments are listed for preview; they enter
 * the case only after the officer confirms them against the cited lines on the review screen.
 */
export interface FirProposal {
  fields: {
    firNumber?: string;
    firYear?: string;
    complaintRef?: string;
    reportedAt?: string;
    incidentStart?: string;
    incidentEnd?: string;
    narrative?: string;
    legalSections?: string;
  };
  parties: { name: string; role: "VICTIM" | "COMPLAINANT"; lossRupees?: string; source: string }[];
  found: { kind: string; value: string; note: string | null; source: string }[];
  payments: { when: string | null; amount: string; to: string | null; reference: string | null; source: string }[];
  totalLoss: string | null;
  /** Set when the copy is the CCTNS FIR form, read item by item. */
  form?: FirForm;
}

const IDENTIFIER_FIELDS = ["BANK_ACCOUNT", "UPI_ID", "PHONE", "EMAIL", "WEBSITE", "IP_ADDRESS", "PLATFORM_PROFILE"] as const;

export function sourceOf(c: { page: number | null; line: number | null; row?: number | null }): string {
  const parts = [c.page != null ? `p. ${c.page}` : null, c.line != null ? `line ${c.line}` : c.row != null ? `row ${c.row}` : null].filter(Boolean);
  return parts.join(", ") || "document";
}

const sameLine = (a: { page: number | null; line: number | null }, b: { page: number | null; line: number | null }) => a.page === b.page && a.line === b.line;
const nextLine = (a: { page: number | null; line: number | null }, b: { page: number | null; line: number | null }) => a.page === b.page && a.line != null && b.line === a.line + 1;
const isoOf = (c: ExtractedCandidate) => (typeof c.structured?.iso === "string" ? c.structured.iso : null);
const istInput = (c: ExtractedCandidate | undefined) => {
  const iso = c && isoOf(c);
  return iso ? utcToIstInput(new Date(iso)) : undefined;
};
const rupees = (c: ExtractedCandidate) => (typeof c.structured?.amountMinor === "string" ? formatInr(BigInt(c.structured.amountMinor)) : c.originalValue);

/** Text after "Label:" on the first line whose label matches. */
function labelled(lines: readonly SourceLine[], label: RegExp): { value: string; line: SourceLine } | null {
  for (const l of lines) {
    const m = label.exec(l.text);
    if (m) return { value: l.text.slice(m.index + m[0].length).trim(), line: l };
  }
  return null;
}

/** Lines repeated on two or more pages are page furniture (banners, running headers), not FIR content. */
function furniture(lines: readonly SourceLine[]): Set<string> {
  const pagesByText = new Map<string, Set<number | null>>();
  for (const l of lines) {
    const t = l.text.trim();
    if (!pagesByText.has(t)) pagesByText.set(t, new Set());
    pagesByText.get(t)!.add(l.page);
  }
  return new Set([...pagesByText].filter(([, pages]) => pages.size > 1).map(([t]) => t));
}

/** "DD-MM-YYYY" or "DD/MM/YYYY" → the ISO time of that IST midnight. */
const dayIso = (d: string | null) => {
  const m = d && /^(\d{2})[-/](\d{2})[-/](\d{4})$/.exec(d);
  return m ? new Date(`${m[3]}-${m[2]}-${m[1]}T00:00:00+05:30`).toISOString() : null;
};
const IDENTIFIER_KIND: Record<string, string> = { HANDLE: "PLATFORM_PROFILE", NCRP_ACK: "NCRP_ACK", BANK_SR: "BANK_SR" };

function proposalFromForm(fir: NonNullable<ReturnType<typeof readCctnsForm>>["fir"], form: FirForm): FirProposal {
  const fields: FirProposal["fields"] = {};
  if (fir.fir) {
    fields.firNumber = String(fir.fir.value.number);
    fields.firYear = String(fir.fir.value.year);
  }
  if (form.received) fields.reportedAt = form.received;
  if (fir.occurrenceFrom) fields.incidentStart = fir.occurrenceFrom.value;
  if (fir.occurrenceTo) fields.incidentEnd = fir.occurrenceTo.value;
  if (fir.sections) fields.legalSections = fir.sections.value;
  if (fir.narrative) fields.narrative = fir.narrative.text.slice(0, 20000);
  const ack = form.entities.find((e) => e.kind === "NCRP_ACK");
  if (ack) fields.complaintRef = ack.value;
  const money = moneyOf(form);
  const parties: FirProposal["parties"] = form.complainant.name
    ? [{ name: form.complainant.name, role: money.loss ? "VICTIM" : "COMPLAINANT", lossRupees: money.loss ? formatInr(money.loss).replace(/^₹/, "") : undefined, source: form.complainant.source }]
    : [];
  return {
    fields,
    parties,
    found: form.entities.filter((e) => e.role !== "COMPLAINANT").map((e) => ({ kind: IDENTIFIER_KIND[e.kind] ?? e.kind, value: e.value, note: e.basis, source: e.source })),
    // Where each payment went is left open unless the FIR's own sentence names the account: a complainant often
    // paid a different account each time ("a unique charge code" per deposit).
    payments: money.paid.map((a) => ({ when: dayIso(a.date), amount: formatInr(BigInt(a.minor)), to: null, reference: a.reference, source: a.source })),
    totalLoss: money.loss ? formatInr(money.loss) : null,
    form,
  };
}

export function proposeCaseFromFir(lines: readonly SourceLine[], candidates: readonly ExtractedCandidate[]): FirProposal {
  // The CCTNS FIR form is read item by item; other layouts by the labels below.
  const cctns = readCctnsForm(lines);
  if (cctns) return proposalFromForm(cctns.fir, cctns.form);
  const fields: FirProposal["fields"] = {};
  const of = (field: ExtractedCandidate["field"]) => candidates.filter((c) => c.field === field);
  const onLine = (line: SourceLine, field: ExtractedCandidate["field"]) => candidates.filter((c) => c.field === field && sameLine(c, line));

  const fir = of("FIR_REFERENCE")[0];
  if (fir?.structured && typeof fir.structured.number === "number" && typeof fir.structured.year === "number") {
    fields.firNumber = String(fir.structured.number);
    fields.firYear = String(fir.structured.year);
  }

  const registration = labelled(lines, /(?:date (?:and time )?of )?registration\s*:/i);
  if (registration) fields.reportedAt = istInput(onLine(registration.line, "DATE_TIME")[0]);

  const complaint = labelled(lines, /complaint reference\s*:/i);
  // NCRP acknowledgement numbers are 14 digits; demonstration references look like DEMO-NCRP-2026-000123.
  const ref = complaint && /\b(?:[A-Z][A-Z0-9]*(?:-[A-Z0-9]+){2,}|\d{14})\b/.exec(complaint.value);
  if (ref) fields.complaintRef = ref[0];

  const occurrence = labelled(lines, /(?:period|date(?: and time)?) of occurrence\s*:/i);
  if (occurrence) {
    const times = onLine(occurrence.line, "DATE_TIME");
    fields.incidentStart = istInput(times[0]);
    fields.incidentEnd = istInput(times[1]);
  }

  // Sections are transcribed only when the copy states them; a placeholder is left empty for the officer.
  const sections = labelled(lines, /(?:sections? of law|act\s*&\s*sections?|sections?)\s*:/i);
  if (sections && /\d/.test(sections.value) && !/not reproduced|as recorded by/i.test(sections.value)) fields.legalSections = sections.value.slice(0, 500);

  const skip = furniture(lines);
  const start = lines.findIndex((l) => /^\s*\d+\.\s*brief facts\b|^\s*brief facts\b|particulars of (?:the )?complaint/i.test(l.text));
  if (start >= 0) {
    const body: string[] = [];
    for (const l of lines.slice(start + 1)) {
      if (/^\s*\d+\.\s+\S/.test(l.text)) break;
      if (skip.has(l.text.trim()) || /\(continued\)/i.test(l.text)) continue;
      body.push(l.text.trim());
    }
    const narrative = body.join(" ").replace(/\s+/g, " ").trim();
    if (narrative) fields.narrative = narrative.slice(0, 20000);
  }

  for (const k of Object.keys(fields) as (keyof FirProposal["fields"])[]) if (fields[k] === undefined) delete fields[k];

  // Victims: the FIR's complainant, plus anyone it names as a further victim.
  const amounts = of("AMOUNT");
  const total = amounts.find((a) => /total/i.test(lines.find((l) => sameLine(l, a))?.text ?? ""));
  const names: { name: string; source: string }[] = of("PERSON_NAME")
    .filter((c) => /complainant|victim/i.test(c.roleHint ?? ""))
    .map((c) => ({ name: c.originalValue, source: sourceOf(c) }));
  for (const l of lines) {
    const m = /(?:second|another|other) victim\s*:\s*([^,;]+)/i.exec(l.text);
    if (m) names.push({ name: m[1]!.trim(), source: sourceOf(l) });
  }
  const unique = names.filter((n, i) => names.findIndex((x) => x.name === n.name) === i);
  const parties = unique.map((n) => ({
    name: n.name,
    role: "VICTIM" as const,
    // A single victim's loss is the FIR's total; how a shared total splits is for the officer to record.
    lossRupees: unique.length === 1 && total ? rupees(total).replace(/^₹/, "") : undefined,
    source: n.source,
  }));

  const seen = new Set<string>();
  const found: FirProposal["found"] = [];
  for (const c of candidates) {
    if (!(IDENTIFIER_FIELDS as readonly string[]).includes(c.field)) continue;
    const key = `${c.field}:${c.normalizedValue}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ kind: c.field, value: c.originalValue, note: c.roleHint, source: sourceOf(c) });
  }

  const payments: FirProposal["payments"] = [];
  for (const a of amounts.filter((x) => x !== total)) {
    const near = (field: ExtractedCandidate["field"]) => candidates.find((c) => c.field === field && (sameLine(c, a) || nextLine(a, c)));
    const when = near("DATE_TIME");
    const text = lines.find((l) => sameLine(l, a))?.text ?? "";
    const reference = near("TXN_REFERENCE")?.originalValue ?? null;
    let to = near("BANK_ACCOUNT")?.originalValue ?? near("UPI_ID")?.originalValue ?? null;
    // "paid … to the same account": the account of the payment stated just before.
    if (!to && /\bsame account\b/i.test(text)) to = payments.at(-1)?.to ?? null;
    // A receipt repeats a payment the FIR already states (same reference): keep one, filling what it lacked.
    const same = reference ? payments.find((p) => p.reference === reference) : undefined;
    if (same) {
      same.when ??= when ? (isoOf(when) ?? null) : null;
      same.to ??= to;
      continue;
    }
    payments.push({ when: when ? (isoOf(when) ?? null) : null, amount: rupees(a), to, reference, source: sourceOf(a) });
  }

  return { fields, parties, found, payments, totalLoss: total ? rupees(total) : null };
}
