import { beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@/server/db";
import { seedDemo } from "@/server/seed";
import type { SessionUser } from "@/server/auth/session";
import { createCase } from "@/server/services/cases";
import { withAutoDraft } from "@/server/services/auto-draft";
import { importNodalWorkbook } from "@/server/services/nodal";
import { prepareDraftFromTask } from "@/server/services/drafting";
import { commitMailDraft, createOfficerMail, discardOfficerMail, getMailView, getNewMailView, saveMailDraft, sendMailNow } from "@/server/services/mail-window";
import { getRequestsView } from "@/server/services/requests-view";
import { uploadEvidence } from "@/server/services/evidence";
import { approveForSending } from "@/server/services/requests";
import { requestLetter } from "@/server/services/letters";
import { buildZip } from "@/server/documents/zip";
import type { GmailApi, RemoteDraft } from "@/server/gmail/api";
import { AppError } from "@/server/errors";
import { useGmail } from "../support/delivery-config";

/**
 * The mail window: a request's To, subject, text, items and files edited in place and saved as typed; Send checks
 * every field and names the wrong ones; a mail an officer writes from New mail. A Gmail kept in memory stands in for
 * Google. Synthetic values only.
 */
const db = getDb();
async function user(username: string): Promise<SessionUser> {
  const u = await db.user.findUniqueOrThrow({ where: { username }, include: { station: true } });
  return { id: u.id, username, displayName: u.displayName, rank: u.rank, role: u.role as SessionUser["role"], stationId: u.stationId, stationCode: u.station.code, stationName: u.station.name };
}
function fakeGmail() {
  let n = 0;
  const drafts = new Map<string, RemoteDraft>();
  const sent: { to: string; subject: string }[] = [];
  const deleted: string[] = [];
  const head = (raw: string, k: string) => new RegExp(`^${k}: (.*)$`, "m").exec(raw.split("\r\n\r\n")[0]!)?.[1] ?? "";
  const api: GmailApi = {
    async createDraft(raw) {
      const d = { draftId: `d${++n}`, messageId: `m${++n}`, savedAt: Date.now(), to: head(raw, "To"), subject: head(raw, "Subject"), text: "" };
      drafts.set(d.draftId, d);
      return { draftId: d.draftId, messageId: d.messageId };
    },
    async updateDraft(id, raw) {
      const d = { draftId: id, messageId: `m${++n}`, savedAt: Date.now(), to: head(raw, "To"), subject: head(raw, "Subject"), text: "" };
      drafts.set(id, d);
      return { draftId: id, messageId: d.messageId };
    },
    async getDraft(id) {
      return drafts.get(id) ?? null;
    },
    async sendDraft(id) {
      const d = drafts.get(id)!;
      drafts.delete(id);
      sent.push({ to: d.to, subject: d.subject });
      return { messageId: `s${++n}`, threadId: `thread-${n}` };
    },
    async profile() {
      return { emailAddress: "station.test@example.invalid" };
    },
    async deleteDraft(id) {
      deleted.push(id);
      return drafts.delete(id);
    },
  };
  return { api, sent, deleted };
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
    }).map(([name, t]) => ({ name, data: Buffer.from(t), modified: new Date() })),
  );
}
const fields = async (requestId: string) => {
  const r = await db.request.findUniqueOrThrow({ where: { id: requestId } });
  const v = await db.requestVersion.findUniqueOrThrow({ where: { requestId_versionNo: { requestId, versionNo: r.currentVersionNo } } });
  return { r, v };
};
const failure = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    return err as AppError;
  }
  throw new Error("expected it to fail");
};

let caseId = "";
let me: SessionUser;
const ids: Record<string, string> = {};
const g = fakeGmail();

