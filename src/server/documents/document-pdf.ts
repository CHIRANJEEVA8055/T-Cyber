/**
 * A printable document as a PDF (A4, Helvetica): paragraphs wrapped to the page width, centred or right-aligned
 * lines, page breaks with page numbers, and an optional diagonal mark ("DRAFT") on every page. Used for request
 * letters and FIR copies the officer prints. Text is written as text (it can be searched and read back); characters
 * outside the PDF's standard Latin set are shown as "?", so the Word copy is the one to use for other scripts.
 */

export interface DocLine {
  text: string;
  align?: "left" | "center" | "right";
  bold?: boolean;
  size?: number;
  /** Extra space before the paragraph, in points. */
  gapBefore?: number;
  /** Left indent, in points. */
  indent?: number;
  /** Keep the line as it is (no wrapping): a heading row or a short label. */
  nowrap?: boolean;
}

export interface DocOptions {
  title: string;
  producer?: string;
  /** A light diagonal word printed across every page ("DRAFT"). */
  watermark?: string | null;
  /** Small text at the foot of every page, before the page number. */
  footer?: string;
}

// Helvetica and Helvetica-Bold advance widths (per 1000 units) for the printable ASCII characters 32–126.
const W_REG = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const W_BOLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];

/** Text in the PDF's standard Latin encoding: rupee sign as "Rs.", curly quotes straight, anything else "?". */
export function toPdfText(text: string): string {
  return text
    .replace(/₹\s?/g, "Rs. ")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/[•·]/g, "-")
    .replace(/→/g, "->")
    .replace(/\t/g, "    ")
    .replace(/[^\x20-\x7e]/g, "?");
}
const esc = (t: string) => t.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

export function textWidth(text: string, size: number, bold = false): number {
  const w = bold ? W_BOLD : W_REG;
  let sum = 0;
  for (const ch of text) {
    const c = ch.charCodeAt(0);
    sum += c >= 32 && c <= 126 ? w[c - 32]! : 556;
  }
  return (sum * size) / 1000;
}

/** Splits a paragraph into lines no wider than `width` points (a word longer than a line is broken). */
export function wrap(text: string, width: number, size: number, bold = false): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    const words = para.split(/(\s+)/).filter((w) => w !== "");
    let line = "";
    for (const w of words) {
      const next = line + w;
      if (textWidth(next.trimEnd(), size, bold) <= width || !line.trim()) {
        if (textWidth(next.trimEnd(), size, bold) > width && !line.trim()) {
          // A single word wider than the line: break it by characters.
          let part = "";
          for (const ch of w) {
            if (textWidth(part + ch, size, bold) > width) {
              out.push(part);
              part = "";
            }
            part += ch;
          }
          line = part;
        } else line = next;
      } else {
        out.push(line.trimEnd());
        line = /^\s+$/.test(w) ? "" : w;
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}

const PAGE_W = 595;
const PAGE_H = 842;
const MARGIN_X = 64;
const TOP = 790;
const BOTTOM = 64;

export function buildDocumentPdf(lines: DocLine[], opts: DocOptions): Buffer {
  const usable = PAGE_W - MARGIN_X * 2;
  type Placed = { x: number; y: number; text: string; size: number; bold: boolean };
  const pages: Placed[][] = [[]];
  let y = TOP;
  const newPage = () => {
    pages.push([]);
    y = TOP;
  };
  for (const l of lines) {
    const size = l.size ?? 11;
    const bold = !!l.bold;
    const indent = l.indent ?? 0;
    const text = toPdfText(l.text);
    const rows = l.nowrap ? [text] : wrap(text, usable - indent, size, bold);
    y -= l.gapBefore ?? 0;
    for (const row of rows) {
      const lead = size * 1.45;
      if (y - lead < BOTTOM) newPage();
      y -= lead;
      if (!row.trim()) continue;
      const w = textWidth(row, size, bold);
      const x = l.align === "center" ? (PAGE_W - w) / 2 : l.align === "right" ? PAGE_W - MARGIN_X - w : MARGIN_X + indent;
      pages.at(-1)!.push({ x, y, text: row, size, bold });
    }
  }

  const objects: string[] = [];
  const add = (body: string) => objects.push(body);
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add("PAGES");
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  add(`<< /Title (${esc(toPdfText(opts.title))}) /Producer (${esc(toPdfText(opts.producer ?? "T-CYBER"))}) >>`);
  const kids: number[] = [];
  pages.forEach((placed, i) => {
    let s = "";
    if (opts.watermark) {
      // A light grey word across the page, under the text.
      const wm = esc(toPdfText(opts.watermark));
      s += `q 0.88 g BT /F2 96 Tf 0.7071 0.7071 -0.7071 0.7071 150 230 Tm (${wm}) Tj ET Q\n`;
    }
    for (const p of placed) s += `BT /${p.bold ? "F2" : "F1"} ${p.size} Tf ${p.x.toFixed(1)} ${p.y.toFixed(1)} Td (${esc(p.text)}) Tj ET\n`;
    const foot = `${opts.footer ? `${toPdfText(opts.footer)}  ·  ` : ""}Page ${i + 1} of ${pages.length}`.replace(/·/g, "-");
    s += `BT /F1 8 Tf ${(PAGE_W - textWidth(foot, 8)) / 2} 36 Td (${esc(foot)}) Tj ET\n`;
    add(`<< /Length ${Buffer.byteLength(s, "latin1")} >>\nstream\n${s}endstream`);
    const contentNo = objects.length;
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentNo} 0 R >>`);
    kids.push(objects.length);
  });
  objects[1] = `<< /Type /Pages /Kids [${kids.map((n) => `${n} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  let out = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${o.toString().padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
