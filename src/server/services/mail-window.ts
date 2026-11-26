import crypto from "node:crypto";
import type { Db, Tx } from "../db";
import type { SessionUser } from "../auth/session";
import { loadCaseForUser } from "../auth/access";
import { canWriteCase } from "@/domain/permissions";
import { recordAudit } from "../audit";
import { AppError, conflictError, notFoundError } from "../errors";
import { now } from "../clock";
import { deliverySettings, getAppConfig } from "../config";
import { addressProblem, checkMail, invalidLine, isEmailAddress, splitAddresses, type MailField } from "@/domain/mail-check";
import { isEditableStatus } from "@/domain/request-workflow";
import { withClosing } from "@/domain/closing";
import { formatDayMonthIST } from "@/domain/time";
import { gmailDraftView, type GmailDraftView } from "../gmail/view";
import { gmailSettings, gmailStatus } from "../gmail/oauth";
import { approvalRoleOf, approveForSending, createDraftTx, sendViaGmail, updateDraftTx, type SendOutcome } from "./requests";
import { mailDefaultsFor } from "./mail-defaults";
import { caseReference } from "./cases";
import { assistantAuthorId } from "../assistant-identity";
import { nodalFor } from "./nodal";
import type { GmailApi } from "../gmail/api";

/**
 * The mail window: a request (or a mail an officer writes from "New mail") with every part editable in place and
 * saved as it is typed: the To addresses, the subject, the text, what it asks for and the attached files. What is
 * typed is kept as the request's working copy; it becomes a version (versions are never changed once written) when
 * the window closes, when the mail is sent, or after typing has paused for a while. Send checks every field and
 * names the ones to fix; nothing is sent until every field is right and the officer presses Send.
 */

const LIVE_NOTE = "Edited in the mail window";
const UNSENT = ["DRAFT", "AWAITING_APPROVAL", "APPROVED", "SUBMISSION_FAILED"];
/** A working copy not touched for this long is made a version by the background pass (the window was left). */
export const LIVE_IDLE_MS = 2 * 60 * 1000;

type Item = { label: string; itemType: string };
interface Live {
  subject: string;
  body: string;
  attachmentIds: string[];
  items: Item[];
  /** The version the officer was editing on top of. */
  base: number;
}
const readLive = (r: { liveJson: string | null }): Live | null => {
  if (!r.liveJson) return null;
  try {
    return JSON.parse(r.liveJson) as Live;
  } catch {
    return null;
  }
};
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 32);
/** What the window shows, as one key: a save over a different key was made over someone else's change. */
const keyOf = (to: string, subject: string, body: string, attachmentIds: string[], items: string[]) => sha(JSON.stringify([to.trim(), subject, body, [...attachmentIds].sort(), items]));

export interface MailView {
  /** Empty for a new mail not saved yet. */
  id: string;
  caseId: string;
  caseRef: string;
  reference: string;
  status: string;
  /** The optimistic-lock counter, passed back with each save. */
  version: number;
  /** The fields as saved, as one key (passed back with each save). */
  key: string;
  /** Written by an officer from New mail (its addressee is whatever is typed). */
  officerMail: boolean;
  /** Every part can be edited here (unsent, the viewer may write, and mail goes through Gmail). */
  editable: boolean;
  readOnlyNote: string | null;
  from: { address: string; note: string };
  to: string;
  /** Addresses on the nodal officer list (or verified in the directory) for the addressee's organisation. */
  suggested: { address: string; note: string }[];
  org: string;
  subject: string;
  body: string;
  /** What it asks for now, by wording. */
  items: string[];
  /** What the rules first listed for it (an item the officer removed can be put back). */
  allItems: { id: string; label: string; itemType: string }[];
  attachments: { id: string; fileName: string; title: string; sizeBytes: number }[];
  caseFiles: { id: string; fileName: string; title: string; sizeBytes: number; category: string }[];
  gmail: GmailDraftView;
  /** What pressing Send does: send (approving it as needed), or pass it for an approval the officer cannot give. */
  send: { label: string; note: string; mode: "SEND" | "FOR_APPROVAL" | "WAITING" | "NONE" };
  needsReview: string | null;
  savedAt: string | null;
  sent: null | { at: string; how: string | null; followUpAt: string | null; to: string | null };
}