beforeAll(async () => {
  useGmail("station.test@example.invalid", { gmail: { senderApproves: true } });
  await seedDemo(db, { anchor: "2026-11-09" });
  const sup = await user("supervisor");
  await importNodalWorkbook(db, sup, {
    fileName: "nodal.xlsx",
    buffer: workbook([
      ["S.No", "Service Type", "Provider Name", "Nodal Officer Name", "Provider Email", "Phone Number", "Provider Address", "Record ID", "Created At"],
      ["1", "Website", "Google India", "", "lis@google.example.invalid", "", "", "t-5", "2024-12-06 11:55:58"],
    ]),
  });
  me = await user("officer1");
  const { result } = await withAutoDraft(db, me, async (c: { id: string }) => c.id, () =>
    createCase(db, me, {
      referenceType: "FIR",
      firNumber: "1601",
      firYear: "2026",
      investigatingOfficerId: me.id,
      title: "Job fraud",
      incidentStart: "2026-11-01T10:00",
      reportedAt: "2026-11-05T10:00",
      legalSections: "BNS 318(4)",
      parties: [{ name: "Test Complainant", role: "VICTIM", lossRupees: "50,000" }],
      identifiers: [
        { kind: "EMAIL", value: "fraud.desk@gmail.com", role: "Email used by the alleged fraudster" },
        { kind: "EMAIL", value: "hr.desk@mail.com", role: "Email used by the alleged fraudster" },
      ],
    }),
  );
  caseId = result.id;
  for (const e of await db.entity.findMany({ where: { caseId } })) ids[e.value] = e.id;
}, 240000);

describe("an email address is asked for its details, never frozen", () => {
  it("drafts a details request to the mail provider on the nodal list", async () => {
    const t = await db.task.findFirstOrThrow({ where: { caseId, dedupeKey: `DETAILS:${ids["fraud.desk@gmail.com"]}` } });
    expect(t.status).toBe("DRAFT_PREPARED");
    const r = await db.request.findUniqueOrThrow({ where: { id: t.requestId! }, include: { items: true, recipient: true } });
    expect(r.category).toBe("INFORMATION");
    expect(r.recipient.address).toBe("lis@google.example.invalid");
    expect(r.items.map((i) => i.itemType)).toEqual(["ACCOUNT_DETAILS", "IP_LOGS", "LINKED_CONTACTS", "PRESERVATION_CONFIRMATION"]);
    expect(await db.task.count({ where: { caseId, dedupeKey: { startsWith: "PRESERVE:" } } })).toBe(0);
    expect(await db.task.count({ where: { caseId, dedupeKey: { startsWith: "HOLD:" } } })).toBe(0);
  });
});

