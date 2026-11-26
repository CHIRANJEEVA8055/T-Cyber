import crypto from "node:crypto";
import type { Db } from "../db";
import type { SessionUser } from "../auth/session";
import { recordAudit } from "../audit";
import { buildMime } from "../mail/message";
import { keepLayout } from "@/domain/text-merge";
import { isEmailAddress, splitAddresses } from "@/domain/mail-check";
import { attachmentsFor } from "../mail/outbox";
import { updateDraftTx } from "../services/requests";
import { gmailSettings, readToken } from "./oauth";
import { liveGmail, type GmailApi } from "./api";

/**
 * Keeps each unsent request and its draft in the linked Gmail account in step, both ways. For every request it
 * compares a fingerprint of To, Subject, body and attachments as last synced with both sides:
 *  - changed only in T-CYBER: the Gmail draft is updated;
 *  - changed only in Gmail: the edit becomes a new version in T-CYBER (any approval is withdrawn, as for any edit),
 *    and a changed To is kept as the address to send to;
 *  - changed on both: the newer edit wins; the other is kept (T-CYBER's versions are never lost; Gmail's text is
 *    saved as a note on the request).
 * A draft that has gone from Gmail's Drafts (sent or deleted there) is not silently made again: the request says so.
 */

const UNSENT = ["DRAFT", "AWAITING_APPROVAL", "APPROVED", "SUBMISSION_FAILED"];
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const tidy = (s: string) => s.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trim();
// The Gmail draft's To line carries what is written as an address; a placeholder one is refused only at Send.
const realAddresses = (s: string) => splitAddresses(s).filter(isEmailAddress).map((a) => a.toLowerCase()).join(", ");
/** "Name <a@b>, c@d" → "a@b, c@d". */
export const addressesOf = (s: string) => (s.match(/[^\s<>,;"]+@[^\s<>,;"]+/g) ?? []).map((a) => a.toLowerCase()).join(", ");
const fingerprint = (to: string, subject: string, body: string, attachmentIds: string[]) => sha(JSON.stringify([addressesOf(to), subject.trim(), tidy(body), [...attachmentIds].sort()]));

export type SyncOutcome = "created" | "pushed" | "pulled" | "unchanged" | "missing" | "skipped";

/** The officer a Gmail edit is recorded under: the case's investigating officer. */
async function actorFor(db: Db, caseId: string): Promise<SessionUser | null> {
  const a = await db.caseAssignment.findFirst({ where: { caseId, role: "INVESTIGATING_OFFICER" }, include: { user: { include: { station: true } } } });
  const u = a?.user;
  return u ? { id: u.id, username: u.username, displayName: u.displayName, rank: u.rank, role: u.role as SessionUser["role"], stationId: u.stationId, stationCode: u.station.code, stationName: u.station.name } : null;
}