async function loadForWindow(db: Db | Tx, user: SessionUser, requestId: string, mode: "read" | "write") {
  const req = await db.request.findUnique({ where: { id: requestId }, include: { recipient: true, items: { orderBy: { sortOrder: "asc" } }, submissions: { where: { outcome: "SUCCEEDED" }, orderBy: { attemptedAt: "desc" }, take: 1 } } });
  if (!req) throw notFoundError("request");
  const kase = await loadCaseForUser(db, user, req.caseId, mode);
  return { req, kase };
}

/** The key of what the window would show now (working copy, else the current version). */
async function currentKey(db: Db | Tx, req: { id: string; currentVersionNo: number; liveJson: string | null; gmailTo: string | null; updatedAt: Date; gmailDraftId: string | null; gmailSyncedAt: Date | null; gmailError: string | null; channel: string; recipient: { address: string; verificationStatus: string; isSynthetic: boolean; organisationType: string }; items: { label: string; itemType: string }[] }, isDemo: boolean) {
  const v = await db.requestVersion.findUniqueOrThrow({ where: { requestId_versionNo: { requestId: req.id, versionNo: req.currentVersionNo } } });
  const live = readLive(req);
  const items = live?.items ?? req.items;
  return keyOf(gmailDraftView(req, isDemo).to, live?.subject ?? v.subject, live?.body ?? v.body, live?.attachmentIds ?? (JSON.parse(v.attachmentIdsJson) as string[]), items.map((i) => i.label));
}

/** The items the rules first listed, then any added since, in that order. */
async function catalogueOf(db: Db | Tx, requestId: string, current: Item[]): Promise<Item[]> {
  const first = await db.requestVersion.findFirst({ where: { requestId }, orderBy: { versionNo: "asc" }, select: { basisJson: true } });
  const named = (JSON.parse(first?.basisJson ?? "{}") as { items?: Item[] }).items ?? [];
  return [...named, ...current.filter((i) => !named.some((n) => n.label === i.label))];
}

async function caseFilesOf(db: Db | Tx, caseId: string) {
  return db.evidenceItem.findMany({ where: { caseId, derivation: { in: ["ORIGINAL", "PREPARED"] } }, orderBy: { receivedAt: "asc" }, select: { id: true, fileName: true, title: true, sizeBytes: true, category: true } });
}

const fromOf = (g: GmailDraftView | null, fromAddress: string | null) =>
  deliverySettings().mode === "gmail"
    ? { address: g?.account ?? getAppConfig().gmail.account ?? "the linked Gmail account", note: g?.connected === false ? "linked Gmail account (not connected yet)" : "linked Gmail account: the draft is kept in its Drafts" }
    : { address: fromAddress ?? getAppConfig().mailbox.fromAddress, note: fromAddress ? "set on this draft" : "station mailbox" };

