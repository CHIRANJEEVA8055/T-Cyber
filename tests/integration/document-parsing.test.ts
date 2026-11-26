import { describe, expect, it } from "vitest";
import { buildPdf } from "@/server/documents/pdf-writer";
import { buildZip } from "@/server/documents/zip";
import { parseDocument } from "@/server/documents/parse";

describe("parseDocument", () => {
  it("extracts text from a PDF text layer with page and line numbers", async () => {
    const pdf = buildPdf([
      { lines: [{ text: "FIRST INFORMATION REPORT (SYNTHETIC)", bold: true }, { text: "FIR No. 1/2026" }] },
      { lines: [{ text: "Beneficiary A/c No. XXXXXXXX4821" }] },
    ]);
    const parsed = await parseDocument(pdf, "application/pdf");
    expect(parsed.status).toBe("TEXT_EXTRACTED");
    expect(parsed.pageCount).toBe(2);
    expect(parsed.segments).toContainEqual(
      expect.objectContaining({ page: 1, line: 2, text: "FIR No. 1/2026", method: "PDF_TEXT_LAYER" }),
    );
    expect(parsed.segments).toContainEqual(expect.objectContaining({ page: 2, line: 1, text: "Beneficiary A/c No. XXXXXXXX4821" }));
  });

  it("reports an image-only PDF honestly instead of fabricating text", async () => {
    const parsed = await parseDocument(buildPdf([{ imageOnly: true }]), "application/pdf");
    expect(parsed.status).toBe("NO_TEXT_LAYER");
    expect(parsed.segments).toEqual([]);
    expect(parsed.note).toMatch(/OCR/);
  });

  it("reports an encrypted PDF as encrypted", async () => {
    const parsed = await parseDocument(buildPdf([{ lines: [{ text: "secret" }] }], { fakeEncryption: true }), "application/pdf");
    expect(parsed.status).toBe("ENCRYPTED");
    expect(parsed.segments).toEqual([]);
  });

  it("reports a corrupt PDF as failed", async () => {
    const parsed = await parseDocument(Buffer.from("%PDF-1.4 this is not really a pdf"), "application/pdf");
    expect(parsed.status).toBe("FAILED");
  });

  it("parses CSV into rows numbered as in the source file", async () => {
    const parsed = await parseDocument(Buffer.from("Date,Amount\n03-10-2026,\"10,00,000\"\n"), "text/csv");
    expect(parsed.status).toBe("TABLE_PARSED");
    expect(parsed.table).toEqual([
      ["Date", "Amount"],
      ["03-10-2026", "10,00,000"],
    ]);
    expect(parsed.segments[1]).toMatchObject({ row: 2, method: "CSV_ROW" });
  });

  it("splits plain text and email files into numbered lines", async () => {
    const parsed = await parseDocument(Buffer.from("From: a@example.invalid\r\nSubject: Test\r\n\r\nBody line"), "message/rfc822");
    expect(parsed.status).toBe("TEXT_EXTRACTED");
    expect(parsed.segments.map((s) => s.line)).toEqual([1, 2, 4]);
  });

  it("stores images without pretending to extract them", async () => {
    const png = await parseDocument(Buffer.from([0x89, 0x50, 0x4e, 0x47]), "image/png");
    expect(png.status).toBe("UNSUPPORTED");
    expect(png.note).toMatch(/OCR/);
  });

  it("reads a Word reply's text, and says plainly when the file cannot be opened", async () => {
    const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    const doc = buildZip([{ name: "word/document.xml", data: Buffer.from('<w:document><w:body><w:p><w:r><w:t>Lien marked: Rs. 50,000.00</w:t></w:r></w:p><w:p><w:r><w:t>Account holder name: R. Example</w:t></w:r></w:p></w:body></w:document>'), modified: new Date() }]);
    const parsed = await parseDocument(doc, DOCX);
    expect(parsed.status).toBe("TEXT_EXTRACTED");
    expect(parsed.segments.map((x) => x.text)).toContain("Account holder name: R. Example");
    const broken = await parseDocument(Buffer.from("PK.."), DOCX);
    expect(broken.status).toBe("FAILED");
    expect(broken.note).toMatch(/could not be opened/);
  });
});
