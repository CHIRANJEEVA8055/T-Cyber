import { describe, expect, it } from "vitest";
import { defaultClosing, joinClosing, splitClosing, withClosing } from "@/domain/closing";

const mailbox = { valediction: "Yours faithfully,", signature: ["PS Madhapur, Cyberabad", "Cyber Crime Wing", "Tel: +91-00000-00000"] };
const officer = { displayName: "R. Devi", rank: "Inspector" };

describe("the closing block of a request", () => {
  it("is the valediction, the officer's name and rank, and the station lines by default", () => {
    expect(defaultClosing(officer, mailbox)).toEqual(["Yours faithfully,", "R. Devi, Inspector", "PS Madhapur, Cyberabad", "Cyber Crime Wing", "Tel: +91-00000-00000"]);
  });

  it("replaces the template's standard foot with the officer's own closing", () => {
    const body = "Sir/Madam,\n\nKindly furnish the records.\n\nR. Devi, Inspector\nPS Madhapur, Cyberabad\nCyber Crime Wing\nTel: +91-00000-00000";
    const mine = ["Yours sincerely,", "R. Devi", "Inspector of Police, PS Madhapur", "Tel: +91-90000-00001"];
    expect(withClosing(body, officer, mailbox, mine)).toBe(`Sir/Madam,\n\nKindly furnish the records.\n\n${mine.join("\n")}`);
    // A template that ends with the bare "Name, Rank" line gets the closing too.
    expect(withClosing("Please provide the records.\n\nR. Devi, Inspector", officer, mailbox, mine)).toBe(`Please provide the records.\n\n${mine.join("\n")}`);
    // A body that does not end with the standard foot (an officer's own wording) is left alone.
    expect(withClosing("Sir/Madam,\n\nThanks.", officer, mailbox, mine)).toBe("Sir/Madam,\n\nThanks.");
  });

  it("splits the closing from the letter text and joins them back unchanged", () => {
    const body = "Sir/Madam,\n\nKindly furnish the records.\n\nYours faithfully,\nR. Devi, Inspector\nPS Madhapur, Cyberabad";
    const s = splitClosing(body);
    expect(s).toEqual({ text: "Sir/Madam,\n\nKindly furnish the records.", closing: "Yours faithfully,\nR. Devi, Inspector\nPS Madhapur, Cyberabad" });
    expect(joinClosing(s.text, s.closing)).toBe(body);
    // A closing without a valediction is still found by the officer's rank line.
    expect(splitClosing("Text.\n\nR. Devi, Inspector\nPS Madhapur").closing).toBe("R. Devi, Inspector\nPS Madhapur");
    // A last paragraph that is ordinary text is not taken for a closing.
    expect(splitClosing("Sir/Madam,\n\nKindly furnish the statement for the period, quoting the reference.").closing).toBe("");
  });
});