export async function getMailView(db: Db, user: SessionUser, requestId: string): Promise<MailView> {
  const { req, kase } = await loadForWindow(db, user, requestId, "read");
  const v = await db.requestVersion.findUniqueOrThrow({ where: { requestId_versionNo: { requestId, versionNo: req.currentVersionNo } } });
  const writer = canWriteCase(user, { stationId: kase.stationId, assignedUserIds: kase.assignments.map((a) => a.userId) });
  const gmailOn = deliverySettings().mode === "gmail";
  const unsent = UNSENT.includes(req.status);
  const editable = writer && unsent && gmailOn;
  const live = unsent ? readLive(req) : null;
  const g = gmailDraftView(req, kase.isDemo);
  const files = await caseFilesOf(db, kase.id);
  const byId = new Map(files.map((f) => [f.id, f]));
  const items: Item[] = live?.items ?? req.items.map((i) => ({ label: i.label, itemType: i.itemType }));
  const catalogue = await catalogueOf(db, requestId, items);
  const attachmentIds = live?.attachmentIds ?? (JSON.parse(v.attachmentIdsJson) as string[]);
  const subject = live?.subject ?? v.subject;
  const body = live?.body ?? v.body;
  const nodal = ["UNADDRESSED", "MANUAL", "TYPED"].includes(req.recipient.organisationType) ? [] : await nodalFor(db, req.recipient.organisation.replace(/\s*\(synthetic\)$/i, ""), 4);
  const directory = req.recipient.verificationStatus === "VERIFIED" && (kase.isDemo || !req.recipient.isSynthetic) && !["UNADDRESSED", "MANUAL", "TYPED"].includes(req.recipient.organisationType) ? [{ address: req.recipient.address, note: `${req.recipient.organisation}, verified in the directory` }] : [];
  const suggested = [...directory, ...nodal.flatMap((n) => n.emails.map((e) => ({ address: e, note: `Nodal officer list${n.officerName ? `: ${n.officerName}` : ""}` })))]
    .filter((x, i, all) => isEmailAddress(x.address) && all.findIndex((y) => y.address.toLowerCase() === x.address.toLowerCase()) === i)
    .map((x) => (addressProblem(x.address) ? { ...x, note: `${x.note} (a demonstration address: it cannot receive mail)` } : x))
    .slice(0, 4);

  // What Send does for this officer. The working copy becomes a version written by whoever typed it.
  const routeRole = await approvalRoleOf(db, req);
  const roleOk = routeRole !== "SUPERVISOR" || user.role === "SUPERVISOR";
  const author = live ? (req.liveById ?? user.id) : v.createdById;
  const assistant = await assistantAuthorId(db, kase.stationId);
  const mayApprove = roleOk && (author !== user.id || gmailSettings().senderApproves);
  const send: MailView["send"] = !unsent || !writer
    ? { label: "Send", note: "", mode: "NONE" }
    : req.status === "APPROVED" || req.status === "SUBMISSION_FAILED" || mayApprove
      ? { label: req.status === "SUBMISSION_FAILED" ? "Send again" : "Send", note: `Send checks every field, then sends it from ${g.account ?? "the linked Gmail account"}${req.status === "APPROVED" ? "" : author === user.id && author !== assistant ? "; you approve the version you wrote by sending it (logged)" : "; sending it approves it (logged)"}.`, mode: "SEND" }
      : req.status === "AWAITING_APPROVAL"
        ? { label: "Waiting for approval", note: routeRole === "SUPERVISOR" ? "Waiting for the supervisor’s approval; they send it from here." : "Waiting for another officer’s approval; they send it from here.", mode: "WAITING" }
        : { label: "Send for approval", note: routeRole === "SUPERVISOR" ? "This route needs the supervisor’s approval: Send for approval passes it to them, and they send it." : "You wrote this version, so another officer approves and sends it.", mode: "FOR_APPROVAL" };
  const sent = req.submittedAt ? { at: req.submittedAt.toISOString(), how: req.submissions[0]?.adapter ?? null, followUpAt: req.followUpAt?.toISOString() ?? null, to: req.submissions[0]?.recipientAddress ?? req.gmailTo } : null;
  const to = unsent ? g.to : (sent?.to ?? req.gmailTo ?? req.recipient.address);
  return {
    id: req.id,
    caseId: kase.id,
    caseRef: caseReference(kase),
    reference: req.reference,
    status: req.status,
    version: req.version,
    key: keyOf(to, subject, body, attachmentIds, items.map((i) => i.label)),
    officerMail: req.writtenByOfficer,
    editable,
    readOnlyNote: editable ? null : !unsent ? null : !writer ? "You can read this case but not change its mail." : "Mail is not sent through Gmail at this station: edit it in the request editor.",
    from: fromOf(gmailOn ? g : null, v.fromAddress),
    to,
    suggested,
    org: req.recipient.organisationType === "MANUAL" ? "New mail" : req.recipient.organisation,
    subject,
    body,
    items: items.map((i) => i.label),
    allItems: catalogue.map((n, i) => ({ id: `item-${i}`, label: n.label, itemType: n.itemType })),
    attachments: attachmentIds.map((id) => byId.get(id)).filter((x): x is NonNullable<typeof x> => !!x).map((f) => ({ id: f.id, fileName: f.fileName, title: f.title, sizeBytes: f.sizeBytes })),
    caseFiles: files.map((f) => ({ id: f.id, fileName: f.fileName, title: f.title, sizeBytes: f.sizeBytes, category: f.category })),
    gmail: g,
    send,
    needsReview: req.needsReview ? (req.needsReviewReason ?? "Its sources changed after it was written.") : null,
    savedAt: (req.liveAt ?? v.createdAt).toISOString(),
    sent,
  };
}

