import { describe, expect, it } from "vitest";
import { classifyMo, MO_VERTICALS, sectionVertical } from "@/domain/mo-verticals";

// Synthetic complaint wording only; no real FIR text.
const cases: [string, string, string | null][] = [
  ["The complainant was added to a WhatsApp group that promised profits from share market trading on an app; she invested in an IPO and block trades and was shown profits she could not withdraw.", "INVESTMENT", "Trading"],
  ["He received a part time job offer on Telegram to complete prepaid tasks rating hotels, work from home, and paid for each task group.", "INVESTMENT", "Part Time / Work From Home"],
  ["A person claiming to be an army officer posted an advertisement on OLX for a second-hand bike and took an advance.", "ADVERTISEMENT", "OLX"],
  ["She applied on a job portal and was sent an offer letter for a recruitment, then asked to pay a registration fee and a training fee before the interview.", "JOB", null],
  ["The accused offered a franchise and dealership of a food brand and collected a franchise fee.", "BUSINESS", "Franchise"],
  ["Someone called from a bank customer care number and asked for the OTP to stop a charge; the OTP was shared and money was debited.", "OTP", "OTP"],
  ["A message said his SBI reward points would expire and asked him to install an APK file to redeem them.", "OTP", "Reward Points"],
  ["During a video call a nude video was recorded and the caller threatened to share the morphed video unless money was paid.", "SOCIAL_MEDIA", "Sextortion / Honey Trap"],
  ["The vendor's email was spoofed from a look-alike domain and the account details were changed in the fake email, so the payment went elsewhere.", "SOCIAL_MEDIA", "Emails"],
  ["A WhatsApp account using the Collector's photo as its display picture (DP) asked officials for Amazon gift cards.", "SOCIAL_MEDIA", "WhatsApp DP"],
  ["Her Instagram account was hacked and the attacker changed the password and recovery email.", "SOCIAL_MEDIA", "Hacking"],
  ["The company's files were encrypted by ransomware and a ransom note demanded bitcoin to decrypt them.", "SOCIAL_MEDIA", "Ransomware"],
  ["A post on Facebook made derogatory remarks about a religion, intended to provoke communal tension.", "SOCIAL_MEDIA", "Political and Communal"],
  ["He was told he had won a lottery prize in a KBC lucky draw and paid processing charges.", "MISC", "Lottery"],
  ["After downloading an instant loan app she was harassed with morphed photos sent to her contacts for repayment.", "MISC", "Loan App"],
  ["A man met on a matrimonial site promised marriage and borrowed money for a medical emergency.", "MISC", "Matrimonial"],
  ["An agent promised a work visa for Canada and collected visa processing fees.", "MISC", "Visa"],
];

describe("investigation vertical from the facts of a complaint", () => {
  it("lists the station's seven verticals in the order of the MO table", () => {
    expect(MO_VERTICALS.map((v) => v.label)).toEqual(["Investment Frauds", "Advertisement Fraud", "Job Frauds", "Business Frauds", "OTP Frauds", "Social Media Frauds", "Miscellaneous"]);
  });

  for (const [text, vertical, subtype] of cases) {
    it(`${vertical}${subtype ? ` · ${subtype}` : ""}: ${text.slice(0, 50)}…`, () => {
      const r = classifyMo({ facts: text });
      expect(r.vertical?.key).toBe(vertical);
      if (subtype) expect(r.subtype).toBe(subtype);
      expect(r.basis).toBe("FACTS");
      expect(r.signs.length).toBeGreaterThan(0);
    });
  }

  it("does not read 'investigation' or 'investigating officer' as an investment", () => {
    const r = classifyMo({ facts: "The case is entrusted to the investigating officer for investigation. Facts are under verification." });
    expect(r.vertical).toBeNull();
  });

  it("puts a part-time task fraud under Investment Frauds, as the MO table does, not under Job Frauds", () => {
    const r = classifyMo({ facts: "She got a part-time job message offering commission for liking YouTube videos and then prepaid tasks." });
    expect(r.vertical?.key).toBe("INVESTMENT");
  });
});

describe("falling back to the stated sections", () => {
  it("uses a section only when its own title names a class, and says so", () => {
    expect(classifyMo({ facts: "The facts are not yet recorded.", sections: "BNS 318(4); IT Act 66C" })).toMatchObject({ vertical: { key: "SOCIAL_MEDIA" }, subtype: "Identity Theft", basis: "SECTIONS" });
    expect(classifyMo({ facts: "", sections: "196 BNS" })).toMatchObject({ vertical: { key: "SOCIAL_MEDIA" }, subtype: "Political and Communal", basis: "SECTIONS" });
    expect(classifyMo({ facts: "", sections: "66 ITA-2000-2008" })).toMatchObject({ subtype: "Hacking", basis: "SECTIONS" });
  });

  it("does not classify from cheating or personation sections that every fraud carries", () => {
    const r = classifyMo({ facts: "", sections: "318(4),319(2),336(3),338,340(2),r/w 3(5) BNS, 66-D ITA-2000-2008," });
    expect(r.vertical).toBeNull();
    expect(r.basis).toBe("NONE");
  });

  it("prefers the facts over the sections", () => {
    const r = classifyMo({ facts: "He shared the OTP with a caller from customer care.", sections: "IT Act 66C" });
    expect(r.vertical?.key).toBe("OTP");
    expect(r.basis).toBe("FACTS");
  });

  it("reads sections in both the CCTNS order (numbers, then the act) and the act-first order", () => {
    expect(sectionVertical("66-C ITA-2000-2008")?.subtype).toBe("Identity Theft");
    expect(sectionVertical("IT Act 66C, 66D")?.subtype).toBe("Identity Theft");
    expect(sectionVertical("BNS 318(4), 319(2)")).toBeNull();
  });
});

describe("a case's vertical", () => {
  it("is the officer's choice when one was made, and otherwise read from the facts", async () => {
    const { caseMo, moLine } = await import("@/domain/mo-verticals");
    expect(caseMo({ moVertical: "JOB", moSubtype: null, narrative: "trading app and IPO" })).toMatchObject({ vertical: { key: "JOB" }, basis: "OFFICER" });
    expect(caseMo({ moVertical: "OTP", moSubtype: "Not a kind", narrative: "" }).subtype).toBeNull();
    const auto = caseMo({ moVertical: null, narrative: "She invested in an IPO through a trading app." });
    expect(auto).toMatchObject({ vertical: { key: "INVESTMENT" }, subtype: "Trading", basis: "FACTS" });
    expect(moLine(auto)).toMatch(/^Investment Frauds · Trading, from the facts: /);
    expect(moLine(caseMo({ moVertical: null, narrative: "" }))).toBe("Not clear from the FIR: choose the vertical");
  });
});

describe("what the FIR itself says about the MO", () => {
  it("finds a stated category or modus operandi, and ignores the form's other headings", async () => {
    const { findStatedMo } = await import("@/domain/mo-verticals");
    const s = findStatedMo("FIRST INFORMATION REPORT\nType of Information: Written\nCategory: Online Financial Fraud\nSub Category: Investment Scam / Trading Scam\n3. Brief facts");
    expect(s).toEqual({ lines: ["Category: Online Financial Fraud", "Sub Category: Investment Scam / Trading Scam"], text: "Online Financial Fraud; Investment Scam / Trading Scam" });
    expect(findStatedMo("Modus Operandi: posed as bank customer care and took the OTP")?.text).toBe("posed as bank customer care and took the OTP");
    expect(findStatedMo("Type of Information: Written\nPlace of occurrence: Online")).toBeNull();
  });
});