describe("the mail window", () => {
  let id = "";
  beforeAll(async () => {
    id = (await db.task.findFirstOrThrow({ where: { caseId, dedupeKey: `DETAILS:${ids["fraud.desk@gmail.com"]}` } })).requestId!;
  });
  const save = async (patch: Partial<{ to: string; subject: string; body: string; attachmentIds: string[]; keepItems: string[] | null; overwrite: boolean }>, base?: { version: number; key: string }) => {
    const v = await getMailView(db, me, id);
    return saveMailDraft(db, me, id, { expectedVersion: base?.version ?? v.version, baseKey: base?.key ?? v.key, to: v.to, subject: v.subject, body: v.body, attachmentIds: v.attachments.map((a) => a.id), keepItems: null, ...patch });
  };

  it("shows From as the linked Gmail account and offers the nodal address", async () => {
    const v = await getMailView(db, me, id);
    expect(v.editable).toBe(true);
    expect(v.from.address).toBe("station.test@example.invalid");
    expect(v.suggested.map((s) => s.address)).toContain("lis@google.example.invalid");
    expect(v.send.mode).toBe("SEND");
    expect(v.allItems).toHaveLength(4);
  });

  it("saves as typed into a working copy, and makes one version of it when the window closes", async () => {
    const before = await fields(id);
    const v0 = await getMailView(db, me, id);
    await save({ to: "lea.response@google.com", body: `${v0.body}\n\nP.S. first line` });
    await save({ body: `${v0.body}\n\nP.S. second line` });
    const mid = await fields(id);
    expect(mid.r.gmailTo).toBe("lea.response@google.com");
    expect(mid.r.currentVersionNo).toBe(before.r.currentVersionNo);
    expect((await getMailView(db, me, id)).body).toMatch(/second line$/);
    expect(await commitMailDraft(db, id, { by: me })).toEqual({ committed: true });
    const after = await fields(id);
    expect(after.r.currentVersionNo).toBe(before.r.currentVersionNo + 1);
    expect(after.r.liveJson).toBeNull();
    expect(after.v.body).toMatch(/second line$/);
    expect(after.v.createdById).toBe(me.id);
    expect(after.v.changeNote).toBe("Edited in the mail window");
    // Nothing more to make a version of.
    expect(await commitMailDraft(db, id, { by: me })).toEqual({ committed: false });
  });

  it("saves a half-written mail too (it is checked only when sent)", async () => {
    await save({ subject: "Hi", body: "Short" });
    const v = await getMailView(db, me, id);
    expect(v.body).toBe("Short");
    expect(v.subject).toBe("Hi");
  });

  it("refuses a save over someone else's change, but not over its own window's version being made", async () => {
    const v = await getMailView(db, me, id);
    await commitMailDraft(db, id, { by: me });
    // Only this window's own working copy became a version since: the same words, so the save goes through.
    const ok = await saveMailDraft(db, me, id, { expectedVersion: v.version, baseKey: v.key, to: v.to, subject: "Hello there", body: "Short", attachmentIds: [], keepItems: null });
    expect(ok.version).toBeGreaterThan(v.version);
    // A change made elsewhere (the words differ from what this window last saw): refused, unless kept on purpose.
    const err = await failure(saveMailDraft(db, me, id, { expectedVersion: v.version, baseKey: v.key, to: v.to, subject: "Hello again", body: "Short", attachmentIds: [], keepItems: null }));
    expect(err.code).toBe("CONFLICT");
    const kept = await saveMailDraft(db, me, id, { expectedVersion: v.version, baseKey: v.key, to: v.to, subject: "Hello again", body: "Short", attachmentIds: [], keepItems: null, overwrite: true });
    expect(kept.version).toBeGreaterThan(ok.version);
  });

  it("attaches only the case's own files", async () => {
    const other = await db.evidenceItem.findFirstOrThrow({ where: { caseId: { not: caseId } } });
    expect((await failure(save({ attachmentIds: [other.id] }))).code).toBe("VALIDATION");
  });

  it("names every wrong field on Send, and sends nothing", async () => {
    await save({ to: "", subject: "Hi", body: "Sir,\n\nTo [Google: to be filled in], kindly furnish the details.", attachmentIds: [], keepItems: [] });
    const v = await getMailView(db, me, id);
    const err = await failure(sendMailNow(db, me, id, { expectedVersion: v.version, baseKey: v.key, idempotencyKey: "k-invalid" }, g.api));
    expect(err.code).toBe("VALIDATION");
    expect(err.message).toBe("Invalid: To, Subject, Mail text, Asks for");
    expect(Object.keys(err.fieldErrors ?? {}).sort()).toEqual(["body", "items", "subject", "to"]);
    expect(g.sent).toHaveLength(0);
    expect((await fields(id)).r.status).toBe("DRAFT");
  });

  it("sends once every field is right, approving the version its author sends (station setting), and keeps the conversation", async () => {
    const v = await getMailView(db, me, id);
    const keep = v.allItems.slice(0, 2).map((i) => i.label);
    const body = `Sir/Madam,\n\nKindly furnish about fraud.desk@gmail.com:\n${keep.map((k) => `- ${k}`).join("\n")}\n\nKindly reply quoting ${v.reference}.`;
    const s = await save({ to: "lea.response@google.com, second.desk@google.com", subject: `FIR 1601/2026 · account details · ${v.reference}`, body, attachmentIds: [], keepItems: keep });
    const out = await sendMailNow(db, me, id, { expectedVersion: s.version, baseKey: s.key, idempotencyKey: "k-send" }, g.api);
    expect(out.outcome).toBe("SENT");
    expect(g.sent.at(-1)!.to).toBe("lea.response@google.com, second.desk@google.com");
    const after = await db.request.findUniqueOrThrow({ where: { id }, include: { items: { orderBy: { sortOrder: "asc" } } } });
    expect(after.status).toBe("SUBMITTED");
    expect(after.channel).toBe("EMAIL");
    expect(after.gmailThreadId).toMatch(/^thread-/);
    expect(after.liveJson).toBeNull();
    expect(after.items.map((i) => i.label)).toEqual(keep);
    expect(await db.auditEvent.count({ where: { objectId: id, action: "request.approved_by_sender" } })).toBe(1);
    const sentView = await getMailView(db, me, id);
    expect(sentView.editable).toBe(false);
    expect(sentView.sent?.to).toContain("lea.response@google.com");
  });
});