/** A new mail before anything is saved: nothing exists yet; the first save makes it a request with its reference. */
export async function getNewMailView(db: Db, user: SessionUser, caseId: string): Promise<MailView> {
  const kase = await loadCaseForUser(db, user, caseId, "write");
  const mail = await mailDefaultsFor(db, user);
  const files = await caseFilesOf(db, caseId);
  const body = withClosing(`Sir/Madam,\n\n\n\nKindly reply to this mail, quoting the reference in its subject.\n\n${user.displayName}, ${user.rank}`, user, getAppConfig().mailbox, mail.closing);
  const g = gmailStatus();
  const gv: GmailDraftView = { on: deliverySettings().mode === "gmail", connected: g.connected, account: g.connectedAs ?? g.account, note: g.enabled && g.connected ? null : g.note, inGmail: false, beforeLink: false, syncedAt: null, error: null, missing: false, to: "" };
  return {
    id: "",
    caseId,
    caseRef: caseReference(kase),
    reference: "",
    status: "DRAFT",
    version: 0,
    key: "",
    officerMail: true,
    editable: deliverySettings().mode === "gmail",
    readOnlyNote: deliverySettings().mode === "gmail" ? null : "Mail is not sent through Gmail at this station.",
    from: fromOf(gv, mail.own.from ? mail.from : null),
    to: "",
    suggested: [],
    org: "New mail",
    subject: `${caseReference(kase)} · `,
    body,
    items: [],
    allItems: [],
    attachments: [],
    caseFiles: files.map((f) => ({ id: f.id, fileName: f.fileName, title: f.title, sizeBytes: f.sizeBytes, category: f.category })),
    gmail: gv,
    send: { label: "Send", note: `Send checks every field, then sends it from ${gv.account ?? "the linked Gmail account"}; you approve the mail you wrote by sending it (logged).`, mode: gmailSettings().senderApproves ? "SEND" : "FOR_APPROVAL" },
    needsReview: null,
    savedAt: null,
    sent: null,
  };
}

/** The directory entry a typed address belongs to: an existing one with that address, or one made for it. */
async function typedRecipient(tx: Tx, address: string, category: string) {
  const a = address.toLowerCase();
  const existing = await tx.recipient.findFirst({ where: { address: a, organisationType: { notIn: ["UNADDRESSED", "MANUAL"] } } });
  if (existing) {
    const cats = JSON.parse(existing.categoriesJson) as string[];
    return cats.includes(category) ? existing : tx.recipient.update({ where: { id: existing.id }, data: { categoriesJson: JSON.stringify([...cats, category]) } });
  }
  return tx.recipient.create({
    data: { name: "Typed by an officer", organisation: a, organisationType: "TYPED", channel: "EMAIL", address: a, verificationStatus: "UNVERIFIED", categoriesJson: JSON.stringify(["INFORMATION", "PRESERVATION", "HOLD", "RESTORATION"]), active: true, isSynthetic: false, notes: "An address an officer typed in a mail they wrote. Not checked against the nodal officer list." },
  });
}

/** The stand-in a new mail points at until an address is typed. Never sent to. */
async function newMailRecipient(tx: Tx) {
  const found = await tx.recipient.findFirst({ where: { organisationType: "MANUAL" } });
  if (found) return found;
  return tx.recipient.create({
    data: { name: "Address not typed yet", organisation: "New mail", organisationType: "MANUAL", channel: "EMAIL", address: "new-mail@example.invalid", verificationStatus: "UNVERIFIED", categoriesJson: JSON.stringify(["INFORMATION", "PRESERVATION", "HOLD", "RESTORATION"]), active: false, isSynthetic: false, notes: "Stands in for the addressee of a mail an officer is writing, until an address is typed. Nothing is ever sent to it." },
  });
}

