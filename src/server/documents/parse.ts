import { readXlsx } from "./xlsx";
import { readDocxBlocks } from "./docx-read";
import { parseCsv } from "@/domain/extraction";
import { repairPdfText } from "./pdf-fonts";

/**
 * Converts stored originals into reviewable text segments. Supported: PDF text layers,
 * plain text, email (.eml) and CSV. Everything else is stored but reported as unsupported.
 * There is no OCR in this build; image-only PDFs are reported as such, never guessed.
 */

export type ParseStatus = "TEXT_EXTRACTED" | "TABLE_PARSED" | "NO_TEXT_LAYER" | "ENCRYPTED" | "UNSUPPORTED" | "FAILED";

export interface ParsedSegment {
  page: number | null;
  line: number | null;
  row: number | null;
  text: string;
  method: "PDF_TEXT_LAYER" | "PLAIN_TEXT" | "CSV_ROW" | "EMAIL_BODY";
}

export interface ParsedDocument {
  status: ParseStatus;
  note: string | null;
  pageCount: number | null;
  segments: ParsedSegment[];
  table: string[][] | null;
}

const NOTES = {
  noTextLayer:
    "No text layer was found. This looks like a scanned or image-only PDF. Text recognition (OCR) is not available in this build, so nothing was extracted. Review the original and add facts manually.",
  encrypted:
    "The PDF is password-protected. Nothing was extracted. Obtain an unprotected copy from the sender, or review the original manually.",
  image:
    "Images are stored as originals. Text recognition (OCR) is not available in this build, so nothing was extracted. Add facts manually during review.",
  office:
    "Word and Excel files are stored as originals but are not parsed in this build. Ask for a text PDF or CSV export, or review the original manually.",
};

function splitLines(text: string, method: ParsedSegment["method"]): ParsedSegment[] {
  return text
    .split(/\r\n|\n|\r/)
    .map((t, i) => ({ page: null, line: i + 1, row: null, text: t.replace(/\s+$/, ""), method }))
    .filter((s) => s.text.trim() !== "");
}

interface PdfTextItem {
  str: string;
  transform: number[];
  width: number;
}

async function parsePdf(original: Buffer): Promise<ParsedDocument> {
  const { getDocumentProxy } = await import("unpdf");
  // Copies printed to PDF from a browser can leave digits and ligatures out of the text layer; they are recovered
  // from the glyph shapes first (see pdf-fonts.ts). The stored original is never changed.
  let buffer = original;
  let recovered = 0;
  try {
    const r = repairPdfText(original);
    if (r.pdf) {
      buffer = r.pdf;
      recovered = r.report.repaired.length;
    }
  } catch {
    buffer = original;
  }
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    pdf = await getDocumentProxy(new Uint8Array(buffer));
  } catch (err) {
    const name = (err as { name?: string })?.name ?? "";
    if (name === "PasswordException") {
      return { status: "ENCRYPTED", note: NOTES.encrypted, pageCount: null, segments: [], table: null };
    }
    return {
      status: "FAILED",
      note: "The PDF could not be opened. It may be damaged. Ask the sender for a fresh copy, or review the original manually.",
      pageCount: null,
      segments: [],
      table: null,
    };
  }

  const segments: ParsedSegment[] = [];
  let characters = 0;
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const items = (content.items as unknown[]).filter((i): i is PdfTextItem => typeof (i as PdfTextItem).str === "string");
    // Group text runs into lines by baseline, then order left to right.
    const lines = new Map<number, PdfTextItem[]>();
    for (const item of items) {
      if (item.str.trim() === "") continue;
      const y = Math.round((item.transform[5] ?? 0) * 2) / 2;
      const key = [...lines.keys()].find((k) => Math.abs(k - y) < 2) ?? y;
      lines.set(key, [...(lines.get(key) ?? []), item]);
    }
    const ordered = [...lines.entries()].sort(([a], [b]) => b - a);
    ordered.forEach(([, runs], index) => {
      runs.sort((a, b) => (a.transform[4] ?? 0) - (b.transform[4] ?? 0));
      let text = "";
      let lastEnd: number | null = null;
      for (const run of runs) {
        const x = run.transform[4] ?? 0;
        if (lastEnd !== null && x - lastEnd > 1.5 && !text.endsWith(" ")) text += " ";
        text += run.str;
        lastEnd = x + run.width;
      }
      characters += text.trim().length;
      segments.push({ page: p, line: index + 1, row: null, text: text.trim(), method: "PDF_TEXT_LAYER" });
    });
  }
  const pageCount = pdf.numPages;
  await (pdf as { destroy?: () => Promise<void> }).destroy?.();
  if (characters < 10) {
    return { status: "NO_TEXT_LAYER", note: NOTES.noTextLayer, pageCount, segments: [], table: null };
  }
  return { status: "TEXT_EXTRACTED", note: recovered ? `The PDF's text layer left out ${recovered} character ${recovered === 1 ? "shape" : "shapes"} (digits and letter pairs); they were read from the glyph shapes in the file.` : null, pageCount, segments, table: null };
}