describe("a draft whose addressee was not known", () => {
  let id = "";
  beforeAll(async () => {
    const t = await db.task.findFirstOrThrow({ where: { caseId, dedupeKey: `DETAILS:${ids["hr.desk@mail.com"]}` } });
    id = t.requestId ?? (await prepareDraftFromTask(db, me, t.id, { withoutAddressee: true })).id;
  });

  it("without the sender-approves setting, a version's author passes it for approval instead", async () => {
    const v = await getMailView(db, me, id);
    await saveMailDraft(db, me, id, { expectedVersion: v.version, baseKey: v.key, to: "lea@mail-provider.in", subject: v.subject, body: `${v.body}\n\nP.S. officer's line`, attachmentIds: [], keepItems: null });
    await commitMailDraft(db, id, { by: me });
    const prior = process.env.T_CYBER_CONFIG!;
    useGmail("station.test@example.invalid", { gmail: { senderApproves: false } });
    try {
      expect((await getMailView(db, me, id)).send.mode).toBe("FOR_APPROVAL");
      const { r } = await fields(id);
      const res = await approveForSending(db, me, id, r.version);
      expect(res.approved).toBe(false);
      expect((await fields(id)).r.status).toBe("AWAITING_APPROVAL");
    } finally {
      process.env.T_CYBER_CONFIG = prior;
    }
  });

  it("is sent to the address typed once its blank line is filled in; its letter prints clean then", async () => {
    let v = await getMailView(db, me, id);
    expect(v.body).toMatch(/to be filled in/);
    let s = await saveMailDraft(db, me, id, { expectedVersion: v.version, baseKey: v.key, to: "lea@mail-provider.in", subject: v.subject, body: v.body, attachmentIds: [], keepItems: null });
    const err = await failure(sendMailNow(db, me, id, { expectedVersion: s.version, baseKey: s.key, idempotencyKey: "k-blank" }, g.api));
    expect(err.fieldErrors?.body).toMatch(/^Fill in \[/);
    expect((await requestLetter(db, me, id)).final).toBe(false);
    v = await getMailView(db, me, id);
    s = await saveMailDraft(db, me, id, { expectedVersion: v.version, baseKey: v.key, to: "lea@mail-provider.in", subject: v.subject, body: v.body.replace(/\[[^\]]*to be filled in\]/g, "Mail Provider Ltd"), attachmentIds: [], keepItems: null });
    // The letter prints what is typed, before it is made a version.
    const letter = await requestLetter(db, me, id);
    expect(letter.final).toBe(true);
    expect(letter.to).toContain("Email: lea@mail-provider.in");
    const out = await sendMailNow(db, me, id, { expectedVersion: s.version, baseKey: s.key, idempotencyKey: "k-filled" }, g.api);
    expect(out.outcome).toBe("SENT");
    expect(g.sent.at(-1)!.to).toBe("lea@mail-provider.in");
  });
});