/** Where an officer's own mail is addressed: the first real address typed, else the stand-in. */
const officerRecipient = async (tx: Tx, to: string, category: string) => {
  const first = splitAddresses(to).find((a) => !addressProblem(a));
  return first ? typedRecipient(tx, first, category) : newMailRecipient(tx);
};

async function checkFiles(tx: Tx, caseId: string, ids: string[]) {
  if (!ids.length) return;
  const found = await tx.evidenceItem.count({ where: { id: { in: ids }, caseId } });
  if (found !== ids.length) throw new AppError("A file to attach is not in this case.", "VALIDATION", { attachments: "A file is not in this case." });
}

export interface MailSaveInput {
  expectedVersion: number;
  /** The key of the fields as the window last saved or loaded them. */
  baseKey: string;
  to: string;
  subject: string;
  body: string;
  attachmentIds: string[];
  /** What it still asks for, by the items' wording (null: unchanged). An item the rules listed can be put back. */
  keepItems: string[] | null;
  /** Save over a change made elsewhere since the window was opened (the officer chose to keep theirs). */
  overwrite?: boolean;
}

/**
 * Saves the window as typed. To is kept on the request (where the mail goes, not part of its wording); the subject,
 * text, items and files are kept as the working copy until they are made a version (commitMailDraft).
 */
export async function saveMailDraft(db: Db, user: SessionUser, requestId: string, input: MailSaveInput): Promise<{ version: number; key: string; savedAt: string }> {
  if (input.subject.length > 1000 || input.body.length > 200_000 || input.to.length > 2000) throw new AppError("This is too long to save.", "VALIDATION");
  const out = await db.$transaction(async (tx) => {
    const { req, kase } = await loadForWindow(tx, user, requestId, "write");
    if (!isEditableStatus(req.status)) throw new AppError("This mail has been sent; it can no longer be changed.", "PRECONDITION");
    const v = await tx.requestVersion.findUniqueOrThrow({ where: { requestId_versionNo: { requestId, versionNo: req.currentVersionNo } } });
    const live = readLive(req);
    const curItems: Item[] = live?.items ?? req.items.map((i) => ({ label: i.label, itemType: i.itemType }));
    const curTo = gmailDraftView(req, kase.isDemo).to;
    const curKey = await currentKey(tx, req, kase.isDemo);
    // Someone else changed it (in Gmail, or another officer) since this window last saved: say so, unless told to keep this.
    if (req.version !== input.expectedVersion && curKey !== input.baseKey && !input.overwrite) throw conflictError("This mail was changed elsewhere (in Gmail or by another officer) since you opened it.");
    const ids = [...new Set(input.attachmentIds)];
    await checkFiles(tx, req.caseId, ids);
    const catalogue = await catalogueOf(tx, requestId, curItems);
    const items = input.keepItems ? catalogue.filter((c) => input.keepItems!.includes(c.label)) : curItems;
    const to = input.to.trim();
    const sameAsVersion = input.subject === v.subject && input.body === v.body && JSON.stringify([...ids].sort()) === JSON.stringify([...(JSON.parse(v.attachmentIdsJson) as string[])].sort()) && JSON.stringify(items) === JSON.stringify(req.items.map((i) => ({ label: i.label, itemType: i.itemType })));
    const nextLive: Live | null = sameAsVersion ? null : { subject: input.subject, body: input.body, attachmentIds: ids, items, base: input.overwrite || !live ? req.currentVersionNo : live.base };
    const key = keyOf(to, input.subject, input.body, ids, items.map((i) => i.label));
    const toChanged = curTo !== to;
    const liveChanged = JSON.stringify(nextLive) !== JSON.stringify(live);
    if (!toChanged && !liveChanged) return { version: req.version, key, savedAt: (req.liveAt ?? v.createdAt).toISOString(), toChanged };
    const at = now();
    const updated = await tx.request.update({
      where: { id: requestId },
      // What is typed in To is kept as typed, even empty (the directory's address is offered only until then).
      data: { ...(toChanged ? { gmailTo: to } : {}), liveJson: nextLive ? JSON.stringify(nextLive) : null, liveAt: nextLive ? at : null, liveById: nextLive ? user.id : null, version: { increment: 1 } },
    });
    return { version: updated.version, key, savedAt: at.toISOString(), toChanged };
  });
  if (out.toChanged) {
    const { kickGmailSync } = await import("../gmail/runner");
    kickGmailSync(requestId);
  }
  return { version: out.version, key: out.key, savedAt: out.savedAt };
}

