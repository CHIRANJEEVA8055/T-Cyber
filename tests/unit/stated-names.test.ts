import { describe, expect, it } from "vitest";
import type { SourceLine } from "@/domain/extraction";
import { extractFromLines } from "@/domain/extraction";
import { parseCctnsFir } from "@/domain/extraction/cctns";
import { firEntities, statedNameNear } from "@/domain/extraction/fir-entities";
import { compareNames } from "@/domain/providers";

/**
 * An FIR is what the complainant says before any enquiry: a name it gives for an account, number or email is kept
 * only as stated ("stated to be …"), never as the accused or the account holder.
 */
const PAGES: string[][] = [
  [
    "FIRST INFORMATION REPORT",
    "1. District Cyberabad P.S. Cyber Crimes Year 2026 FIR No. 9002/2026 Date 02-11-2026",
    "2. Acts & Section(s): 318(4) BNS, 66-D ITA-2000-2008,",
    "3. a) Occurrence of Offence: Day Monday Date & Time From",
    "b) Information Received at P.S.: Date & Time 02-11-2026 11:00",
    "4. Type of Information: Written",
    "6. Complainant / Informant:",
    "a) Name Suresh Demo",
    "g) Occupation Mobile No. 9000000002",
    "7. Details of known/suspected/unknown accused with full particulars:",
  ],
  [
    "Serial No : 1",
    "a) Name Ravi Example, mobile 9876500001",
    "b) Father's /Husband's Name",
    "8. Reasons for delay in reporting by the complainant / informant:",
    "12. Contents of the complaint / statement of the complainant or informant:",
    "Brief facts of the case are that on 02-11-2026 at 1100 hours received a complaint from Suresh Demo, whose",
    "mobile number is 9000000002, submitted that Suresh with bank account id - 31234561234 have lost Rs. 1,00,000/-",
    "and transactioned to a vendor named adharsh bearing with bank account id - 50100000005678 on 01-11-2026; he also",
    "paid Rs. 20,000/- to UPI ID kiran.pay@okaxis in the name of Kiran Kumar. Hence the FIR.",
    "As per the above Content, I. A. Example, SI of Police, registered a case in Cr. No. 9002/2026.",
    "13. Action taken:",
  ],
];
const lines: SourceLine[] = PAGES.flatMap((p, i) => p.map((text, j) => ({ page: i + 1, line: j + 1, row: null, text })));

describe("a name the text gives for an identifier", () => {
  it("is read from the words around it", () => {
    const t = "and transactioned to a vendor named adharsh bearing with bank account id - 50100000005678 on 01-11-2026";
    expect(statedNameNear(t, t.indexOf("5010"), t.indexOf("5010") + 14)).toBe("adharsh");
    const u = "paid Rs. 20,000/- to UPI ID kiran.pay@okaxis in the name of Kiran Kumar. Hence";
    expect(statedNameNear(u, u.indexOf("kiran.pay"), u.indexOf("kiran.pay") + 17)).toBe("Kiran Kumar");
    const v = "Suresh with bank account id - 31234561234 have lost";
    expect(statedNameNear(v, v.indexOf("3123"), v.indexOf("3123") + 11)).toBe("Suresh");
  });
  it("is not invented from ordinary words or the bank's name", () => {
    const t = "he transferred the amount with bank account number 50100000005678 to them";
    expect(statedNameNear(t, t.indexOf("5010"), t.indexOf("5010") + 14)).toBeNull();
    const u = "paid into the account 50100000005678 of HDFC Bank";
    expect(statedNameNear(u, u.indexOf("5010"), u.indexOf("5010") + 14)).toBeNull();
    const w = "money sent to the complainant's own account 31234561234";
    expect(statedNameNear(w, w.indexOf("3123"), w.indexOf("3123") + 11)).toBeNull();
  });
});

describe("reading an FIR that names people beside identifiers", () => {
  it("keeps each name only as stated, with the identifier's role unchanged", () => {
    const e = firEntities(parseCctnsFir(lines)!);
    const of = (v: string) => e.find((x) => x.value === v || x.normalized === v)!;
    expect(of("50100000005678")).toMatchObject({ role: "BENEFICIARY", statedName: "adharsh" });
    expect(of("kiran.pay@okaxis")).toMatchObject({ statedName: "Kiran Kumar" });
    expect(of("9876500001")).toMatchObject({ role: "SUSPECT", statedName: "Ravi Example" });
  });

  it("words the role as stated and never as the accused or the holder", () => {
    const c = extractFromLines(lines);
    const ben = c.find((x) => x.field === "BANK_ACCOUNT" && x.originalValue === "50100000005678")!;
    expect(ben.roleHint).toBe("Reported beneficiary account; stated to be “adharsh” (per the FIR, not verified)");
    expect(ben.structured).toMatchObject({ statedName: "adharsh" });
    const accused = c.find((x) => x.field === "PHONE" && x.originalValue === "9876500001")!;
    expect(accused.roleHint).toMatch(/stated to be “Ravi Example” \(per the FIR, not verified\)$/);
    for (const x of c) expect(x.roleHint ?? "").not.toMatch(/account of the accused|holder on record/i);
  });

  it("does not treat an 'Account holder:' line in a complaint as the bank's record", () => {
    const c = extractFromLines([{ page: 1, line: 1, row: null, text: "Account holder: Adharsh Demo" }], { source: "STATEMENT_OF_COMPLAINANT" });
    expect(c.find((x) => x.field === "PERSON_NAME")?.roleHint).toBe("Name stated for the account (not verified)");
    const bank = extractFromLines([{ page: 1, line: 1, row: null, text: "Account holder: Adharsh Demo" }], { source: "RECORD" });
    expect(bank.find((x) => x.field === "PERSON_NAME")?.roleHint).toBe("Account holder on record (per bank)");
  });
});

describe("checking a stated name against the name a record gives", () => {
  it.each([
    ["adharsh", "ADHARSH KUMAR", "MATCHES"],
    ["Ravi Example", "Mr. Ravi Example", "MATCHES"],
    ["R. Kumar", "Ravi Kumar", "MATCHES"],
    ["adharsh", "Adarsh Kumar", "PROBABLY"],
    ["Kiran Kumar", "Kiran Kumaar", "PROBABLY"],
    ["adharsh", "Ramesh Babu", "DIFFERS"],
    ["Ravi Example", "Ravi Sample", "DIFFERS"],
  ])("%s against %s: %s", (stated, record, verdict) => {
    expect(compareNames(stated, record).verdict).toBe(verdict);
  });
  it("says what it means, without claiming who used the account", () => {
    expect(compareNames("adharsh", "Adarsh Kumar").words).toBe("probably the same name, spelt differently");
    expect(compareNames("adharsh", "ADHARSH KUMAR").words).toBe("the names match");
  });
});
