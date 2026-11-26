import { describe, expect, it } from "vitest";
import { fir412Pdf } from "@/server/seed/documents";
import { makeTimeline } from "@/server/seed/timeline";
import { parseDocument } from "@/server/documents/parse";
import { extractFromLines, type SourceLine } from "@/domain/extraction";
import { proposeCaseFromFir } from "@/domain/extraction/fir-intake";

const T = makeTimeline("2026-11-09");

async function read(file: { buffer: Buffer }) {
  const parsed = await parseDocument(file.buffer, "application/pdf");
  const lines: SourceLine[] = parsed.segments.map((s) => ({ page: s.page ?? null, line: s.line ?? null, row: s.row ?? null, text: s.text }));
  return proposeCaseFromFir(lines, extractFromLines(lines));
}

describe("proposeCaseFromFir (FIR 412/2026)", () => {
  it("fills the case fields recorded on the FIR, in IST, including the NCRP acknowledgement number and sections", async () => {
    const p = await read(fir412Pdf(T));
    expect(p.fields).toMatchObject({
      firNumber: "412",
      firYear: "2026",
      complaintRef: "33710260048816",
      reportedAt: "2026-11-02T11:40",
      incidentStart: "2026-10-28T21:14",
      incidentEnd: "2026-11-02T10:42",
      legalSections: "BNS 318(4), IT Act 66D",
    });
    expect(p.fields.narrative).toMatch(/^On 25-10-2026 the complainant received a match on a dating application from a profile named "Anvi_K"\./);
  });

  it("lists both victims but leaves the split of the shared total to the officer", async () => {
    const p = await read(fir412Pdf(T));
    expect(p.parties.map((x) => x.name)).toEqual(["Victim 1", "Victim 2 (synthetic)"]);
    expect(p.parties.every((x) => x.lossRupees === undefined)).toBe(true);
    expect(p.totalLoss).toBe("₹1,00,000");
  });

  it("lists each payment once, even where a receipt repeats it, carrying the account into 'the same account'", async () => {
    const p = await read(fir412Pdf(T));
    expect(p.payments).toHaveLength(2);
    expect(p.payments[0]).toMatchObject({ amount: "₹60,000", to: "XXXXXXXXXXXX4471", reference: "630184620214", source: "p. 2, line 13" });
    expect(p.payments[1]).toMatchObject({ amount: "₹40,000", to: "XXXXXXXXXXXX4471", reference: "63018462?8?7" });
  });

  it("previews every identifier once", async () => {
    const p = await read(fir412Pdf(T));
    const values = p.found.map((f) => f.value);
    expect(values).toEqual(expect.arrayContaining(["+91-XXXXXXXX87", "anvi.k.statements@example.invalid", "XXXXXXXXXXXX4471", "p1.trade@okbnka", "+91-XXXXXXXX19"]));
    expect(new Set(values).size).toBe(values.length);
  });

  it("never fills legal sections the copy does not state", async () => {
    const p = await read(fir412Pdf(T));
    expect(p.fields.legalSections).toBe("BNS 318(4), IT Act 66D");
  });
});
