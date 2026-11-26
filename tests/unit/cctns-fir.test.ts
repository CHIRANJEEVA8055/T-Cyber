import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { SourceLine } from "@/domain/extraction";
import { extractFromLines } from "@/domain/extraction";
import { parseCctnsFir, parseActs } from "@/domain/extraction/cctns";
import { firAmounts, firEntities, fraudKind } from "@/domain/extraction/fir-entities";
import { proposeCaseFromFir } from "@/domain/extraction/fir-intake";
import { briefFromFir, firstStepsFromFir, foundDetails } from "@/domain/extraction/fir-brief";

/** A synthetic FIR in the CCTNS print layout (labels, wrapped columns and wrapped values as the real form has them). */
const PAGES: string[][] = [
  [
    "9001-2026 - FIR",
    "FIRST INFORMATION REPORT",
    "(Under section 173 and 176 BNSS)",
    "1. District Cyberabad P.S. Cyber Crimes Year 2026 FIR No. 9001/2026 Date 02-11-2026",
    "PS",
    "Cyberabad(Cy",
    "berabad)",
    "2. Acts & Section(s): 318(4),319(2),r/w 3(5) BNS, 66-D ITA-2000-2008,",
    "3. a) Occurrence of Offence: Day Monday Date & Time From",
    "Date & Time To Prior To 01-11-2026 18:20:05 Time Period",
    "b) Information Received at P.S.: Date & Time 02-11-2026 11:00",
    "General Diary Reference: Entry No 09 Date & Time 02-11-2026 11:00",
    "4. Type of Information: Written",
    "5. Place of Occurrence:",
    "a) Distance and Direction From P.S.: 06 KM, North Beat No.",
    "b) Address Place Flat 4B, Example Towers, Kondapur",
    "Area/Mandal Street/Village",
    "City/District Cyberabad State Telangana PIN",
    "6. Complainant / Informant:",
    "a) Name Test Kumar",
    "b) Father's /Husband's Name Demo Rao",
    "c) Date/Year of Birth Age 41 Years",
    "d) Nationality India e) Caste",
    "g) Occupation Mobile No. 9000000001",
    "Flat 4B,",
    "Example",
    "Towers,",
    "h) Address House No Kondapur Area/Mandal Serilingampally Street/Village",
    "City/District RANGA REDDY State TELANGANA PIN",
    "7. Details of known/suspected/unknown accused with full particulars:",
  ],
  [
    "Serial No : 1",
    "a) Name domain https://www.example-trade.cc/app/, the Telegram user @DemoMentor, and the WhatsApp user +44 7700",
    "900123",
    "b) Father's /Husband's Name",
    "c) Occupation d) Caste e) Gender Male",
    "Physical features, deformities and other details of the Suspect:",
    "8. Reasons for delay in reporting by the complainant / informant:",
    "After coming to know about the commission of offense, complaint filed",
    "9. Particulars of properties stolen/involved (Attach separate sheet, if necessary):",
    "The complainant was lost an amount of Rs. 2,90,000/-",
    "10. Total value of property stolen: 290000",
    "11. Inquest Report/ U.D. Case",
    "12. Contents of the complaint / statement of the complainant or informant:",
    "IN THE COURT OF HONOURABLE ADDL.JUDICIAL MAGISTRATE OF FIRST-CLASS",
    "Honoured Sir,",
    "Brief facts of the case are that on 02-11-2026 at 1100 hours received a complaint from Test Kumar, S/o Demo Rao,",
    "aged 41 years, residing at Flat 4B, Example Towers, Kondapur, Hyderabad – 500084, whose mobile number is 9000000001",
    "and email ID is test.kumar@example.invalid, submitted that while browsing Instagram he found an advertisement for",
    "a part-time job doing tasks; he was asked to buy tasks on https://www.example-trade.cc/app/#/register and",
    "initially he paid Rs. 500/- to recharge; then he added Rs. 1,00,000/- on 25-10-2026, Rs. 1,50,000/- on 26/10/2026",
    "(reference 512345678901) and Rs. 50,000/- on 27/10/2026 to account number 31234567890 from his own HDFC bank",
    "account; the app showed a virtual profit of Rs. 9,00,000/- and they asked him to pay a further Rs. 2,00,000/- as",
    "tax; he transferred a total of Rs. 3,00,500/- while they returned only Rs. 10,500/-; he therefore requested",
    "action against the WhatsApp user +44 7700 900123 for a wrongful loss of Rs. 2,90,000/-.",
    "Hence the FIR.",
    "(ORIGINAL COMPLAINT ENCLOSED HERE WITH)",
    "As per the above Content, I. A. Example, SI of Police, registered a case in Cr. No. 9001/2026, U/Sec",
    "318(4),319(2), r/w 3(5) BNS and Sec 66-D of IT Act 2000-2008 and case file handed over to Sri. B. Sample,",
    "Inspector of Police, CCPS, Cyberabad for investigation.",
    "13. Action taken:",
    "1) Registered the case and took up the investigation or Name BALA",
    "SAMPLE",
    "2) Directed to take up the Investigation or Rank: Inspector No. 4242",
    "14. Signature / Thumb impression of the complainant / Signature of Officer in charge, Police",
    "Name ANIL EXAMPLE",
    "Rank SI No 10001",
  ],
];
const lines: SourceLine[] = PAGES.flatMap((p, i) => p.map((text, j) => ({ page: i + 1, line: j + 1, row: null, text })));

