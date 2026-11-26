import { describe, expect, it } from "vitest";
import { fir412Pdf } from "@/server/seed/documents";
import { makeTimeline } from "@/server/seed/timeline";
import { parseDocument } from "@/server/documents/parse";
import { extractFromLines, type SourceLine } from "@/domain/extraction";
import { proposeCaseFromFir } from "@/domain/extraction/fir-intake";
import { briefFromFir, detectKind, firstStepsFromFir, foundDetails, scriptOf } from "@/domain/extraction/fir-brief";

const T = makeTimeline("2026-11-09");

async function read() {
  const parsed = await parseDocument(fir412Pdf(T).buffer, "application/pdf");
  const lines: SourceLine[] = parsed.segments.map((s) => ({ page: s.page ?? null, line: s.line ?? null, row: s.row ?? null, text: s.text }));
  const candidates = extractFromLines(lines);
  return { lines, candidates, proposal: proposeCaseFromFir(lines, candidates) };
}

describe("reading an FIR into a brief, by rules", () => {
  it("names the kind of fraud from the FIR's own words", async () => {
    const { lines } = await read();
    expect(detectKind(lines.map((l) => l.text).join(" "))).toMatchObject({ key: "INVESTMENT", label: "Investment-app fraud" });
    expect(detectKind("The caller asked for the OTP sent to her phone")).toMatchObject({ key: "OTP" });
    expect(detectKind("He was asked to pay a registration fee for a part-time job")).toMatchObject({ key: "JOB" });
    // The form's printed words are not an investment: "Investigating Officer", "investigation".
    expect(detectKind("Investigating Officer: SI. Took up investigation. The caller asked for the OTP.")).toMatchObject({ key: "OTP" });
  });

  it("writes a short brief from what the FIR states, each sentence citing its page", async () => {
    const r = await read();
    const b = briefFromFir(r.proposal, r.lines, r.candidates);
    expect(b.headline).toBe("Investment-app fraud with two victims.");
    expect(b.sentences.map((s) => s.text).join(" ")).toContain("On 02 Nov 2026 Victim 1 paid ₹60,000 by UPI to Account XXXXXXXXXXXX4471 at Bank A.");
    expect(b.sentences.map((s) => s.text).join(" ")).toContain("Victim 2 paid ₹40,000 by UPI to the same account");
    expect(b.sentences.every((s) => s.source)).toBe(true);
    expect(b.tags).toEqual(["Investment-app fraud", "2 victims", "₹1,00,000 lost"]);
    expect(b.sections).toEqual({ text: "BNS 318(4), IT Act 66D", stated: true });
  });

  it("shows no sections when the FIR does not state them, and never proposes any", async () => {
    const r = await read();
    const b = briefFromFir({ ...r.proposal, fields: { ...r.proposal.fields, legalSections: undefined } }, r.lines, r.candidates);
    // Sections come only from the FIR: none stated, none shown (T-CYBER never proposes sections).
    expect(b.sections).toEqual({ text: null, stated: false });
  });

  it("lists the details found, marking what needs checking", async () => {
    const r = await read();
    const d = foundDetails(r.proposal, r.candidates);
    expect(d.total).toBeGreaterThan(10);
    const uncertain = d.items.find((i) => i.title.includes("63018462?8?7"))!;
    expect(uncertain).toMatchObject({ status: "CHECK", sub: expect.stringContaining("2 characters") });
    expect(d.items.find((i) => i.title.startsWith("Account XXXXXXXXXXXX4471"))).toMatchObject({ status: "READ" });
  });

  it("plans the first steps: statement and panchanama, then the requests the rules will draft once the details are confirmed", async () => {
    const r = await read();
    const steps = firstStepsFromFir(r.proposal, r.candidates);
    expect(steps.map((s) => s.title)).toEqual([
      "Record the complainants’ detailed statements",
      "Visit the scene of offence and conduct the panchanama",
      "Hold request to Bank A on XXXXXXXXXXXX4471",
      "Statement and KYC for XXXXXXXXXXXX4471",
      "NPCI trace for the UPI payments",
      "CDR and CAF for +91-XXXXXXXX87",
      "Preservation of “Anvi_K” and the email address",
    ]);
    expect(steps[0]!.sub).toContain("clearer receipt for ref 63018462?8?7");
    expect(steps[4]!.sub).toContain("held back");
    expect(steps.slice(2).every((s) => s.request)).toBe(true);
  });

  it("tells Telugu text from English", () => {
    expect(scriptOf("ఫిర్యాదుదారు 02-11-2026న రూ. 60,000 చెల్లించారు")).toBe("TELUGU");
    expect(scriptOf("The complainant paid Rs. 60,000")).toBe("LATIN");
  });
});