export async function syncRequestWithGmail(db: Db, requestId: string, api: GmailApi = liveGmail, opts: { recreate?: boolean } = {}): Promise<SyncOutcome> {
  const s = gmailSettings();
  const account = readToken(s)?.account ?? s.account ?? "";
  const req = await db.request.findUnique({ where: { id: requestId }, include: { recipient: true } });
  if (!req || !UNSENT.includes(req.status)) return "skipped";
  const v = await db.requestVersion.findUniqueOrThrow({ where: { requestId_versionNo: { requestId, versionNo: req.currentVersionNo } } });
  const attachmentIds = JSON.parse(v.attachmentIdsJson) as string[];
  // Only addresses go in the To line (a half-typed address or a portal's description do not).
  const to = realAddresses(req.gmailTo ?? (["UNADDRESSED", "MANUAL"].includes(req.recipient.organisationType) ? "" : req.recipient.address));
  const local = fingerprint(to, v.subject, v.body, attachmentIds);
  const raw = async () => buildMime({ from: account, to, subject: v.subject, text: v.body, attachments: await attachmentsFor(db, attachmentIds) }).mime;
  const mark = (data: Record<string, unknown>) => db.request.update({ where: { id: requestId }, data: { ...data, gmailSyncedAt: new Date() } });

  if (!req.gmailDraftId || opts.recreate) {
    const d = await api.createDraft(await raw());
    await mark({ gmailDraftId: d.draftId, gmailMessageId: d.messageId, gmailSyncedHash: local, gmailError: null });
    await db.$transaction((tx) => recordAudit(tx, { caseId: req.caseId, actorId: null, action: "request.gmail_draft_saved", objectType: "Request", objectId: requestId, summary: `${req.reference} ${opts.recreate ? "put back in" : "saved to"} the Drafts of ${account}` }));
    return "created";
  }
  const remote = await api.getDraft(req.gmailDraftId);
  if (!remote) {
    if (!req.gmailError?.startsWith("MISSING")) await mark({ gmailError: "MISSING: The draft is no longer in Gmail's Drafts: it was sent or deleted there." });
    return "missing";
  }
  const remoteChanged = remote.messageId !== req.gmailMessageId;
  const localChanged = local !== req.gmailSyncedHash;
  if (!remoteChanged && !localChanged) {
    if (req.gmailError) await mark({ gmailError: null });
    return "unchanged";
  }
  const pull = remoteChanged && (!localChanged || remote.savedAt > v.createdAt.getTime());
  if (!pull) {
    const d = await api.updateDraft(req.gmailDraftId, await raw());
    if (remoteChanged) {
      // Both sides changed and T-CYBER's edit is newer: Gmail's text is kept as a note, not lost.
      const officer = await actorFor(db, req.caseId);
      if (officer) await db.requestNote.create({ data: { requestId, authorId: officer.id, body: `Edits made in Gmail were replaced by the newer version from T-CYBER. Gmail's text was:\n\nTo: ${remote.to}\nSubject: ${remote.subject}\n\n${remote.text}` } });
    }
    await mark({ gmailMessageId: d.messageId, gmailSyncedHash: local, gmailError: null });
    return "pushed";
  }
  // Edited in Gmail: carried into T-CYBER as a new version.
  const newTo = addressesOf(remote.to);
  const subject = remote.subject.trim() || v.subject;
  // Gmail hard-wraps plain text: the edit's words are taken, laid out as T-CYBER had the text.
  const body = tidy(remote.text) ? keepLayout(v.body, tidy(remote.text)) : v.body;
  // Gmail re-saves a draft it opens (re-wrapping lines, re-encoding): only a change in the words is a new version.
  const words = (t: string) => t.replace(/\s+/g, " ").trim();
  if (words(subject) !== words(v.subject) || words(body) !== words(v.body)) {
    const officer = await actorFor(db, req.caseId);
    if (!officer) throw new Error("The case has no investigating officer to record the Gmail edit under.");
    const items = await db.requestItem.findMany({ where: { requestId }, orderBy: { sortOrder: "asc" } });
    await db.$transaction((tx) =>
      updateDraftTx(tx, officer, requestId, { expectedVersion: req.version, recipientId: req.recipientId, subject, body, scope: v.scope, periodFrom: v.periodFrom, periodTo: v.periodTo, items: items.map((i) => ({ label: i.label, itemType: i.itemType })), attachmentIds, changeNote: `Edited in Gmail (${account})` }, officer.id),
    );
  }
  const finalTo = newTo || to;
  const cur = await db.request.findUniqueOrThrow({ where: { id: requestId }, select: { currentVersionNo: true } });
  const latest = await db.requestVersion.findUniqueOrThrow({ where: { requestId_versionNo: { requestId, versionNo: cur.currentVersionNo } } });
  await mark({ gmailMessageId: remote.messageId, gmailTo: newTo && newTo !== addressesOf(req.recipient.address) ? newTo : req.gmailTo, gmailSyncedHash: fingerprint(finalTo, latest.subject, latest.body, JSON.parse(latest.attachmentIdsJson) as string[]), gmailError: null });
  await db.$transaction((tx) => recordAudit(tx, { caseId: req.caseId, actorId: null, action: "request.gmail_edit_pulled", objectType: "Request", objectId: requestId, summary: `${req.reference} edited in Gmail (${account}); the edit is now in T-CYBER${newTo ? `, To ${newTo}` : ""}` }));
  return "pulled";
}

/** Gmail asking us to slow down (too many calls a minute): not a fault of the draft, and over by the next pass. */
export const isGmailRateLimit = (err: unknown) => /Gmail answered (?:429|403): .*(?:quota exceeded|rate limit|user-rate|too many)/i.test((err as Error)?.message ?? "");

/**
 * Every unsent request, one at a time; a failure on one is recorded on it and does not stop the others. When Gmail
 * says it is getting too many calls, the pass stops there and the rest wait for the next pass (20 seconds later),
 * with nothing marked as failed.
 */
export async function syncAllWithGmail(db: Db, api: GmailApi = liveGmail): Promise<Record<SyncOutcome | "failed" | "deferred", number>> {
  const out = { created: 0, pushed: 0, pulled: 0, unchanged: 0, missing: 0, skipped: 0, failed: 0, deferred: 0 };
  // Drafts made or changed since Gmail was connected, and any already linked (the link starts "from now").
  const since = new Date(readToken()?.connectedAt ?? 0);
  // A draft whose last attempt failed is tried again too, whenever it was made.
  const list = await db.request.findMany({ where: { status: { in: UNSENT }, OR: [{ gmailDraftId: { not: null } }, { updatedAt: { gte: since } }, { gmailError: { not: null } }] }, select: { id: true }, orderBy: { updatedAt: "desc" }, take: 200 });
  for (const [i, r] of list.entries()) {
    try {
      out[await syncRequestWithGmail(db, r.id, api)]++;
    } catch (err) {
      if (isGmailRateLimit(err)) {
        out.deferred = list.length - i;
        break;
      }
      out.failed++;
      await db.request.update({ where: { id: r.id }, data: { gmailError: (err as Error).message.slice(0, 300) } }).catch(() => undefined);
    }
  }
  return out;
}