/** The officer whose typing a working copy holds, to write its version under. */
async function typist(db: Db | Tx, userId: string): Promise<SessionUser | null> {
  const u = await db.user.findUnique({ where: { id: userId }, include: { station: true } });
  return u ? { id: u.id, username: u.username, displayName: u.displayName, rank: u.rank, role: u.role as SessionUser["role"], stationId: u.stationId, stationCode: u.station.code, stationName: u.station.name } : null;
}

/**
 * Makes the working copy a version (written by the officer who typed it). When the mail was changed elsewhere in
 * the meantime (an edit pulled from Gmail), that newer version stands and the typed text is kept as a note.
 */
export async function commitMailDraft(db: Db, requestId: string, opts: { by?: SessionUser } = {}): Promise<{ committed: boolean; stale?: boolean }> {
  const out = await db.$transaction(async (tx) => {
    const req = await tx.request.findUnique({ where: { id: requestId }, include: { items: { orderBy: { sortOrder: "asc" } } } });
    const live = req ? readLive(req) : null;
    if (!req || !live) return { committed: false };
    const clear = () => tx.request.update({ where: { id: requestId }, data: { liveJson: null, liveAt: null, liveById: null } });
    if (!isEditableStatus(req.status)) {
      await clear();
      return { committed: false };
    }
    const actor = (req.liveById ? await typist(tx, req.liveById) : null) ?? opts.by ?? null;
    if (!actor) {
      await clear();
      return { committed: false };
    }
    if (opts.by) await loadCaseForUser(tx, opts.by, req.caseId, "write");
    if (live.base !== req.currentVersionNo) {
      await tx.requestNote.create({ data: { requestId, authorId: actor.id, body: `What ${actor.displayName} typed in the mail window was not made a version, because the mail was changed elsewhere (in Gmail or by another officer) meanwhile. It was:\n\nSubject: ${live.subject}\n\n${live.body}` } });
      await clear();
      return { committed: false, stale: true };
    }
    const v = await tx.requestVersion.findUniqueOrThrow({ where: { requestId_versionNo: { requestId, versionNo: req.currentVersionNo } } });
    const recipientId = req.writtenByOfficer ? (await officerRecipient(tx, req.gmailTo ?? "", req.category)).id : v.recipientId;
    await updateDraftTx(tx, actor, requestId, { expectedVersion: req.version, recipientId, subject: live.subject, body: live.body, scope: v.scope, periodFrom: v.periodFrom, periodTo: v.periodTo, items: live.items, attachmentIds: live.attachmentIds, changeNote: LIVE_NOTE, lenient: true }, actor.id);
    await clear();
    return { committed: true };
  });
  if (out.committed) {
    const { kickGmailSync } = await import("../gmail/runner");
    kickGmailSync(requestId);
  }
  return out;
}

/** Working copies left untouched for a while (the window was closed without saying so): made versions. */
export async function commitIdleMailDrafts(db: Db): Promise<number> {
  const idle = await db.request.findMany({ where: { liveJson: { not: null }, liveAt: { lt: new Date(now().getTime() - LIVE_IDLE_MS) } }, select: { id: true }, take: 50 });
  let n = 0;
  for (const r of idle) if ((await commitMailDraft(db, r.id).catch(() => ({ committed: false }))).committed) n++;
  return n;
}

export type MailSendResult =
  | { outcome: "SENT"; text: string; at: string; followUpAt: string | null }
  | { outcome: "FAILED"; text: string }
  | { outcome: "FOR_APPROVAL"; text: string };

