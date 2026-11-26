import { describe, expect, it } from "vitest";
import { splitIntoSections, type TextBlock } from "@/domain/knowledge-split";

const lines = (...t: string[]): TextBlock[] => t.map((text) => ({ text }));

describe("splitting an uploaded document into citable sections", () => {
  it("starts a section at each numbered clause and keeps its number as the reference", () => {
    const s = splitIntoSections(
      lines(
        "UNICROSS request circular",
        "1. Purpose",
        "This circular sets the fields for CDR requests.",
        "2. Mandatory fields",
        "Every request names the FIR number and sections.",
        "The number is written in full.",
        "2.1 Period",
        "The default period is 45 days around the offence.",
      ),
    );
    expect(s.map((x) => x.sectionRef)).toEqual(["Intro", "§1", "§2", "§2.1"]);
    expect(s[2]).toMatchObject({ heading: "Mandatory fields", text: "Every request names the FIR number and sections. The number is written in full." });
    expect(s[3]!.heading).toBe("Period");
  });

  it("reads Section, Rule, Chapter and Annexure headings as the law writes them", () => {
    const s = splitIntoSections(lines("Section 63 – Admissibility of electronic records", "A certificate shall accompany the record.", "Annexure A: Certificate format", "Part A is signed by the person in charge."));
    expect(s.map((x) => [x.sectionRef, x.heading])).toEqual([
      ["s. 63", "Admissibility of electronic records"],
      ["Annexure A", "Certificate format"],
    ]);
  });

  it("uses Markdown and Word heading levels when the file has them", () => {
    const s = splitIntoSections([
      { text: "Holds and restrictions", headingLevel: 1 },
      { text: "A hold is a lien on a stated amount." },
      { text: "## Seizure" },
      { text: "Seizure needs a court order." },
    ]);
    expect(s.map((x) => [x.sectionRef, x.heading, x.text])).toEqual([
      ["Part 1", "Holds and restrictions", "A hold is a lien on a stated amount."],
      ["Part 2", "Seizure", "Seizure needs a court order."],
    ]);
  });

  it("drops page numbers and running headers repeated on most pages", () => {
    const blocks: TextBlock[] = [];
    for (let p = 1; p <= 4; p++) blocks.push({ text: "TELANGANA POLICE · CONFIDENTIAL", page: p }, { text: `${p === 1 ? "1. Scope" : `${p}. Clause ${p}`}`, page: p }, { text: `Body of page ${p}.`, page: p }, { text: `Page ${p} of 4`, page: p });
    const s = splitIntoSections(blocks);
    expect(s.map((x) => x.text).join(" ")).not.toMatch(/CONFIDENTIAL|Page \d of 4/);
    expect(s.map((x) => x.sectionRef)).toEqual(["§1", "§2", "§3", "§4"]);
    expect(s[0]!.page).toBe(1);
  });

  it("cuts a file with no headings into parts at paragraph breaks, never mid-sentence", () => {
    const para = "The officer records the hold. ".repeat(30).trim();
    const s = splitIntoSections(lines(para, "", para, "", para));
    expect(s.length).toBeGreaterThan(1);
    for (const x of s) {
      expect(x.sectionRef).toMatch(/^Part \d+$/);
      expect(x.text.endsWith(".")).toBe(true);
    }
  });

  it("joins words hyphenated across lines and keeps references unique", () => {
    const s = splitIntoSections(lines("1. Scope", "The acknow-", "ledgement number is kept.", "1. Scope", "Repeated heading text."));
    expect(s[0]!.text).toBe("The acknowledgement number is kept.");
    expect(new Set(s.map((x) => x.sectionRef)).size).toBe(s.length);
  });

  it("returns nothing for a file with no readable text", () => {
    expect(splitIntoSections(lines("", "   ", "12"))).toEqual([]);
  });
});