describe("New mail", () => {
  it("keeps nothing until something is typed", async () => {
    const before = await db.request.count({ where: { caseId } });
    const v = await getNewMailView(db, me, caseId);
    expect(v).toMatchObject({ id: "", officerMail: true, editable: true, subject: "FIR 1601/2026 · " });
    expect(await db.request.count({ where: { caseId } })).toBe(before);
  });

  it("is made a request on its first save, its reference added to the subject, addressed to what is typed", async () => {
    const created = await createOfficerMail(db, me, caseId, { to: "Nodal <nodal@some-bank.in>", subject: "FIR 1601/2026 · KYC of an account", body: "Sir/Madam,\n\nKindly furnish the KYC.", attachmentIds: [] });
    expect(created.subject).toBe(`FIR 1601/2026 · KYC of an account · ${created.reference}`);
    const r = await db.request.findUniqueOrThrow({ where: { id: created.requestId }, include: { recipient: true } });
    expect(r.writtenByOfficer).toBe(true);
    expect(r.recipient).toMatchObject({ organisationType: "TYPED", address: "nodal@some-bank.in", organisation: "nodal@some-bank.in" });
    // The window carries on from the key it was given.
    const s = await saveMailDraft(db, me, created.requestId, { expectedVersion: created.version, baseKey: created.key, to: "Nodal <nodal@some-bank.in>", subject: created.subject, body: "Sir/Madam,\n\nKindly furnish the KYC and the statement.", attachmentIds: [], keepItems: null });
    expect(s.version).toBeGreaterThan(created.version);
  });

  it("can be discarded before it is sent: kept on record, listed nowhere", async () => {
    const created = await createOfficerMail(db, me, caseId, { to: "", subject: "FIR 1601/2026 · draft to drop", body: "Sir/Madam,\n\nNot needed after all.", attachmentIds: [] });
    expect((await getRequestsView(db, me, caseId)).rows.some((x) => x.id === created.requestId)).toBe(true);
    expect(await discardOfficerMail(db, me, created.requestId, g.api)).toEqual({ discarded: true });
    expect((await db.request.findUniqueOrThrow({ where: { id: created.requestId } })).status).toBe("DISCARDED");
    expect((await getRequestsView(db, me, caseId)).rows.some((x) => x.id === created.requestId)).toBe(false);
    expect(await db.auditEvent.count({ where: { objectId: created.requestId, action: "request.mail_discarded" } })).toBe(1);
  });

  it("is sent like any request, and a request the rules proposed cannot be discarded", async () => {
    const file = await uploadEvidence(db, me, caseId, { fileName: "note.txt", buffer: Buffer.from("A synthetic note for the test.\n"), title: "Officer's note", category: "OTHER", sourceDescription: "Written for the test", receivedAt: new Date() }, { runExtraction: false });
    const created = await createOfficerMail(db, me, caseId, { to: "desk@some-telecom.in", subject: "FIR 1601/2026 · CAF of a number", body: "Sir/Madam,\n\nKindly furnish the CAF of the number in the FIR.", attachmentIds: [file.id] });
    const out = await sendMailNow(db, me, created.requestId, { expectedVersion: created.version, baseKey: created.key, idempotencyKey: "k-new" }, g.api);
    expect(out.outcome).toBe("SENT");
    expect((await db.request.findUniqueOrThrow({ where: { id: created.requestId } })).status).toBe("SUBMITTED");
    const proposed = (await db.task.findFirstOrThrow({ where: { caseId, dedupeKey: `DETAILS:${ids["fraud.desk@gmail.com"]}` } })).requestId!;
    expect((await failure(discardOfficerMail(db, me, proposed, g.api))).code).toBe("PRECONDITION");
  });
});