/** The mail's fields as stored, checked as Send checks them. */
async function storedProblems(db: Db | Tx, req: { id: string; caseId: string; gmailTo: string | null; currentVersionNo: number; writtenByOfficer: boolean }) {
  const v = await db.requestVersion.findUniqueOrThrow({ where: { requestId_versionNo: { requestId: req.id, versionNo: req.currentVersionNo } } });
  const ids = JSON.parse(v.attachmentIdsJson) as string[];
  const files = await db.evidenceItem.findMany({ where: { id: { in: ids }, caseId: req.caseId }, select: { id: true, sizeBytes: true } });
  const items = await db.requestItem.count({ where: { requestId: req.id } });
  const catalogue = await catalogueOf(db, req.id, []);
  return checkMail({ to: req.gmailTo ?? "", subject: v.subject, body: v.body, attachmentBytes: files.reduce((s, f) => s + f.sizeBytes, 0), missingAttachments: ids.filter((id) => !files.some((f) => f.id === id)).map(() => "An attached file"), hasItems: !req.writtenByOfficer && (catalogue.length > 0 || items > 0), itemsKept: items });
}

/**
 * Send from the window: the working copy is made a version, every field is checked (the fields to fix are named,
 * nothing else happens); then it is approved as the station's rules allow and sent from the linked Gmail account to
 * the typed addresses.
 */
export async function sendMailNow(db: Db, user: SessionUser, requestId: string, input: { expectedVersion: number; baseKey: string; idempotencyKey: string }, api?: GmailApi): Promise<MailSendResult> {
  if (deliverySettings().mode !== "gmail") throw new AppError("Mail is not sent through Gmail at this station.", "PRECONDITION");
  const g = gmailStatus();
  if (!g.enabled || !g.connected) throw new AppError(`Gmail is not ready: ${g.note}`, "PRECONDITION");
  {
    const { req, kase } = await loadForWindow(db, user, requestId, "write");
    if (!UNSENT.includes(req.status)) throw new AppError("This mail has already been sent.", "PRECONDITION");
    // What is sent must be what the officer sees: a change made elsewhere since stops the send.
    if (req.version !== input.expectedVersion && (await currentKey(db, req, kase.isDemo)) !== input.baseKey) throw conflictError("This mail was changed elsewhere since you opened it. Load the latest, check it, then send.");
  }
  const committed = await commitMailDraft(db, requestId, { by: user });
  if (committed.stale) throw conflictError("This mail was changed elsewhere while you were typing; your text is kept as a note on it. Load the latest, check it, then send.");
  const { req } = await loadForWindow(db, user, requestId, "write");
  const problems = await storedProblems(db, req);
  if (Object.keys(problems).length) throw new AppError(invalidLine(problems)!, "VALIDATION", problems as Record<string, string>);
  let version = req.version;
  if (req.needsReview) {
    // The warning is shown at the top of the window; sending it is the officer's check.
    version = (
      await db.$transaction(async (tx) => {
        await recordAudit(tx, { caseId: req.caseId, actorId: user.id, action: "request.reviewed", objectType: "Request", objectId: requestId, summary: `${req.reference} checked in the mail window and sent (it had been flagged: ${req.needsReviewReason ?? "sources changed"})` });
        return tx.request.update({ where: { id: requestId }, data: { needsReview: false, needsReviewReason: null, version: { increment: 1 } } });
      })
    ).version;
  }
  const approval = await approveForSending(db, user, requestId, version);
  if (!approval.approved) return { outcome: "FOR_APPROVAL", text: approval.reason };
  const to = splitAddresses(req.gmailTo!).join(", ");
  const r: SendOutcome = await sendViaGmail(db, user, requestId, { expectedVersion: approval.version, to, idempotencyKey: input.idempotencyKey }, api);
  if (r.outcome === "FAILED") return { outcome: "FAILED", text: r.error };
  if (r.outcome !== "SUCCEEDED") return { outcome: "FAILED", text: "It was not sent." };
  return { outcome: "SENT", at: r.at, followUpAt: r.followUpAt, text: `Sent from ${g.connectedAs ?? g.account ?? "Gmail"} to ${to}${r.attachments ? `, with ${r.attachments} ${r.attachments === 1 ? "attachment" : "attachments"}` : ""}. It is in that account's Sent folder; a reply in the same conversation, or one quoting ${req.reference}, is linked to it by itself${r.followUpAt ? `, and if none comes by ${formatDayMonthIST(new Date(r.followUpAt))} a reminder is drafted` : ""}.` };
}

