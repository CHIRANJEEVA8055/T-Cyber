import { describe, expect, it } from "vitest";
import { checkModelFacts, parseModelJson } from "@/domain/reply-reading";

const reply = [
  "Dear Sir, with reference to your request REQ-2026-0291 regarding WhatsApp account +235 99 52 77 41:",
  "The account was registered on 12-08-2026 by the user name 'Chanda Mentor', email mentor.chanda@protonmail.com.",
  "Last login IP: 102.89.34.11 on 01-11-2026 18:22:05 UTC.",
  "Records for the account are preserved until 30-01-2027.",
].join("\n");

describe("reading the model's answer", () => {
  it("accepts JSON wrapped in a code fence", () => {
    expect(parseModelJson('```json\n{"facts":[]}\n```')).toEqual({ facts: [] });
    expect(parseModelJson("not json")).toBeNull();
  });
});

describe("checking each fact against the reply", () => {
  it("keeps a fact whose quote is in the reply and whose values are in the quote", () => {
    const kept = checkModelFacts(
      {
        facts: [
          { type: "ACCOUNT_HOLDER", holder: "Chanda Mentor", quote: "registered on 12-08-2026 by the user name 'Chanda Mentor'" },
          { type: "REGISTERED_EMAIL", email: "mentor.chanda@protonmail.com", quote: "email mentor.chanda@protonmail.com" },
          { type: "IP_LOG", ip: "102.89.34.11", at: "01-11-2026 18:22:05", quote: "Last login IP: 102.89.34.11 on 01-11-2026 18:22:05 UTC." },
          { type: "PRESERVED", until: "30-01-2027", quote: "Records for the account are preserved until 30-01-2027." },
        ],
      },
      reply,
    );
    expect(kept.map((f) => f.type)).toEqual(["ACCOUNT_HOLDER", "REGISTERED_EMAIL", "IP_LOG", "PRESERVED"]);
  });

  it("drops a fact the reply does not say, or whose value the quote does not contain", () => {
    const kept = checkModelFacts(
      {
        facts: [
          { type: "ACCOUNT_HOLDER", holder: "Ravi Kumar", quote: "The account holder is Ravi Kumar" },
          { type: "REGISTERED_MOBILE", mobile: "+91 98480 12345", quote: "Last login IP: 102.89.34.11 on 01-11-2026 18:22:05 UTC." },
          { type: "IP_LOG", ip: "102.89.34.99", quote: "Last login IP: 102.89.34.11" },
          { type: "BOGUS", quote: "Dear Sir" },
          "not an object",
        ],
      },
      reply,
    );
    expect(kept).toEqual([]);
  });

  it("matches numbers and amounts however they are written", () => {
    const bank = "Beneficiary A/c 50100012346126, IFSC HDFC0001234, credited Rs. 1,00,000.00 on 03-10-2026 vide UTR 627611234567.\nMobile registered: +91-98480-12345";
    const kept = checkModelFacts(
      {
        facts: [
          { type: "BENEFICIARY_PAYMENT", account: "50100012346126", ifsc: "HDFC0001234", amount: "100000", date: "03-10-2026", reference: "627611234567", quote: "Beneficiary A/c 50100012346126, IFSC HDFC0001234, credited Rs. 1,00,000.00 on 03-10-2026 vide UTR 627611234567." },
          { type: "REGISTERED_MOBILE", mobile: "9848012345", quote: "Mobile registered: +91-98480-12345" },
          { type: "BENEFICIARY_PAYMENT", account: "50100012346126", amount: "2,00,000", date: "03-10-2026", quote: "Beneficiary A/c 50100012346126, IFSC HDFC0001234, credited Rs. 1,00,000.00 on 03-10-2026 vide UTR 627611234567." },
        ],
      },
      bank,
    );
    expect(kept.map((f) => f.type)).toEqual(["BENEFICIARY_PAYMENT", "REGISTERED_MOBILE"]);
  });
});
