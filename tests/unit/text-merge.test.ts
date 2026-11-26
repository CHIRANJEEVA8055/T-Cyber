import { describe, expect, it } from "vitest";
import { keepLayout } from "@/domain/text-merge";

const before = ["To the Nodal Officer, Bank B", "", "Sir/Madam,", "", "In FIR 412/2026 of PS Madhapur, ₹70,000 was transferred on 05 Nov 2026 from Account A to account XXXX2093 with your bank.", "", "- The account statement", "- KYC documents", "", "Yours faithfully"].join("\n");

describe("keeping T-CYBER's layout for an edit made in Gmail", () => {
  it("takes the changed words and drops Gmail's wrapping", () => {
    const gmail = ["To the Nodal Officer, Bank B", "", "Sir/Madam,", "", "In FIR 412/2026 of PS Madhapur, ₹70,000", "was transferred on 06 Nov 2026 from Account A to account XXXX2093 with your", "bank. Please reply within seven days.", "", "- The account statement", "- KYC documents", "", "Yours faithfully"].join("\n");
    expect(keepLayout(before, gmail)).toBe(before.replace("05 Nov", "06 Nov").replace("with your bank.", "with your bank. Please reply within seven days."));
  });
  it("is the same text when Gmail only re-wrapped it", () => {
    const wrapped = before.replace("₹70,000 was", "₹70,000\nwas").replace("your bank.", "your\nbank.");
    expect(keepLayout(before, wrapped)).toBe(before);
  });
  it("keeps a paragraph break and a list line the officer added", () => {
    const gmail = before.replace("- KYC documents", "- KYC documents\n- Registered mobile number").replace("Yours faithfully", "This is urgent.\n\nYours faithfully");
    const out = keepLayout(before, gmail);
    expect(out).toContain("- KYC documents\n- Registered mobile number\n\nThis is urgent.\n\nYours faithfully");
  });
});
