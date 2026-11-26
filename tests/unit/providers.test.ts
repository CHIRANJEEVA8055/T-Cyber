import { describe, expect, it } from "vitest";
import { bankFromIfsc, bankNamedNear, emailProvider, isIndianNumber, isVictimOwned, platformProvider, siteHost, PROVIDERS } from "@/domain/providers";

describe("which bank an IFSC belongs to", () => {
  it.each([
    ["SBIN0001234", "State Bank of India"],
    ["hdfc0000123", "HDFC Bank"],
    ["ICIC0000001", "ICICI Bank"],
    ["UTIB0000456", "Axis Bank"],
    ["KKBK0007465", "Kotak Mahindra Bank"],
    ["AIRP0000001", "Airtel Payments Bank"],
  ])("%s → %s", (ifsc, bank) => expect(bankFromIfsc(ifsc)).toBe(bank));
  it("says nothing for a code it does not know or a malformed one", () => {
    expect(bankFromIfsc("ZZZZ0001234")).toBeNull();
    expect(bankFromIfsc("SBI")).toBeNull();
    expect(bankFromIfsc(null)).toBeNull();
  });
});

describe("who keeps an email account's records", () => {
  it("names the provider of a public mail service", () => {
    expect(emailProvider("someone.123@gmail.com")?.name).toBe("Google");
    expect(emailProvider("x@yahoo.co.in")?.name).toBe("Yahoo");
    expect(emailProvider("x@hotmail.com")?.name).toBe("Microsoft");
    expect(emailProvider("x@rediffmail.com")?.name).toBe("Rediff");
    expect(emailProvider("p.tirupathi_360degreepes@mail.com")?.name).toBe("mail.com");
  });
  it("does not guess the mail host of a company or unknown domain", () => {
    expect(emailProvider("finance@360degreepes.com")).toBeNull();
    expect(emailProvider("x@protonmail.com")).toBeNull();
    expect(emailProvider("not an email")).toBeNull();
  });
});

describe("which provider runs a platform", () => {
  it.each([
    ["Telegram", "Telegram"],
    ["X (Twitter)", "X (Twitter)"],
    ["twitter", "X (Twitter)"],
    ["WhatsApp", "WhatsApp"],
    ["Instagram", "Instagram (Meta)"],
    ["Facebook", "Facebook (Meta)"],
    ["YouTube", "Google"],
  ])("%s → %s", (p, name) => expect(platformProvider(p)?.name).toBe(name));
  it("returns nothing for an unknown platform", () => expect(platformProvider("Dating platform")).toBeNull());
  it("has nodal-list names to look each provider up by", () => {
    for (const p of Object.values(PROVIDERS)) expect(p.keys.length).toBeGreaterThan(0);
  });
});

describe("Indian and foreign numbers", () => {
  it.each(["+91 73024 70326", "9876543210", "09876543210", "+91-98480-12345", "919876543210"])("%s is Indian", (n) => expect(isIndianNumber(n)).toBe(true));
  it.each(["+235 99 52 77 41", "+1 (425) 880-2035", "+44 20 7946 0958", "12345"])("%s is not", (n) => expect(isIndianNumber(n)).toBe(false));
});

describe("websites", () => {
  it("reads the host a site is served from", () => {
    expect(siteHost("https://www.harmon.rest/harmon/register/7896")).toBe("harmon.rest");
    expect(siteHost("m.darwinexgolbal.cc")).toBe("darwinexgolbal.cc");
    expect(siteHost("https://shop.example.co.in/pay")).toBe("example.co.in");
    expect(siteHost("https://x.com/MohanRam48110/status/1")).toBe("x.com");
    expect(siteHost("http://203.0.113.9/login")).toBeNull();
    expect(siteHost("https://redb026.com/#/register?type=2")).toBe("redb026.com");
    expect(siteHost("not a site")).toBeNull();
  });
});

describe("identifiers that are the complainant's own", () => {
  it.each(["Complainant's own email", "Complainant’s own account", "Victim's own number", "Complainant's own number"])("%s", (role) => expect(isVictimOwned({ caseRole: role, attributes: {} })).toBe(true));
  it("also by the victim-account flag or the officer's note", () => {
    expect(isVictimOwned({ caseRole: null, attributes: { isVictimAccount: true } })).toBe(true);
    expect(isVictimOwned({ caseRole: null, attributes: {}, belongsTo: "VICTIM" })).toBe(true);
  });
  it.each(["Email used by the alleged fraudster", "Reported beneficiary account", null])("not %s", (role) => expect(isVictimOwned({ caseRole: role, attributes: {} })).toBe(false));
});

describe("a bank named beside an account number in the FIR", () => {
  it("is read from the words around the number", () => {
    expect(bankNamedNear("deposited Rs. 1,00,000 into SBI bank account 30012346126 given by the trader", "30012346126")).toBe("State Bank of India");
    expect(bankNamedNear("A/c No. 50100012346126 (HDFC Bank, Madhapur branch)", "50100012346126")).toBe("HDFC Bank");
    expect(bankNamedNear("transferred to Kotak Mahindra Bank a/c 073649659002", "073649659002")).toBe("Kotak Mahindra Bank");
  });
  it("takes the nearest bank when two are named", () => {
    expect(bankNamedNear("from her ICICI Bank account she paid to account 50100012346126 with HDFC", "50100012346126")).toBe("HDFC Bank");
  });
  it("says nothing when no bank is named nearby, or only far away", () => {
    expect(bankNamedNear("paid to account 50100012346126 as told", "50100012346126")).toBeNull();
    expect(bankNamedNear(`HDFC Bank ${"x ".repeat(120)} account 50100012346126`, "50100012346126")).toBeNull();
    expect(bankNamedNear("State Bank of India account 30012346126", "99999")).toBeNull();
  });
});