describe("reading the CCTNS FIR form", () => {
  it("reads items 1 to 14, joining the columns and values the form wraps", () => {
    const f = parseCctnsFir(lines)!;
    expect(f.fir?.value).toEqual({ number: 9001, year: 2026 });
    expect(f.policeStation?.value).toBe("Cyber Crimes PS Cyberabad(Cyberabad)");
    expect(f.sections?.value).toBe("BNS 318(4), 319(2) r/w 3(5); IT Act 66-D");
    expect(f.occurrencePriorTo).toBe(true);
    expect(f.occurrenceTo?.value).toBe("2026-11-01T18:20");
    expect(f.received?.value).toBe("2026-11-02T11:00");
    expect(f.gdEntry?.value).toBe("09");
    expect(f.complainant).toMatchObject({ name: { value: "Test Kumar" }, relative: { value: "Demo Rao" }, age: { value: 41 }, mobile: { value: "9000000001" } });
    expect(f.accused[0]!.text.value).toContain("+44 7700 900123");
    expect(f.totalValue?.value.minor).toBe(29000000n);
    expect(f.narrative?.text.startsWith("Brief facts")).toBe(true);
    expect(f.narrative?.text).toContain("https://www.example-trade.cc/app/#/register");
    expect(f.registeredBy).toMatchObject({ name: "A. Example", rank: "SI of Police" });
    expect(f.investigatingOfficer).toMatchObject({ name: "BALA SAMPLE", rank: "Inspector", number: "4242", unit: "CCPS, Cyberabad" });
    expect(f.officerInCharge).toMatchObject({ name: "ANIL EXAMPLE", rank: "SI", number: "10001" });
  });

  it("reads the acts and their sections in order", () => {
    expect(parseActs("318(4),319(2),336(3),338,340(2),r/w 3(5) BNS, 66-D ITA-2000-2008,")).toEqual([
      { act: "BNS", sections: ["318(4)", "319(2)", "336(3)", "338", "340(2)", "r/w 3(5)"] },
      { act: "IT Act", sections: ["66-D"] },
    ]);
  });

  it("gives each identifier the role the FIR's own words give it", () => {
    const e = firEntities(parseCctnsFir(lines)!);
    const role = (v: string) => e.find((x) => x.value === v || x.normalized === v)?.role;
    expect(role("9000000001")).toBe("COMPLAINANT");
    expect(role("test.kumar@example.invalid")).toBe("COMPLAINANT");
    expect(role("@DemoMentor")).toBe("SUSPECT");
    expect(e.find((x) => x.value === "@DemoMentor")?.platform).toBe("Telegram");
    const intl = e.find((x) => x.value === "+44 7700 900123")!;
    expect(intl).toMatchObject({ role: "SUSPECT", foreign: true, platform: "WhatsApp" });
    expect(role("https://www.example-trade.cc/app")).toBe("SUSPECT");
    expect(role("31234567890")).toBe("BENEFICIARY");
    expect(e.find((x) => x.kind === "TXN_REFERENCE")?.value).toBe("512345678901");
  });

  it("sorts amounts by what happened to the money", () => {
    const a = firAmounts(parseCctnsFir(lines)!);
    const k = (t: string) => a.find((x) => x.text === t)?.kind;
    expect(k("Rs. 500")).toBe("PAID");
    expect(k("Rs. 1,00,000")).toBe("PAID");
    expect(k("Rs. 50,000")).toBe("PAID");
    expect(a.find((x) => x.text === "Rs. 1,50,000")).toMatchObject({ kind: "PAID", date: "26/10/2026", reference: "512345678901" });
    expect(k("Rs. 9,00,000")).toBe("PROFIT_SHOWN");
    expect(k("Rs. 2,00,000")).toBe("DEMANDED");
    expect(k("Rs. 3,00,500")).toBe("TOTAL_PAID");
    expect(k("Rs. 10,500")).toBe("RETURNED");
    expect(k("Rs. 2,90,000")).toBe("LOSS");
  });

  it("names the kind of fraud from all its signs, not the first keyword", () => {
    expect(fraudKind(parseCctnsFir(lines)!.narrative!.text).key).toBe("JOB");
    expect(fraudKind("comments containing abusive, filthy and derogatory language posted on the Twitter handles").key).toBe("ABUSE");
    expect(fraudKind("the fraudster impersonated a vendor and said the vendor's account details had been changed").key).toBe("BEC");
  });

  it("proposes the case, the brief, the details and first steps from the form", () => {
    const p = proposeCaseFromFir(lines, extractFromLines(lines));
    expect(p.fields).toMatchObject({ firNumber: "9001", firYear: "2026", reportedAt: "2026-11-02T11:00", legalSections: "BNS 318(4), 319(2) r/w 3(5); IT Act 66-D" });
    expect(p.parties).toEqual([{ name: "Test Kumar", role: "VICTIM", lossRupees: "2,90,000", source: "p. 1, line 20" }]);
    expect(p.payments.every((x) => x.to === null)).toBe(true);
    const b = briefFromFir(p, lines, []);
    expect(b.headline).toBe("Part-time job / task fraud: Test Kumar lost ₹2,90,000.");
    expect(b.sentences.map((s) => s.text).join(" ")).toMatch(/Paid ₹3,00,500 in all; ₹10,500 came back; loss registered ₹2,90,000 \(item 10\)\. The figure shown as profit \(₹9,00,000\) never existed as money\./);
    expect(b.sections).toEqual({ text: "BNS 318(4), 319(2) r/w 3(5); IT Act 66-D", stated: true });
    const found = foundDetails(p, []);
    expect(found.items.map((i) => i.title)).toEqual(expect.arrayContaining(["FIR 9001/2026", "Test Kumar, the complainant", "Telegram account @DemoMentor", "Account 31234567890, money sent here"]));
    const steps = firstStepsFromFir(p, []).map((s) => s.title);
    expect(steps).toEqual(expect.arrayContaining(["Hold request on account 31234567890", "Preserve Telegram account @DemoMentor", "Find or raise the NCRP complaint for this loss"]));
  });

  it("gives the case review each value's role and its exact place on the line", () => {
    const c = extractFromLines(lines);
    const own = c.find((x) => x.field === "PHONE" && x.originalValue === "9000000001")!;
    expect(own.roleHint).toBe("Complainant's own number");
    const intl = c.find((x) => x.field === "PHONE" && x.originalValue === "+44 7700 900123" && x.page === 2 && x.line === 2)!;
    expect(intl.excerpt.slice(intl.charStart!, intl.charEnd!)).toBe("+44 7700");
    for (const x of c) if (x.charStart != null) expect(x.charEnd!).toBeGreaterThan(x.charStart);
    expect(c.filter((x) => x.charStart == null)).toEqual([]);
  });
});

