import { describe, expect, it } from "vitest";
import { deriveRecommendations, type FactEntity, type RecoFacts } from "@/domain/recommendations";

/** A real case as it stands right after its FIR is read: identifiers and a loss, no bank records yet. */
function fir(entities: FactEntity[], opts: { loss?: boolean; isDemo?: boolean } = {}): RecoFacts {
  return {
    now: new Date("2026-11-12T06:00:00Z"),
    isDemo: opts.isDemo ?? false,
    entities: [{ id: "victim", kind: "PERSON", label: "Complainant", value: "Complainant", attributes: {}, caseRole: "Victim (as stated at intake)" }, ...entities],
    victimAccountIds: entities.filter((e) => e.attributes.isVictimAccount).map((e) => e.id),
    transactions: [],
    holds: [],
    allocations: [],
    refunds: [],
    requests: [],
    responses: [],
    relationships: [],
    locations: [],
    claims: opts.loss === false ? [] : [{ id: "claim", victimEntityId: "victim", lossMinor: 107430848n }],
    sources: [],
  };
}
const e = (id: string, kind: string, value: string, caseRole: string | null, attributes: FactEntity["attributes"] = {}): FactEntity => ({ id, kind, label: value, value, attributes, caseRole });
const keys = (f: RecoFacts) => deriveRecommendations(f).map((r) => r.dedupeKey).sort();
const rec = (f: RecoFacts, key: string) => deriveRecommendations(f).find((r) => r.dedupeKey === key);

describe("the complainant's own identifiers", () => {
  it("are never the subject of a request", () => {
    const f = fir([e("mail", "EMAIL", "victim.1@gmail.com", "Complainant's own email"), e("ph", "PHONE", "+91 98480 12345", "Complainant's own number")]);
    expect(keys(f).filter((k) => /mail|ph/.test(k))).toEqual([]);
  });
});

describe("a beneficiary account the FIR names, before any bank record", () => {
  it("is to be frozen and its statement and KYC asked for, once its bank is known", () => {
    const f = fir([e("ben", "BANK_ACCOUNT", "50100012346126", "Reported beneficiary account", { bank: "HDFC Bank", ifsc: "HDFC0001234" })]);
    const hold = rec(f, "HOLD:ben")!;
    expect(hold).toMatchObject({ ruleId: "FUNDS_HOLD", requestCategory: "HOLD", priority: "HIGH", status: "OPEN", recipientHint: "HDFC Bank: nodal officer (from the nodal officer list)" });
    expect(rec(f, "INFO:ben")).toMatchObject({ ruleId: "FUNDS_TRACE", requestCategory: "INFORMATION", priority: "HIGH", status: "OPEN" });
  });
  it("waits for its bank to be recorded when the FIR does not give it", () => {
    const f = fir([e("ben", "BANK_ACCOUNT", "50100012346126", "Reported beneficiary account")]);
    const hold = rec(f, "HOLD:ben")!;
    expect(hold.status).toBe("BLOCKED");
    expect(hold.prerequisites.find((p) => !p.met)?.label).toBe("Bank identified");
  });
});

describe("a UPI ID named as receiving the money", () => {
  it("is first looked up with NPCI; the freeze waits for the account behind it", () => {
    const f = fir([e("upi", "UPI_ID", "p1.trade@okaxis", "UPI ID the complainant paid to (per the FIR)")]);
    expect(rec(f, "INFO:upi")).toMatchObject({ ruleId: "FUNDS_TRACE", status: "OPEN", recipientHint: "NPCI (from the nodal officer list)" });
    expect(rec(f, "HOLD:upi")).toBeUndefined();
  });
});

describe("following the money from the complainant's side", () => {
  it("asks the complainant's bank for the details of each debit when the FIR gives the account", () => {
    const f = fir([e("own", "BANK_ACCOUNT", "073649659002", "Complainant's own account", { isVictimAccount: true, bank: "Kotak Mahindra Bank" })]);
    expect(rec(f, "DEBITS:own")).toMatchObject({ ruleId: "FUNDS_VICTIM_DEBITS", requestCategory: "INFORMATION", priority: "HIGH", status: "OPEN" });
    expect(rec(f, "HOLD:own")).toBeUndefined();
  });
  it("asks the officer for the complainant's statement when no account of theirs is recorded", () => {
    const f = fir([e("ph", "PHONE", "+91 98480 12345", "Contact used by the alleged fraudster")]);
    expect(rec(f, "STATEMENT:victim")).toMatchObject({ ruleId: "FUNDS_VICTIM_STATEMENT", kind: "MISSING_INFORMATION", requestCategory: null, priority: "HIGH" });
  });
  it("does neither when nothing was lost", () => {
    const f = fir([e("own", "BANK_ACCOUNT", "073649659002", "Complainant's own account", { isVictimAccount: true, bank: "Kotak Mahindra Bank" })], { loss: false });
    expect(keys(f)).toEqual([]);
  });
});

