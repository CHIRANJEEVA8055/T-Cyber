import { beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@/server/db";
import { seedDemo } from "@/server/seed";
import type { SessionUser } from "@/server/auth/session";
import { importKnowledgeFolder, parseFrontMatter, prepareMarkdownDocument } from "@/server/services/knowledge-admin";
import { askGuidance } from "@/server/services/assistant";
import { addRecipientFromNodal, importNodalWorkbook, listNodal, nodalFor, providerKey } from "@/server/services/nodal";
import { buildZip } from "@/server/documents/zip";

const db = getDb();
async function user(username: string): Promise<SessionUser> {
  const u = await db.user.findUniqueOrThrow({ where: { username }, include: { station: true } });
  return { id: u.id, username, displayName: u.displayName, rank: u.rank, role: u.role as SessionUser["role"], stationId: u.stationId, stationCode: u.station.code, stationName: u.station.name };
}
const offline = async () => ({ ok: false as const, error: "The local model is not running on this server." });

const SOP = `---
source_file: "07 - Demo Freeze SOP.pdf"
file_type: pdf (3 pages, scanned, OCR)
content_type: Government circular – demo SOP for freezing accounts
title: "Demo SOP for Freezing and Unfreezing Accounts"
issuing_authority: "Demo Cyber Bureau"
document_ids: ["ID.No. 9/DEMO/2026 dated 05.03.2026"]
tags: [freeze, unfreeze, lien, demo]
---

# Demo SOP for Freezing and Unfreezing Accounts

## Source description

A synthetic circular used in tests.

## When an account may be unfrozen

> 1. An unfreeze needs the written order of the investigating officer and the approval of the unit head.
> 2. The bank lifts the lien within three working days of the order.

## Key facts for retrieval

- Unfreeze: IO order plus unit-head approval.
`;
const VIDEO = `---
source_file: "08 - Demo video.mp4"
file_type: mp4 video (1:02)
title: "Video: How to read a demo statement"
language: Telugu (machine-translated, approximate)
tags: [statement]
---

# Video: How to read a demo statement

## Narration

The officer opens the statement and notes each debit with its UTR number.
`;

/** A one-sheet workbook in the layout of the CrimeOS nodal officer export. */
function workbook(rows: string[][]): Buffer {
  const strings: string[] = [];
  const idx = (s: string) => (strings.includes(s) ? strings.indexOf(s) : strings.push(s) - 1);
  const col = (i: number) => String.fromCharCode(65 + i);
  const sheet = `<worksheet><sheetData>${rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => `<c r="${col(ci)}${ri + 1}" t="s"><v>${idx(v)}</v></c>`).join("")}</row>`).join("")}</sheetData></worksheet>`;
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const files = {
    "xl/workbook.xml": `<workbook xmlns:r="r"><sheets><sheet name="Nodal Officers" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
    "xl/worksheets/sheet1.xml": sheet,
    "xl/sharedStrings.xml": `<sst>${strings.map((s) => `<si><t>${esc(s)}</t></si>`).join("")}</sst>`,
  };
  return buildZip(Object.entries(files).map(([name, t]) => ({ name, data: Buffer.from(t), modified: new Date() })));
}
const HEADER = ["S.No", "Service Type", "Provider Name", "Nodal Officer Name", "Provider Email", "Phone Number", "Provider Address", "Record ID", "Created At"];

beforeAll(async () => {
  await seedDemo(db, { anchor: "2026-11-09" });
}, 240000);