/**
 * "New mail": a mail the officer writes themselves, kept as a request (with its own reference, added to the end of
 * the subject) so its reply is linked to it. Made on the first save, so a window closed unwritten leaves nothing.
 */
export async function createOfficerMail(db: Db, user: SessionUser, caseId: string, input: { to: string; subject: string; body: string; attachmentIds: string[] }): Promise<{ requestId: string; version: number; key: string; subject: string; reference: string }> {
  if (input.subject.length > 1000 || input.body.length > 200_000 || input.to.length > 2000) throw new AppError("This is too long to save.", "VALIDATION");
  const created = await db.$transaction(async (tx) => {
    const kase = await loadCaseForUser(tx, user, caseId, "write");
    const ids = [...new Set(input.attachmentIds)];
    await checkFiles(tx, caseId, ids);
    const recipient = await officerRecipient(tx, input.to, "INFORMATION");
    const mail = await mailDefaultsFor(tx, user);
    const subject = input.subject.trim() ? `${input.subject.trim().replace(/\s*·\s*$/, "")} · {{requestReference}}` : `${caseReference(kase)} · {{requestReference}}`;
    const r = await createDraftTx(tx, user, { caseId, category: "INFORMATION", recipientId: recipient.id, subject, body: input.body, scope: "Mail written by the officer", periodFrom: null, periodTo: null, items: [], subjectEntityIds: [], attachmentIds: ids, fromAddress: mail.own.from ? mail.from : null, lenient: true });
    const req = await tx.request.update({ where: { id: r.id }, data: { writtenByOfficer: true, gmailTo: input.to.trim(), version: { increment: 1 } } });
    await recordAudit(tx, { caseId, actorId: user.id, action: "request.mail_written", objectType: "Request", objectId: r.id, summary: `${user.displayName} started a mail of their own (${r.reference})` });
    return { id: r.id, version: req.version, subject: r.subject, reference: r.reference };
  });
  const { kickGmailSync } = await import("../gmail/runner");
  kickGmailSync(created.id);
  return { requestId: created.id, version: created.version, subject: created.subject, reference: created.reference, key: keyOf(input.to.trim(), created.subject, input.body.trim(), input.attachmentIds, []) };
}

/**
 * Sets aside a mail an officer wrote and never sent (on their request). Nothing is deleted: it is marked discarded,
 * leaves the lists, and its copy in Gmail's Drafts is removed. A request the rules proposed is deferred instead.
 */
export async function discardOfficerMail(db: Db, user: SessionUser, requestId: string, api?: GmailApi): Promise<{ discarded: boolean }> {
  const { req } = await loadForWindow(db, user, requestId, "write");
  if (!req.writtenByOfficer) throw new AppError("Only a mail written from New mail can be discarded. Defer a proposed request instead.", "PRECONDITION");
  if (!["DRAFT", "AWAITING_APPROVAL"].includes(req.status) || req.submittedAt) throw new AppError("This mail has been sent or approved; it is kept.", "PRECONDITION");
  if (req.createdById !== user.id && user.role !== "SUPERVISOR") throw new AppError("Only the officer who wrote this mail, or a supervisor, can discard it.", "FORBIDDEN");
  if (req.gmailDraftId) {
    try {
      const gm = api ?? (await import("../gmail/api")).liveGmail;
      await gm.deleteDraft?.(req.gmailDraftId);
    } catch {
      /* the Gmail copy may already be gone; the mail is still set aside here */
    }
  }
  await db.$transaction(async (tx) => {
    await tx.request.update({ where: { id: requestId }, data: { status: "DISCARDED", liveJson: null, liveAt: null, liveById: null, gmailDraftId: null, version: { increment: 1 } } });
    await recordAudit(tx, { caseId: req.caseId, actorId: user.id, action: "request.mail_discarded", objectType: "Request", objectId: requestId, summary: `${req.reference} (a mail ${user.displayName} wrote) discarded before it was sent` });
  });
  return { discarded: true };
}

export type { MailField };
