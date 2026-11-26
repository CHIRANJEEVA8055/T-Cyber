import { beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@/server/db";
import { seedDemo } from "@/server/seed";
import type { SessionUser } from "@/server/auth/session";
import { createCase } from "@/server/services/cases";
import { withAutoDraft } from "@/server/services/auto-draft";
import { importNodalWorkbook } from "@/server/services/nodal";
import { getNextActions } from "@/server/services/next-actions";
import { updateIdentifierNotes } from "@/server/services/people";
import { addManualTransaction } from "@/server/services/funds";
import { prepareDraftFromTask } from "@/server/services/drafting";
import { draftGapFor } from "@/server/services/draft-gaps";
import { approveAndSend, requestApproval } from "@/server/services/requests";
import { downloadLetter } from "@/server/services/letters";
import { listDirectory } from "@/server/services/settings";
import { parseDocument } from "@/server/documents/parse";
import { buildZip } from "@/server/documents/zip";

/**
 * A request whose addressee cannot be found yet (the bank of a beneficiary account, the mail host of a domain): the
 * officer is told what is missing and how to find it from the case's own details, can draft it now with the
 * addressee left blank (to edit and print, never to approve or send), and the draft is addressed in place once the
 * detail is recorded. Synthetic values only.
 */
const db = getDb();
async function user(username: string): Promise<SessionUser> {
  const u = await db.user.findUniqueOrThrow({ where: { username }, include: { station: true } });
  return { id: u.id, username, displayName: u.displayName, rank: u.rank, role: u.role as SessionUser["role"], stationId: u.stationId, stationCode: u.station.code, stationName: u.station.name };
}
const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
function workbook(rows: string[][]): Buffer {
  const strings: string[] = [];
  const idx = (s: string) => (strings.includes(s) ? strings.indexOf(s) : strings.push(s) - 1);
  const sheet = `<worksheet><sheetData>${rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => `<c r="${String.fromCharCode(65 + ci)}${ri + 1}" t="s"><v>${idx(v)}</v></c>`).join("")}</row>`).join("")}</sheetData></worksheet>`;
  return buildZip(
    Object.entries({
      "xl/workbook.xml": `<workbook xmlns:r="r"><sheets><sheet name="Nodal Officers" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
      "xl/worksheets/sheet1.xml": sheet,
      "xl/sharedStrings.xml": `<sst>${strings.map((s) => `<si><t>${xml(s)}</t></si>`).join("")}</sst>`,
    }).map(([n, t]) => ({ name: n, data: Buffer.from(t), modified: new Date() })),
  );
}

let caseId = "";
const ids: Record<string, string> = {};
const holdTask = () => db.task.findFirstOrThrow({ where: { caseId, dedupeKey: `HOLD:${ids["50100099990001"]}` } });

beforeAll(async () => {
  await seedDemo(db, { anchor: "2026-11-09" });
  await importNodalWorkbook(db, await user("supervisor"), {
    fileName: "nodal.xlsx",
    buffer: workbook([
      ["S.No", "Service Type", "Provider Name", "Nodal Officer Name", "Provider Email", "Phone Number", "Provider Address", "Record ID", "Created At"],
      ["1", "Bank", "HDFC BANK LTD", "A. Nodal", "lea.cell@hdfcbank.example.invalid", "", "", "g-1", "2024-12-06 11:55:58"],
      ["2", "Bank", "Kotak Mahindra Bank", "B. Nodal", "nodal@kotak.example.invalid", "", "", "g-2", "2024-12-06 11:55:58"],
    ]),
  });
  const me = await user("officer1");
  const kase = await createCase(db, me, {
    referenceType: "FIR",
    firNumber: "1601",
    firYear: "2026",
    complaintRef: "31234567890123",
    investigatingOfficerId: me.id,
    title: "Investment fraud",
    reportedAt: "2026-11-05T10:00",
    parties: [{ name: "Test Complainant", role: "VICTIM", lossRupees: "80,000" }],
    identifiers: [
      { kind: "BANK_ACCOUNT", value: "50100099990001", role: "Reported beneficiary account" },
      { kind: "BANK_ACCOUNT", value: "073600000001", role: "Complainant's own account", bank: "Kotak Mahindra Bank" },
      { kind: "EMAIL", value: "desk@corp-mail.example.invalid", role: "Email used by the alleged fraudster" },
    ],
  });
  caseId = kase.id;
  for (const e of await db.entity.findMany({ where: { caseId } })) ids[e.value] = e.id;
  const claim = await db.victimClaim.findFirstOrThrow({ where: { caseId } });
  await addManualTransaction(db, me, caseId, { fromEntityId: ids["073600000001"]!, toEntityId: ids["50100099990001"]!, amountRupees: "80,000", occurredAt: "2026-11-02T11:15", channel: "IMPS", reference: "IMPS4321000001", kind: "VICTIM_PAYMENT", claimId: claim.id, sourceNote: "test" });
}, 240000);