describe("importing a prepared knowledge base", () => {
  it("reads the front-matter, the kind of document and its sections", () => {
    expect(parseFrontMatter(SOP).meta).toMatchObject({ title: "Demo SOP for Freezing and Unfreezing Accounts", tags: ["freeze", "unfreeze", "lien", "demo"] });
    const p = prepareMarkdownDocument("07 - Demo Freeze SOP.pdf.md", SOP);
    expect(p.meta).toMatchObject({ category: "SOP", docNumber: "ID.No. 9/DEMO/2026", version: "05.03.2026", effectiveFrom: "2026-03-05", issuingBody: "Demo Cyber Bureau" });
    expect(p.meta.reviewNote).toMatch(/scanned pages/);
    expect(p.sections.map((s) => [s.sectionRef, s.heading])).toEqual([
      ["§1", "Source description"],
      ["§2", "When an account may be unfrozen"],
      ["§3", "Key facts for retrieval"],
    ]);
    expect(p.sections[1]!.text).toContain("1. An unfreeze needs the written order");
    const v = prepareMarkdownDocument("08 - Demo video.mp4.md", VIDEO);
    expect(v.meta.category).toBe("OTHER");
    expect(v.meta.reviewNote).toMatch(/training video/);
  });

  it("publishes new documents, skips unchanged ones, and is answered from", async () => {
    const dev = await user("developer");
    const files = [
      { fileName: "00 - INDEX.md", buffer: Buffer.from("# Index") },
      { fileName: "07 - Demo Freeze SOP.pdf.md", buffer: Buffer.from(SOP) },
      { fileName: "08 - Demo video.mp4.md", buffer: Buffer.from(VIDEO) },
    ];
    await expect(importKnowledgeFolder(db, await user("supervisor"), files)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const first = await importKnowledgeFolder(db, dev, files, { retireIllustrative: true });
    expect(first.imported).toEqual(["07 - Demo Freeze SOP.pdf.md", "08 - Demo video.mp4.md"]);
    expect(first.skipped[0]!.file).toBe("00 - INDEX.md");
    expect(first.retired.length).toBeGreaterThan(0);
    expect((await importKnowledgeFolder(db, dev, files)).unchanged).toHaveLength(2);
    const changed = await importKnowledgeFolder(db, dev, [{ fileName: "07 - Demo Freeze SOP.pdf.md", buffer: Buffer.from(SOP.replace("three working days", "two working days")) }]);
    expect(changed.updated).toEqual(["07 - Demo Freeze SOP.pdf.md"]);
    const a = await askGuidance(db, await user("officer1"), "Who must approve an unfreeze of an account?", { generate: offline });
    expect(a.kind).toBe("ANSWER");
    expect(a.passages[0]).toMatchObject({ documentTitle: "Demo SOP for Freezing and Unfreezing Accounts", heading: "When an account may be unfrozen", status: "CURRENT" });
    expect(a.passages[0]!.text).toContain("two working days");
    expect(a.superseded.some((p) => p.text.includes("three working days"))).toBe(true);
  });
});

describe("the nodal officer list", () => {
  const book = workbook([
    HEADER,
    ["1", "Bank", "Demo Bank\nLtd.", "R. Example", "nodal@demobank.example.invalid, lea@demobank.example.invalid", "98480 12345", "", "rec-1", "2024-12-06 11:55:58"],
    ["2", "TSP", "Demo Telecom", "", "lea@demotel.example.invalid", "", "Hyderabad", "rec-2", "2024-12-06 11:55:58"],
    ["3", "", "", "", "", "", "", "rec-3", ""],
  ]);

  it("is imported by a supervisor or the developer, refreshed by record ID, and kept apart from recipients", async () => {
    await expect(importNodalWorkbook(db, await user("officer1"), { fileName: "n.xlsx", buffer: book })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await importNodalWorkbook(db, await user("developer"), { fileName: "n.xlsx", buffer: book })).toMatchObject({ added: 2, updated: 0, skipped: 1 });
    expect(await importNodalWorkbook(db, await user("supervisor"), { fileName: "n.xlsx", buffer: book })).toMatchObject({ added: 0, updated: 2 });
    await expect(importNodalWorkbook(db, await user("supervisor"), { fileName: "x.xlsx", buffer: buildZip([{ name: "a.txt", data: Buffer.from("x"), modified: new Date() }]) })).rejects.toThrow();
    expect(providerKey("Demo Bank\nLtd.")).toBe("demo bank");
    const found = await listNodal(db, await user("officer1"), { q: "demo bank" });
    expect(found.rows[0]).toMatchObject({ provider: "Demo Bank Ltd.", officerName: "R. Example", emails: ["nodal@demobank.example.invalid", "lea@demobank.example.invalid"], phones: ["9848012345"] });
    expect((await nodalFor(db, "Demo Bank")).length).toBe(1);
  });

  it("lets only a supervisor add one of a contact's addresses to the directory, unverified", async () => {
    const contact = (await listNodal(db, await user("supervisor"), { q: "demo telecom" })).rows[0]!;
    await expect(addRecipientFromNodal(db, await user("officer1"), { contactId: contact.id, email: contact.emails[0]! })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(addRecipientFromNodal(db, await user("supervisor"), { contactId: contact.id, email: "someone@else.example.invalid" })).rejects.toMatchObject({ code: "VALIDATION" });
    const { id } = await addRecipientFromNodal(db, await user("supervisor"), { contactId: contact.id, email: contact.emails[0]! });
    expect(await db.recipient.findUnique({ where: { id } })).toMatchObject({ organisation: "Demo Telecom", organisationType: "TELECOM", verificationStatus: "UNVERIFIED", channel: "EMAIL" });
    await expect(addRecipientFromNodal(db, await user("supervisor"), { contactId: contact.id, email: contact.emails[0]! })).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
