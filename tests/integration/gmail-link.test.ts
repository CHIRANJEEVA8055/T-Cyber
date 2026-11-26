import { beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@/server/db";
import { seedDemo } from "@/server/seed";
import type { SessionUser } from "@/server/auth/session";
import { approveAndSend, parseToList, sendViaGmail, submitRequest, updateDraft } from "@/server/services/requests";
import { isGmailRateLimit, syncAllWithGmail, syncRequestWithGmail } from "@/server/gmail/sync";
import type { GmailApi, RemoteDraft } from "@/server/gmail/api";
import { useGmail } from "../support/delivery-config";

/**
 * The Gmail link (prototype): each unsent request has a draft in the linked Gmail account; edits go both ways; an
 * approved request is sent from Gmail to the address the officer types. An in-memory Gmail stands in for Google.
 */
const db = getDb();
async function user(username: string): Promise<SessionUser> {
  const u = await db.user.findUniqueOrThrow({ where: { username }, include: { station: true } });
  return { id: u.id, username, displayName: u.displayName, rank: u.rank, role: u.role as SessionUser["role"], stationId: u.stationId, stationCode: u.station.code, stationName: u.station.name };
}

/** A Gmail that keeps drafts in memory; editInGmail() plays an officer editing a draft in Gmail. */
function fakeGmail() {
  let n = 0;
  const drafts = new Map<string, RemoteDraft>();
  const sent: { draftId: string; to: string; subject: string; text: string }[] = [];
  const parse = (raw: string) => {
    const [head, ...rest] = raw.split("\r\n\r\n");
    const h = (k: string) => new RegExp(`^${k}: (.*)$`, "m").exec(head!)?.[1] ?? "";
    const subj = h("Subject").replace(/=\?UTF-8\?B\?([^?]+)\?=/g, (_, b: string) => Buffer.from(b, "base64").toString("utf8"));
    const body = rest.join("\r\n\r\n");
    const b64 = /Content-Transfer-Encoding: base64\r\n\r\n([\s\S]*?)(?:\r\n--|\r\n$|$)/.exec(raw)?.[1] ?? body;
    return { to: h("To"), subject: subj, text: Buffer.from(b64.replace(/\s+/g, ""), "base64").toString("utf8").replace(/\r\n/g, "\n") };
  };
  const api: GmailApi = {
    async createDraft(raw) {
      const d = { draftId: `d${++n}`, messageId: `m${++n}`, savedAt: Date.now(), ...parse(raw) };
      drafts.set(d.draftId, d);
      return { draftId: d.draftId, messageId: d.messageId };
    },
    async updateDraft(id, raw) {
      if (!drafts.has(id)) throw new Error("The Gmail draft is no longer in Drafts.");
      const d = { draftId: id, messageId: `m${++n}`, savedAt: Date.now(), ...parse(raw) };
      drafts.set(id, d);
      return { draftId: id, messageId: d.messageId };
    },
    async getDraft(id) {
      return drafts.get(id) ?? null;
    },
    async sendDraft(id) {
      const d = drafts.get(id);
      if (!d) throw new Error("The Gmail draft is no longer in Drafts.");
      drafts.delete(id);
      sent.push({ draftId: id, to: d.to, subject: d.subject, text: d.text });
      return { messageId: `s${++n}`, threadId: "t1" };
    },
    async profile() {
      return { emailAddress: "station.test@example.invalid" };
    },
  };
  const editInGmail = (id: string, change: Partial<Pick<RemoteDraft, "to" | "subject" | "text">>) => {
    const d = drafts.get(id)!;
    drafts.set(id, { ...d, ...change, messageId: `m${++n}`, savedAt: Date.now() + 1000 });
  };
  return { api, drafts, sent, editInGmail, remove: (id: string) => drafts.delete(id) };
}

let fir412 = "";
const g = fakeGmail();
const drafts = async () => {
  const sup = await db.user.findUniqueOrThrow({ where: { username: "supervisor" } });
  const all = await db.request.findMany({ where: { caseId: fir412, status: "DRAFT", recipient: { organisationType: { not: "UNADDRESSED" } } }, include: { versions: { orderBy: { versionNo: "desc" }, take: 1 }, items: true }, orderBy: { reference: "asc" } });
  return all.filter((r) => r.versions[0]!.createdById !== sup.id && r.channel !== "PORTAL");
};

beforeAll(async () => {
  useGmail();
  fir412 = (await seedDemo(db, { anchor: "2026-11-09" })).fir412Id;
}, 240000);

describe("every unsent request has a draft in Gmail", () => {
  it("stops a pass when Gmail says it gets too many calls, marking no draft as failed, and carries on next pass", async () => {
    let calls = 0;
    const busy: GmailApi = { ...g.api, async createDraft(raw) {
      if (++calls > 2) throw new Error("Gmail answered 403: Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user'.");
      return g.api.createDraft(raw);
    } };
    const r = await syncAllWithGmail(db, busy);
    expect(r).toMatchObject({ created: 2, failed: 0 });
    expect(r.deferred).toBeGreaterThan(0);
    expect(await db.request.count({ where: { gmailError: { not: null } } })).toBe(0);
    expect(isGmailRateLimit(new Error("Gmail answered 400: Invalid To header."))).toBe(false);
  });

  it("saves each unsent request as a Gmail draft, and does nothing more when nothing changed", async () => {
    const first = await syncAllWithGmail(db, g.api);
    expect(first.created).toBeGreaterThan(0);
    expect(first.failed + first.deferred).toBe(0);
    const req = (await drafts())[0]!;
    const linked = await db.request.findUniqueOrThrow({ where: { id: req.id }, include: { recipient: true } });
    const d = g.drafts.get(linked.gmailDraftId!)!;
    expect(d.subject).toBe(req.versions[0]!.subject);
    expect(d.text.trim()).toBe(req.versions[0]!.body.trim());
    expect(d.to).toBe(linked.recipient.address);
    const again = await syncAllWithGmail(db, g.api);
    expect(again.created + again.pushed + again.pulled).toBe(0);
    expect(fir412).not.toBe("");
  });

  it("carries an edit made in T-CYBER to the Gmail draft", async () => {
    const req = (await drafts())[0]!;
    const v = req.versions[0]!;
    await updateDraft(db, await user("officer1"), req.id, { expectedVersion: req.version, recipientId: req.recipientId, subject: v.subject, body: `${v.body}\n\nEdited in T-CYBER.`, scope: v.scope, periodFrom: v.periodFrom, periodTo: v.periodTo, items: req.items.map((i) => ({ label: i.label, itemType: i.itemType })), attachmentIds: JSON.parse(v.attachmentIdsJson) as string[] });
    expect(await syncRequestWithGmail(db, req.id, g.api)).toBe("pushed");
    const r = await db.request.findUniqueOrThrow({ where: { id: req.id } });
    expect(g.drafts.get(r.gmailDraftId!)!.text).toContain("Edited in T-CYBER.");
  });

  it("brings an edit made in Gmail into T-CYBER as a new version, and keeps a changed To", async () => {
    const req = (await drafts())[0]!;
    const r = await db.request.findUniqueOrThrow({ where: { id: req.id } });
    const before = r.currentVersionNo;
    g.editInGmail(r.gmailDraftId!, { text: `${g.drafts.get(r.gmailDraftId!)!.text}\nAdded in Gmail.`, to: "Nodal Officer <nodal.officer@bank.example.invalid>" });
    expect(await syncRequestWithGmail(db, req.id, g.api)).toBe("pulled");
    const after = await db.request.findUniqueOrThrow({ where: { id: req.id }, include: { versions: { orderBy: { versionNo: "desc" }, take: 1 } } });
    expect(after.currentVersionNo).toBe(before + 1);
    expect(after.versions[0]!.body).toContain("Added in Gmail.");
    expect(after.versions[0]!.changeNote).toMatch(/^Edited in Gmail/);
    expect(after.gmailTo).toBe("nodal.officer@bank.example.invalid");
    // Pulled once; the next pass finds both sides the same.
    expect(await syncRequestWithGmail(db, req.id, g.api)).toBe("unchanged");
  });

  it("does not create a version when Gmail only re-wrapped the lines", async () => {
    const req = (await drafts())[0]!;
    const r = await db.request.findUniqueOrThrow({ where: { id: req.id } });
    const d = g.drafts.get(r.gmailDraftId!)!;
    g.editInGmail(r.gmailDraftId!, { text: d.text.replace(/ /g, "\n").replace(/\n\n/g, "\n \n") });
    await syncRequestWithGmail(db, req.id, g.api);
    expect((await db.request.findUniqueOrThrow({ where: { id: req.id } })).currentVersionNo).toBe(r.currentVersionNo);
    expect(await syncRequestWithGmail(db, req.id, g.api)).toBe("unchanged");
  });

  it("says so when the draft was deleted in Gmail, instead of quietly making it again", async () => {
    const req = (await drafts())[1]!;
    const r = await db.request.findUniqueOrThrow({ where: { id: req.id } });
    g.remove(r.gmailDraftId!);
    expect(await syncRequestWithGmail(db, req.id, g.api)).toBe("missing");
    expect((await db.request.findUniqueOrThrow({ where: { id: req.id } })).gmailError).toMatch(/no longer in Gmail's Drafts/);
    expect(await syncRequestWithGmail(db, req.id, g.api, { recreate: true })).toBe("created");
    expect((await db.request.findUniqueOrThrow({ where: { id: req.id } })).gmailError).toBeNull();
  });
});

describe("sending from Gmail", () => {
  it("never sends an unapproved draft, and approval alone sends nothing", async () => {
    const req = (await drafts())[0]!;
    await expect(sendViaGmail(db, await user("supervisor"), req.id, { expectedVersion: req.version, to: "nodal@bank.example.invalid", idempotencyKey: "g-0" }, g.api)).rejects.toMatchObject({ code: "PRECONDITION" });
    const out = await approveAndSend(db, await user("supervisor"), req.id, { expectedVersion: req.version, idempotencyKey: "g-approve" });
    expect(out).toMatchObject({ outcome: "APPROVED_GMAIL" });
    expect(g.sent).toHaveLength(0);
    expect((await db.request.findUniqueOrThrow({ where: { id: req.id } })).status).toBe("APPROVED");
    await expect(submitRequest(db, await user("supervisor"), req.id, { expectedVersion: (await db.request.findUniqueOrThrow({ where: { id: req.id } })).version, confirmed: true, idempotencyKey: "g-sim" })).rejects.toMatchObject({ code: "PRECONDITION" });
  });

  it("checks the typed address", () => {
    expect(() => parseToList("")).toThrow(/Type the address/);
    expect(() => parseToList("not-an-address")).toThrow(/not an email address/);
    expect(parseToList("A@Bank.example.invalid; b@bank.example.invalid, a@bank.example.invalid")).toEqual(["a@bank.example.invalid", "b@bank.example.invalid"]);
  });

  it("refuses to send when the draft was edited in Gmail after approval, and brings the edit in", async () => {
    const req = await db.request.findFirstOrThrow({ where: { status: "APPROVED", gmailDraftId: { not: null }, case: { isDemo: true } } });
    g.editInGmail(req.gmailDraftId!, { text: `${g.drafts.get(req.gmailDraftId!)!.text}\nLate change in Gmail.` });
    await expect(sendViaGmail(db, await user("supervisor"), req.id, { expectedVersion: req.version, to: "nodal@bank.example.invalid", idempotencyKey: "g-1" }, g.api)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(g.sent).toHaveLength(0);
    const after = await db.request.findUniqueOrThrow({ where: { id: req.id } });
    expect(after.status).toBe("DRAFT");
  });

  it("sends the approved version from Gmail to the typed address and records it as sent", async () => {
    const req = (await drafts()).find((r) => r.id !== undefined)!;
    const sup = await user("supervisor");
    await approveAndSend(db, sup, req.id, { expectedVersion: req.version, idempotencyKey: "g-approve-2" });
    const approved = await db.request.findUniqueOrThrow({ where: { id: req.id }, include: { versions: { orderBy: { versionNo: "desc" }, take: 1 } } });
    const out = await sendViaGmail(db, sup, req.id, { expectedVersion: approved.version, to: "Nodal.Officer@bank.example.invalid", idempotencyKey: "g-2" }, g.api);
    expect(out).toMatchObject({ outcome: "SUCCEEDED" });
    // Gmail may keep a display name ("Nodal Officer <…>") the officer typed there; the address is what counts.
    expect(g.sent.at(-1)!.to).toContain("nodal.officer@bank.example.invalid");
    expect(g.sent.at(-1)!.subject).toBe(approved.versions[0]!.subject);
    const after = await db.request.findUniqueOrThrow({ where: { id: req.id } });
    expect(after).toMatchObject({ status: "SUBMITTED", gmailDraftId: null, gmailTo: "nodal.officer@bank.example.invalid" });
    expect(after.followUpAt).not.toBeNull();
    const sub = await db.submission.findFirstOrThrow({ where: { requestId: req.id }, orderBy: { attemptedAt: "desc" } });
    expect(sub.adapter).toBe("Sent from Gmail (station.test@example.invalid) to nodal.officer@bank.example.invalid");
    expect(await db.auditEvent.count({ where: { objectId: req.id, action: "request.sent_gmail" } })).toBe(1);
    // The same key again sends nothing new.
    const n = g.sent.length;
    expect(await sendViaGmail(db, sup, req.id, { expectedVersion: after.version, to: "nodal.officer@bank.example.invalid", idempotencyKey: "g-2" }, g.api)).toMatchObject({ outcome: "SUCCEEDED" });
    expect(g.sent).toHaveLength(n);
  });

  it("records a failure plainly when Gmail refuses, and nothing is marked sent", async () => {
    const req = (await drafts())[0]!;
    const sup = await user("supervisor");
    await approveAndSend(db, sup, req.id, { expectedVersion: req.version, idempotencyKey: "g-approve-3" });
    const approved = await db.request.findUniqueOrThrow({ where: { id: req.id } });
    const broken: GmailApi = { ...g.api, sendDraft: async () => { throw new Error("Gmail answered 403: Insufficient Permission."); } };
    const out = await sendViaGmail(db, sup, req.id, { expectedVersion: approved.version, to: "nodal@bank.example.invalid", idempotencyKey: "g-3" }, broken);
    expect(out).toMatchObject({ outcome: "FAILED", error: expect.stringMatching(/403.*Nothing was sent/) });
    expect((await db.request.findUniqueOrThrow({ where: { id: req.id } })).status).toBe("SUBMISSION_FAILED");
  });
});
