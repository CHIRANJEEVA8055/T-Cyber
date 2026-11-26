import { describe, expect, it } from "vitest";
import { plainLine } from "@/domain/plain-line";

// Synthetic values only.
describe("one plain line per next action", () => {
  it("names the identifier, says what to do and why, with the amount and date from the record", () => {
    expect(
      plainLine({
        ruleId: "FUNDS_HOLD",
        title: "Request a debit freeze on Account B",
        why: "Account B received ₹70,000 directly from the victim, first on 05 Nov 2026. Funds in a mule account can be withdrawn at any time. Secure remaining funds before they move further.",
        subject: { kind: "BANK_ACCOUNT", label: "Account B", value: "XXXXXXXX2093" },
        org: "Bank B",
      }),
    ).toBe("Ask Bank B to freeze Account B (XXXXXXXX2093). It got ₹70,000 from the victim on 05 Nov, and the money can still be stopped.");
  });

  it("keeps it to one or two short sentences for every kind of action", () => {
    const line = plainLine({ ruleId: "IDENTITY_SUBSCRIBER", title: "Ask UNICROSS for the CDR and CAF of mobile +91-XXXXXXXX41", why: "Bank A records +91-XXXXXXXX41 as the registered mobile for Account A. Test who controls the account through an independent record.", subject: { kind: "PHONE", label: "+91-XXXXXXXX41", value: "+91-XXXXXXXX41" }, org: "UNICROSS" });
    expect(line).toBe("Ask UNICROSS for the call records and ID form of mobile +91-XXXXXXXX41. They show who registered and uses this number.");
    expect(plainLine({ ruleId: null, title: "Check whether P1 is the person named in FIR 377", why: "Reopened by you. A matching name alone is not enough; one shared identifier, address or photo would link them.", subject: null, org: null })).toBe("Check whether P1 is the person named in FIR 377. A matching name alone is not enough; one shared identifier, address or photo would link them.");
    expect(plainLine({ ruleId: "EVIDENCE_ATM_CCTV", title: "Get the ATM CCTV footage from 06 Nov, Kukatpally", why: "Cash was withdrawn at ATM, Kukatpally on 06 Nov 2026.", subject: null, org: null })).toBe("Get the ATM CCTV footage from 06 Nov, Kukatpally. The camera may show who took the cash, and footage is kept only 30 to 90 days.");
  });
});