describe("a request whose addressee is not known yet", () => {
  it("says what is missing and how to find it, from the case's own details", async () => {
    const view = await getNextActions(db, await user("officer1"), caseId);
    const holdId = (await holdTask()).id;
    const hold = view.actions.find((a) => a.taskId === holdId)!;
    expect(hold.kind).toBe("BLOCKED");
    expect(hold.gap).toMatchObject({ kind: "BANK", missing: "The bank of account 50100099990001 is not recorded.", canDraftWithout: true, record: { field: "bank", entityId: ids["50100099990001"] } });
    const steps = hold.gap!.steps.map((s) => s.text).join("\n");
    expect(steps).toContain("₹80,000 on 02 Nov 2026 (reference IMPS4321000001)");
    expect(steps).toMatch(/Kotak Mahindra Bank/);
    expect(steps).toContain("The NCRP complaint 31234567890123");
    const mail = view.actions.find((a) => a.title.includes("desk@corp-mail.example.invalid"))!;
    expect(mail.gap).toMatchObject({ kind: "MAIL_PROVIDER", record: { field: "provider" } });
    expect(mail.gap!.steps[0]!.text).toContain("nslookup -type=mx corp-mail.example.invalid");
  });

  it("is drafted in full with the addressee left blank, to edit and print, never to approve or send", async () => {
    const me = await user("officer1");
    const t = await holdTask();
    // Without being asked to, it is not drafted: the officer is told what is missing.
    await expect(prepareDraftFromTask(db, me, t.id, { asAssistant: true })).rejects.toMatchObject({ code: "PRECONDITION", message: expect.stringContaining("The bank of account 50100099990001 is not recorded.") });
    const r = await prepareDraftFromTask(db, me, t.id, { asAssistant: true, withoutAddressee: true });
    const req = await db.request.findUniqueOrThrow({ where: { id: r.id }, include: { recipient: true } });
    expect(req.recipient).toMatchObject({ organisationType: "UNADDRESSED", active: false });
    expect(r.body).toContain("To the Nodal Officer, [the bank holding account 50100099990001: to be filled in]");
    expect(r.body).toContain("₹80,000 was paid on 02 Nov 2026 (ref IMPS4321000001)");
    expect(await db.auditEvent.count({ where: { objectId: r.id, action: "request.drafted_without_addressee" } })).toBe(1);
    // Asking again returns the same draft.
    expect((await prepareDraftFromTask(db, me, t.id, { asAssistant: true, withoutAddressee: true })).id).toBe(r.id);

    const view = await getNextActions(db, me, caseId);
    const a = view.actions.find((x) => x.request?.id === r.id)!;
    expect(a).toMatchObject({ kind: "DRAFT", status: { text: "No addressee yet" } });
    expect(a.title).toContain("the bank holding account 50100099990001");
    expect(a.request).toMatchObject({ canApproveAndSend: false, unaddressed: { addressee: "the bank holding account 50100099990001", gap: { kind: "BANK" } } });

    await expect(requestApproval(db, me, r.id, req.version)).rejects.toMatchObject({ code: "PRECONDITION", message: expect.stringContaining("no addressee yet") });
    await expect(approveAndSend(db, await user("supervisor"), r.id, { expectedVersion: req.version, idempotencyKey: "gap-test-1" })).rejects.toMatchObject({ code: "PRECONDITION" });
    expect((await db.request.findUniqueOrThrow({ where: { id: r.id } })).status).toBe("DRAFT");

    const letter = (await parseDocument((await downloadLetter(db, me, r.id, "pdf")).buffer, "application/pdf")).segments.map((s) => s.text).join("\n");
    expect(letter).toContain("[the bank holding account 50100099990001: to be filled in]");
    expect(letter).not.toContain("addressee-not-known");
    // The stand-in is not a directory entry anyone sees or sends to.
    expect((await listDirectory(db, await user("supervisor"))).some((x) => x.organisation === "Addressee not yet known")).toBe(false);
  });

  it("is addressed in place as soon as the IFSC is recorded, keeping its reference", async () => {
    const me = await user("officer1");
    const before = await db.request.findUniqueOrThrow({ where: { id: (await holdTask()).requestId! } });
    const { autoDraft } = await withAutoDraft(db, me, async (e: { caseId: string }) => e.caseId, () => updateIdentifierNotes(db, me, ids["50100099990001"]!, { ifsc: "HDFC0001234" }));
    expect(autoDraft?.references).toContain(before.reference);
    const after = await db.request.findUniqueOrThrow({ where: { id: before.id }, include: { recipient: true, versions: { orderBy: { versionNo: "desc" }, take: 1 } } });
    expect(after.recipient).toMatchObject({ organisation: "HDFC Bank", address: "lea.cell@hdfcbank.example.invalid" });
    expect(after.reference).toBe(before.reference);
    expect(after.versions[0]!.body).toContain("To the Nodal Officer, HDFC Bank");
    expect(after.versions[0]!.body).not.toContain("to be filled in");
    expect(after.needsReview).toBe(false);
    const a = (await getNextActions(db, me, caseId)).actions.find((x) => x.request?.id === before.id)!;
    expect(a.request?.unaddressed).toBeNull();
  });
});