export async function parseDocument(buffer: Buffer, mimeType: string): Promise<ParsedDocument> {
  switch (mimeType) {
    case "application/pdf":
      return parsePdf(buffer);
    case "text/plain":
      return { status: "TEXT_EXTRACTED", note: null, pageCount: null, segments: splitLines(buffer.toString("utf8"), "PLAIN_TEXT"), table: null };
    case "message/rfc822":
      return { status: "TEXT_EXTRACTED", note: null, pageCount: null, segments: splitLines(buffer.toString("utf8"), "EMAIL_BODY"), table: null };
    case "text/csv": {
      const table = parseCsv(buffer.toString("utf8"));
      const segments = table.map((cells, i) => ({
        page: null,
        line: null,
        row: i + 1,
        text: cells.join(" | "),
        method: "CSV_ROW" as const,
      }));
      return { status: "TABLE_PARSED", note: null, pageCount: null, segments, table };
    }
    case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": {
      // A bank's statement in Excel: the sheet that looks most like a table of transactions is read.
      let sheets: ReturnType<typeof readXlsx>;
      try {
        sheets = readXlsx(buffer);
      } catch {
        return { status: "FAILED", note: "The workbook could not be opened. Ask for the statement again, or save it as CSV and upload that.", pageCount: null, segments: [], table: null };
      }
      const score = (rows: string[][]) => rows.filter((r) => r.filter((c) => c.trim()).length >= 3).length;
      const best = [...sheets].sort((a, b) => score(b.rows) - score(a.rows))[0];
      if (!best || !best.rows.length) return { status: "FAILED", note: "The workbook has no rows to read.", pageCount: null, segments: [], table: null };
      const table = best.rows.map((r) => r.map((c) => c.trim()));
      const segments = table.map((cells, i) => ({ page: null, line: null, row: i + 1, text: cells.join(" | "), method: "CSV_ROW" as const }));
      return { status: "TABLE_PARSED", note: sheets.length > 1 ? `Read the sheet "${best.name}" (${sheets.length} sheets in the workbook).` : null, pageCount: null, segments, table };
    }
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document": {
      try {
        const blocks = readDocxBlocks(buffer);
        return { status: "TEXT_EXTRACTED", note: null, pageCount: null, segments: splitLines(blocks.map((b) => b.text).join("\n"), "PLAIN_TEXT"), table: null };
      } catch {
        return { status: "FAILED", note: "The Word document could not be opened. Ask for it again or as a PDF.", pageCount: null, segments: [], table: null };
      }
    }
    case "image/png":
    case "image/jpeg":
      return { status: "UNSUPPORTED", note: NOTES.image, pageCount: null, segments: [], table: null };
    default:
      return { status: "UNSUPPORTED", note: NOTES.office, pageCount: null, segments: [], table: null };
  }
}
