/**
 * Minimal text-PDF writer used to generate the synthetic demonstration documents and test
 * fixtures. It produces real PDFs with a text layer (Helvetica, WinAnsi), so the same
 * parsing pipeline that handles uploads is exercised on seeded documents.
 */

export interface PdfLine {
  text: string;
  size?: number;
  bold?: boolean;
  gapBefore?: number;
}

export interface PdfPage {
  lines?: PdfLine[];
  /** Draw a filled grey box instead of text — simulates an image-only (scanned) page. */
  imageOnly?: boolean;
}

export interface PdfOptions {
  title?: string;
  /** Names what produced the file (shown in the PDF properties). */
  producer?: string;
  /** Test-only: adds a Standard security handler with an unknown password. */
  fakeEncryption?: boolean;
}

function toWinAnsi(text: string): string {
  return text
    .replace(/₹/g, "Rs.")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/[^\x20-\x7e]/g, "?");
}

function escapePdf(text: string): string {
  return toWinAnsi(text).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

export function buildPdf(pages: PdfPage[], options: PdfOptions = {}): Buffer {
  const objects: string[] = [];
  const add = (body: string) => {
    objects.push(body);
    return objects.length; // object number
  };

  const catalogNo = add("<< /Type /Catalog /Pages 2 0 R >>");
  add("PAGES_PLACEHOLDER");
  const fontRegular = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const fontBold = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  const infoNo = add(`<< /Title (${escapePdf(options.title ?? "Synthetic document")}) /Producer (${escapePdf(options.producer ?? "T-CYBER synthetic fixture generator")}) >>`);

  const pageNos: number[] = [];
  for (const page of pages) {
    let stream = "";
    if (page.imageOnly) {
      stream = "q 0.82 g 56 300 483 420 re f Q\n";
    } else {
      let y = 790;
      for (const line of page.lines ?? []) {
        const size = line.size ?? 10;
        y -= (line.gapBefore ?? 0) + size * 1.5;
        if (line.text.trim() === "") continue;
        stream += `BT /${line.bold ? "F2" : "F1"} ${size} Tf 56 ${y.toFixed(1)} Td (${escapePdf(line.text)}) Tj ET\n`;
      }
    }
    const contentNo = add(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}endstream`);
    const pageNo = add(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontRegular} 0 R /F2 ${fontBold} 0 R >> >> /Contents ${contentNo} 0 R >>`,
    );
    pageNos.push(pageNo);
  }
  objects[1] = `<< /Type /Pages /Kids [${pageNos.map((n) => `${n} 0 R`).join(" ")}] /Count ${pageNos.length} >>`;

  let encryptNo: number | null = null;
  if (options.fakeEncryption) {
    const hex32 = "8e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b".repeat(2);
    encryptNo = add(`<< /Filter /Standard /V 1 /R 2 /O <${hex32}> /U <${hex32}> /P -44 >>`);
  }

  let out = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${off.toString().padStart(10, "0")} 00000 n \n`;
  const id = "<0123456789abcdef0123456789abcdef>";
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogNo} 0 R /Info ${infoNo} 0 R /ID [${id} ${id}]${
    encryptNo ? ` /Encrypt ${encryptNo} 0 R` : ""
  } >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