describe("numbers the fraudster used", () => {
  it("go to UNICROSS only when they are Indian; a WhatsApp number also goes to WhatsApp", () => {
    const f = fir([e("in", "PHONE", "+91 90386 57010", "Contact used by the alleged fraudster (WhatsApp)"), e("td", "PHONE", "+235 99 52 77 41", "Contact used by the alleged fraudster (WhatsApp)"), e("us", "PHONE", "+1 (425) 880-2035", "Contact used by the alleged fraudster")]);
    const k = keys(f);
    expect(k).toContain("SUBSCRIBER:in");
    expect(k).not.toContain("SUBSCRIBER:td");
    expect(k).not.toContain("SUBSCRIBER:us");
    expect(rec(f, "WHATSAPP:td")).toMatchObject({ ruleId: "IDENTITY_WHATSAPP", requestCategory: "INFORMATION", recipientHint: "WhatsApp: law-enforcement team (from the nodal officer list)", status: "OPEN" });
    expect(rec(f, "WHATSAPP:in")).toBeDefined();
    expect(rec(f, "WHATSAPP:us")).toBeUndefined();
  });
});

describe("accounts on platforms and email", () => {
  it("are asked for their account details through the platform's or mail provider's team, never frozen", () => {
    const f = fir([e("x", "PLATFORM_PROFILE", "@MohanRam48110", "Account of the accused (X (Twitter))", { platform: "X (Twitter)" }), e("g", "EMAIL", "fraud.desk@gmail.com", "Email used by the alleged fraudster")]);
    expect(rec(f, "DETAILS:x")).toMatchObject({ status: "OPEN", ruleId: "IDENTITY_ACCOUNT_DETAILS", requestCategory: "INFORMATION", recipientHint: "X (Twitter): law-enforcement team (from the nodal officer list)" });
    expect(rec(f, "DETAILS:g")).toMatchObject({ status: "OPEN", requestCategory: "INFORMATION", recipientHint: "Google: law-enforcement team (from the nodal officer list)" });
    expect(rec(f, "DETAILS:g")!.title).toBe("Ask for the account details of fraud.desk@gmail.com");
    // A freeze (hold) is only for an account the money reached; a preservation-only request is not proposed.
    expect(rec(f, "PRESERVE:g")).toBeUndefined();
    expect(rec(f, "HOLD:g")).toBeUndefined();
  });
  it("wait for the mail host of a company domain to be identified", () => {
    const f = fir([e("c", "EMAIL", "finance@360degreepes.com", "Email used by the alleged fraudster")]);
    const p = rec(f, "DETAILS:c")!;
    expect(p.status).toBe("BLOCKED");
    expect(p.prerequisites.find((x) => !x.met)?.label).toBe("Mail host identified");
  });
  it("in a demonstration case still go to the configured route", () => {
    const f = fir([e("c", "EMAIL", "desk@example.invalid", "Email used by the alleged fraudster")], { isDemo: true });
    expect(rec(f, "DETAILS:c")?.status).toBe("OPEN");
  });
});

describe("websites used in the fraud", () => {
  it("ask each site's registrar once for its registrant and hosting, never a platform's own pages", () => {
    const f = fir([
      e("w1", "WEBSITE", "https://www.harmon.rest/harmon/register/7896", "Website used in the fraud (per the FIR)"),
      e("w2", "WEBSITE", "https://www.harmon.rest/harmon/register/789658", "Website used in the fraud (per the FIR)"),
      e("w3", "WEBSITE", "https://redb026.com/", "Website used in the fraud (per the FIR)", { registrar: "GoDaddy" }),
      e("w4", "WEBSITE", "https://x.com/MohanRam48110/status/1", "Post named in the FIR (X (Twitter))"),
    ]);
    const sites = deriveRecommendations(f).filter((r) => r.ruleId === "EVIDENCE_WEBSITE");
    expect(sites.map((r) => r.dedupeKey).sort()).toEqual(["SITE:harmon.rest", "SITE:redb026.com"]);
    expect(sites.find((r) => r.dedupeKey === "SITE:harmon.rest")).toMatchObject({ status: "BLOCKED", subjectEntityIds: ["w1", "w2"] });
    expect(sites.find((r) => r.dedupeKey === "SITE:redb026.com")).toMatchObject({ status: "OPEN", recipientHint: "GoDaddy: law-enforcement team (from the nodal officer list)" });
  });
});
