import { describe, expect, it } from "vitest";
import { parseMarkdown } from "@/features/assistant/components/markdown";

describe("reading the assistant's Markdown", () => {
  it("reads headings, paragraphs, numbered steps with sub-points, and bullets", () => {
    const b = parseMarkdown(["Register the FIR first [S1].", "", "### Steps", "1. **Record** the statement [S2]", "   - with the UTRs", "2. Freeze the accounts", "", "- One", "- Two"].join("\n"));
    expect(b.map((x) => x.t)).toEqual(["p", "h", "list", "list"]);
    const steps = b[2] as Extract<(typeof b)[number], { t: "list" }>;
    expect(steps).toMatchObject({ ordered: true, start: 1 });
    expect(steps.items.map((i) => i.text)).toEqual(["**Record** the statement [S2]", "Freeze the accounts"]);
    expect(steps.items[0]!.sub).toEqual({ ordered: false, items: ["with the UTRs"] });
  });
  it("keeps a numbered list together across blank lines between its items", () => {
    const b = parseMarkdown("1. First\n\n2. Second\n\n3. Third");
    expect(b).toHaveLength(1);
    expect((b[0] as { items: unknown[] }).items).toHaveLength(3);
  });
  it("reads a table", () => {
    const b = parseMarkdown("| MO | Example |\n|---|---|\n| Investment | Trading app [S3] |\n| OTP | KYC update |");
    expect(b[0]).toEqual({ t: "table", head: ["MO", "Example"], rows: [["Investment", "Trading app [S3]"], ["OTP", "KYC update"]] });
  });
});