// Real FIR copies, when a station keeps them on this machine (data/ is never committed). Only the structure is
// checked here: nothing from the copies is written into the test.
const SAMPLES = path.resolve("data/samples");
const samples = fs.existsSync(SAMPLES) ? fs.readdirSync(SAMPLES).filter((f) => /^\d+-\d{4} - FIRST INFORMATION REPORT\.pdf$/.test(f)) : [];
describe.skipIf(!samples.length)("real CCTNS FIR copies on this machine", () => {
  it.each(samples)("%s reads completely", async (file) => {
    const { parseDocument } = await import("@/server/documents/parse");
    const parsed = await parseDocument(fs.readFileSync(path.join(SAMPLES, file)), "application/pdf");
    const ls: SourceLine[] = parsed.segments.map((s) => ({ page: s.page, line: s.line, row: s.row, text: s.text }));
    expect(ls.some((l) => l.text.includes("\u0000"))).toBe(false);
    const f = parseCctnsFir(ls)!;
    const [n, y] = file.split(" ")[0]!.split("-").map(Number);
    expect(f.fir?.value).toEqual({ number: n, year: y });
    expect(f.sections?.value).toMatch(/BNS|IT Act/);
    expect(f.complainant.name?.value).toBeTruthy();
    expect(f.investigatingOfficer?.name).toBeTruthy();
    expect(firEntities(f).some((e) => e.role === "SUSPECT")).toBe(true);
    expect(fraudKind(f.narrative!.text).key).not.toBe("OTHER");
    expect(extractFromLines(ls).filter((c) => c.charStart == null)).toEqual([]);
  });
});