describe("guidance written from what the case holds", () => {
  it("asks for the receipt when no payment to the account is recorded, and never claims an NCRP number it does not have", () => {
    const g = draftGapFor("BANK", { caseId: "c1", category: "HOLD", subject: { id: "e1", kind: "BANK_ACCOUNT", value: "123456789012", label: "Account X" }, incoming: [], victimBanks: [], victimDebitsAction: null, hasFirCopy: false, complaintRef: null });
    const text = g.steps.map((s) => s.text).join("\n");
    expect(text).toContain("Ask the complainant for the receipt or app screenshot of the payment to 123456789012");
    expect(text).toContain("If the complaint came through 1930 or NCRP");
    expect(g.steps[0]!.link?.label).toBe("Upload the FIR or receipts");
    expect(g.message).toMatch(/^Not addressed yet: The bank of account 123456789012 is not recorded\. It can be drafted now/);
  });

  it("asks the complainant about their own account, instead of treating it as a beneficiary", () => {
    const g = draftGapFor("BANK", { caseId: "c1", category: "INFORMATION", subject: { id: "e2", kind: "BANK_ACCOUNT", value: "073600009002", label: "Own account" }, subjectIsVictims: true, incoming: [], victimBanks: [], victimDebitsAction: null, hasFirCopy: true, complaintRef: null });
    expect(g.missing).toBe("The bank of the complainant's account 073600009002 is not recorded.");
    const text = g.steps.map((s) => s.text).join("\n");
    expect(text).toContain("Ask the complainant which bank holds account 073600009002");
    expect(text).not.toMatch(/payment to 073600009002|beneficiary/);
  });

  it("cannot draft without an identifier, and says so", () => {
    const g = draftGapFor("NO_SUBJECT", { caseId: "c1", category: "INFORMATION", subject: null, incoming: [], victimBanks: [], victimDebitsAction: null, hasFirCopy: true, complaintRef: null });
    expect(g).toMatchObject({ canDraftWithout: false, message: "This action has no identifier to address the request to." });
  });
});
