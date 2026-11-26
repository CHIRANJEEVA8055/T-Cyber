import crypto from "node:crypto";
import { now } from "../clock";
import { storedFrom } from "./mail-defaults";
import {
  checkApprovalPermission,
  checkSubmissionReadiness,
  isEditableStatus,
  nextRequestStatus,
} from "@/domain/request-workflow";
import type { Db, Tx } from "../db";
import type { SessionUser } from "../auth/session";
import { loadCaseForUser } from "../auth/access";
import { recordAudit } from "../audit";
import { AppError, conflictError, notFoundError } from "../errors";
import { isSimulatedChannel, simulateSend, SIMULATED_CHANNELS } from "../adapters/submission";
import { recordHoldRequestedTx } from "./funds";
import { deliverySettings, getAppConfig } from "../config";
import { sendMail } from "../mail/outbox";
import { istInputToUtc } from "@/domain/time";
import { gmailStatus } from "../gmail/oauth";
import type { GmailApi } from "../gmail/api";
import { assistantAuthorId } from "../assistant-identity";
import { addressProblem, splitAddresses } from "@/domain/mail-check";
import { caseRefKey, coreRef, formatRequestRef, letterFor, refVariants, reminderRef } from "@/domain/request-ref";

const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVE_STATUSES = ["DRAFT", "AWAITING_APPROVAL", "APPROVED", "SUBMITTED", "ACKNOWLEDGED", "PARTIAL_RESPONSE", "SUBMISSION_FAILED"];

export interface DraftItem {
  label: string;
  itemType: string;
}

export interface DraftInput {
  caseId: string;
  category: string;
  recipientId: string;
  routeId?: string | null;
  subject: string;
  body: string;
  scope: string;
  periodFrom: Date | null;
  periodTo: Date | null;
  items: DraftItem[];
  subjectEntityIds: string[];
  attachmentIds?: string[];
  taskId?: string | null;
  parentRequestId?: string | null;
  allowDuplicateReason?: string | null;
  /** Who wrote the wording, when not the acting officer (the station's assistant for rule-prepared drafts). */
  authorId?: string | null;
  /** The mailbox it is sent from; null or absent is the station mailbox. */
  fromAddress?: string | null;
  /** Saved as typed (a mail the officer is still writing); its fields are checked when it is sent. */
  lenient?: boolean;
}

export interface DraftUpdateInput {
  expectedVersion: number;
  recipientId: string;
  subject: string;
  body: string;
  scope: string;
  periodFrom: Date | null;
  periodTo: Date | null;
  items: DraftItem[];
  attachmentIds: string[];
  changeNote?: string | null;
  /** The mailbox it is sent from; absent keeps the current version's, null is the station mailbox. */
  fromAddress?: string | null;
  /** Saved as typed (the mail window saves while the officer writes); the fields are checked when it is sent. */
  lenient?: boolean;
}

export function computeContentHash(c: {
  recipientId: string;
  subject: string;
  body: string;
  scope: string;
  periodFrom: Date | null;
  periodTo: Date | null;
  attachmentIds: string[];
  items: DraftItem[];
  fromAddress?: string | null;
}): string {
  const canonical = JSON.stringify({
    // The station mailbox adds nothing, so versions written before From addresses were kept hash as they did.
    ...(c.fromAddress ? { fromAddress: c.fromAddress.trim().toLowerCase() } : {}),
    recipientId: c.recipientId,
    subject: c.subject.trim(),
    body: c.body.trim(),
    scope: c.scope.trim(),
    periodFrom: c.periodFrom ? c.periodFrom.toISOString() : null,
    periodTo: c.periodTo ? c.periodTo.toISOString() : null,
    attachmentIds: [...c.attachmentIds].sort(),
    items: c.items.map((i) => ({ label: i.label.trim(), itemType: i.itemType })),
  });
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

/**
 * A new request's reference: R.REQ-412/2026-002 (its kind, the case and the request's serial in it), a reminder's
 * R.REQ-412/2026-002-R1. A case with neither an FIR number nor an NCRP acknowledgement takes the station-wide
 * R.REQ-2026-0001 form. If the reference is already taken (the same FIR number at another station in this database),
 * the station's code is added.
 */
async function referenceFor(tx: Tx, actor: SessionUser, kase: { id: string; firNumber: number | null; firYear: number | null; complaintRef: string | null }, caseSeq: number | null, parentRequestId: string | null, category: string): Promise<string> {
  const prefix = getAppConfig().requests.referencePrefix;
  let ref: string | null = null;
  if (parentRequestId) {
    const parent = await tx.request.findUnique({ where: { id: parentRequestId }, select: { reference: true, caseId: true } });
    if (parent && parent.caseId === kase.id) ref = reminderRef(parent.reference, (await tx.request.count({ where: { parentRequestId } })) + 1);
  } else {
    const key = caseRefKey(kase);
    if (key && caseSeq) ref = formatRequestRef(prefix, key, caseSeq, category);
  }
  const fallback = async () => `${letterFor(category)}.${await nextReference(tx, now().getUTCFullYear())}`;
  if (!ref) return fallback();
  // Taken in any of its forms (another kind's letter on the same core, or as a legacy reference).
  const taken = async (r: string) => {
    const forms = refVariants(coreRef(r, prefix));
    return !!(await tx.request.findFirst({ where: { OR: [{ reference: { in: forms } }, { legacyReference: { in: forms } }] }, select: { id: true } }));
  };
  if (!(await taken(ref))) return ref;
  const withStation = `${ref}-${actor.stationCode}`;
  if (!(await taken(withStation))) return withStation;
  return fallback();
}

async function nextReference(tx: Tx, year: number): Promise<string> {
  const key = `${getAppConfig().requests.referencePrefix}-${year}`;
  const row = await tx.counter.upsert({ where: { key }, create: { key, value: 1 }, update: { value: { increment: 1 } } });
  return `${key}-${row.value.toString().padStart(4, "0")}`;
}

async function loadRequestForUser(tx: Tx, user: SessionUser, requestId: string, mode: "read" | "write" = "write") {
  const req = await tx.request.findUnique({ where: { id: requestId }, include: { recipient: true } });
  if (!req) throw notFoundError("request");
  await loadCaseForUser(tx, user, req.caseId, mode);
  return req;
}

async function currentVersion(tx: Tx, requestId: string, versionNo: number) {
  const v = await tx.requestVersion.findUnique({ where: { requestId_versionNo: { requestId, versionNo } } });
  if (!v) throw notFoundError("request version");
  return v;
}

function assertVersion(actual: number, expected: number) {
  if (actual !== expected) {
    throw conflictError("This request was changed by someone else since you opened it. Reload to see the latest version, then try again.");
  }
}

export async function getRequestState(tx: Tx, requestId: string) {
  const req = await tx.request.findUniqueOrThrow({ where: { id: requestId } });
  const v = await currentVersion(tx, requestId, req.currentVersionNo);
  return { ...req, subject: v.subject, body: v.body, scope: v.scope, contentHash: v.contentHash };
}

function validateDraftText(input: { subject: string; body: string; scope: string }) {
  const fieldErrors: Record<string, string> = {};
  if (input.subject.trim().length < 5) fieldErrors.subject = "Enter a subject of at least 5 characters.";
  if (input.body.trim().length < 20) fieldErrors.body = "Enter the request text (at least 20 characters).";
  if (input.scope.trim().length < 5) fieldErrors.scope = "Describe what is being requested.";
  if (Object.keys(fieldErrors).length) throw new AppError("Some fields need attention.", "VALIDATION", fieldErrors);
}

export async function createDraftTx(tx: Tx, actor: SessionUser, input: DraftInput) {
  const kase = await loadCaseForUser(tx, actor, input.caseId, "write");
  if (!input.lenient) validateDraftText(input);
  const recipient = await tx.recipient.findUnique({ where: { id: input.recipientId } });
  // The stand-in for an addressee not yet known is switched off in the directory, but a draft may point at it.
  if (!recipient || (!recipient.active && !["UNADDRESSED", "MANUAL"].includes(recipient.organisationType))) throw new AppError("Choose a recipient from the routing directory.", "VALIDATION", { recipientId: "Choose a recipient." });
  const categories = JSON.parse(recipient.categoriesJson) as string[];
  if (!categories.includes(input.category)) {
    throw new AppError(`${recipient.name} is not configured in the directory to receive ${input.category.toLowerCase()} requests.`, "VALIDATION", {
      recipientId: "This recipient does not accept this request type.",
    });
  }

  if (!input.parentRequestId && input.subjectEntityIds.length > 0) {
    const duplicates = await tx.request.findMany({
      where: {
        caseId: kase.id,
        category: input.category,
        // The same question to a different organisation (the operator's CDR, WhatsApp's records) is not a duplicate.
        recipientId: input.recipientId,
        status: { in: ACTIVE_STATUSES },
        subjects: { some: { entityId: { in: input.subjectEntityIds } } },
      },
      select: { reference: true, status: true },
    });
    if (duplicates.length > 0 && !input.allowDuplicateReason?.trim()) {
      throw new AppError(
        `A similar ${input.category.toLowerCase()} request is already active for this identifier: ${duplicates.map((d) => `${d.reference} (${d.status.replace(/_/g, " ").toLowerCase()})`).join(", ")}. Open it instead, or give a reason to create another.`,
        "CONFLICT",
      );
    }
  }

  const authorId = input.authorId ?? actor.id;
  // A request's serial in its case is the "002" of REQ-412/2026-002. A reminder carries its parent's reference with
  // "-R1", "-R2", so it takes no serial of its own.
  const caseSeq = input.parentRequestId ? null : ((await tx.request.aggregate({ where: { caseId: kase.id }, _max: { caseSeq: true } }))._max.caseSeq ?? 0) + 1;
  const reference = await referenceFor(tx, actor, kase, caseSeq, input.parentRequestId ?? null, input.category);
  const attachmentIds = input.attachmentIds ?? [];
  const fromAddress = storedFrom(input.fromAddress);
  // Templates may contain {{requestReference}}; it becomes this draft's own reference.
  input = { ...input, subject: input.subject.replaceAll("{{requestReference}}", reference), body: input.body.replaceAll("{{requestReference}}", reference) };
  const hash = computeContentHash({ ...input, attachmentIds, fromAddress });
  const request = await tx.request.create({
    data: {
      caseId: kase.id,
      reference,
      caseSeq,
      category: input.category,
      status: "DRAFT",
      routeId: input.routeId ?? null,
      recipientId: recipient.id,
      channel: recipient.channel,
      taskId: input.taskId ?? null,
      parentRequestId: input.parentRequestId ?? null,
      createdById: authorId,
      createdAt: now(),
      versions: {
        create: {
          createdAt: now(),
          versionNo: 1,
          recipientId: recipient.id,
          subject: input.subject.trim(),
          body: input.body.trim(),
          periodFrom: input.periodFrom,
          periodTo: input.periodTo,
          scope: input.scope.trim(),
          attachmentIdsJson: JSON.stringify(attachmentIds),
          contentHash: hash,
          basisJson: JSON.stringify({ items: input.items }),
          fromAddress: fromAddress,
          createdById: authorId,
        },
      },
      items: { create: input.items.map((it, i) => ({ label: it.label, itemType: it.itemType, sortOrder: i })) },
      subjects: { create: [...new Set(input.subjectEntityIds)].map((entityId) => ({ entityId })) },
    },
  });
  if (input.taskId) {
    await tx.task.updateMany({ where: { id: input.taskId, caseId: kase.id }, data: { requestId: request.id, status: "DRAFT_PREPARED", version: { increment: 1 } } });
  }
  await recordAudit(tx, {
    caseId: kase.id,
    actorId: authorId,
    action: "request.draft_created",
    objectType: "Request",
    objectId: request.id,
    summary: `Draft ${reference} prepared for ${recipient.name}${authorId !== actor.id ? " by the assistant, for approval" : ""}`,
    detail: { category: input.category, duplicateReason: input.allowDuplicateReason ?? null, parentRequestId: input.parentRequestId ?? null },
  });
  return getRequestState(tx, request.id);
}

export function createDraft(db: Db, actor: SessionUser, input: DraftInput) {
  return db.$transaction((tx) => createDraftTx(tx, actor, input));
}

export function updateDraft(db: Db, actor: SessionUser, requestId: string, input: DraftUpdateInput) {
  return db.$transaction((tx) => updateDraftTx(tx, actor, requestId, input, actor.id));
}

/** Writes a new version. authorId is the officer, except when the assistant re-renders its own draft. */
export async function updateDraftTx(tx: Tx, actor: SessionUser, requestId: string, input: DraftUpdateInput, authorId: string) {
  {
    const req = await loadRequestForUser(tx, actor, requestId);
    assertVersion(req.version, input.expectedVersion);
    if (!input.lenient) validateDraftText(input);
    const transition = nextRequestStatus(req.status, { type: "EDIT" });
    if (!transition.ok) throw new AppError(transition.error, "PRECONDITION");
    const recipient = await tx.recipient.findUnique({ where: { id: input.recipientId } });
    if (!recipient) throw new AppError("Choose a recipient from the routing directory.", "VALIDATION", { recipientId: "Choose a recipient." });

    const current = await currentVersion(tx, requestId, req.currentVersionNo);
    const fromAddress = input.fromAddress === undefined ? current.fromAddress : storedFrom(input.fromAddress);
    const hash = computeContentHash({ ...input, fromAddress });
    if (hash === current.contentHash) return getRequestState(tx, requestId);

    const versionNo = req.currentVersionNo + 1;
    await tx.requestVersion.create({
      data: {
        createdAt: now(),
        requestId,
        versionNo,
        recipientId: recipient.id,
        subject: input.subject.trim(),
        body: input.body.trim(),
        periodFrom: input.periodFrom,
        periodTo: input.periodTo,
        scope: input.scope.trim(),
        attachmentIdsJson: JSON.stringify(input.attachmentIds),
        contentHash: hash,
        basisJson: JSON.stringify({ items: input.items }),
        changeNote: input.changeNote ?? null,
        fromAddress,
        createdById: authorId,
      },
    });
    await tx.requestItem.deleteMany({ where: { requestId } });
    await tx.requestItem.createMany({ data: input.items.map((it, i) => ({ requestId, label: it.label, itemType: it.itemType, sortOrder: i })) });

    const invalidated = req.approvedVersionNo !== null;
    if (invalidated) {
      await tx.approval.updateMany({
        where: { requestId, invalidatedAt: null, decision: "APPROVED" },
        data: { invalidatedAt: now(), invalidatedReason: `Content edited after approval (version ${req.currentVersionNo} to ${versionNo}).` },
      });
    }
    await tx.request.update({
      where: { id: requestId },
      data: {
        currentVersionNo: versionNo,
        status: transition.status,
        recipientId: recipient.id,
        channel: recipient.channel,
        approvedVersionNo: null,
        approvedHash: null,
        // The IO's copy is out of date once the wording changes: it is mailed again after the new approval.
        handedOverAt: null,
        handedOverTo: null,
        version: { increment: 1 },
      },
    });
    await recordAudit(tx, {
      caseId: req.caseId,
      actorId: actor.id,
      action: "request.version_created",
      objectType: "Request",
      objectId: requestId,
      summary: `${req.reference} edited (version ${versionNo})`,
      detail: { changeNote: input.changeNote ?? null },
    });
    if (invalidated) {
      await recordAudit(tx, {
        caseId: req.caseId,
        actorId: actor.id,
        action: "request.approval_invalidated",
        objectType: "Request",
        objectId: requestId,
        summary: `Approval of ${req.reference} withdrawn because the approved content was edited`,
      });
    }
    return getRequestState(tx, requestId);
  }
}

/**
 * Narrows what an assistant-prepared draft asks for. The officer only chooses among the items the assistant
 * listed; the wording is re-rendered by removing those items' lines, so the version remains the assistant's and
 * the officer can still approve it. Any other change goes through the editor, which makes the officer the author.
 */
export function rescopeDraft(db: Db, actor: SessionUser, requestId: string, input: { expectedVersion: number; keepItemIds: string[] }) {
  return db.$transaction(async (tx) => {
    const req = await loadRequestForUser(tx, actor, requestId);
    assertVersion(req.version, input.expectedVersion);
    if (req.status !== "DRAFT") throw new AppError("Only a draft that has not gone for approval can change what it asks for.", "PRECONDITION");
    const v = await currentVersion(tx, requestId, req.currentVersionNo);
    const kase = await tx.case.findUniqueOrThrow({ where: { id: req.caseId } });
    const assistantId = await assistantAuthorId(tx, kase.stationId);
    if (!assistantId || v.createdById !== assistantId) throw new AppError("This version was written by an officer. Change what it asks for in the request editor.", "PRECONDITION");
    const items = await tx.requestItem.findMany({ where: { requestId }, orderBy: { sortOrder: "asc" } });
    const keep = items.filter((i) => input.keepItemIds.includes(i.id));
    if (!keep.length) throw new AppError("Tick at least one item to ask for.", "VALIDATION", { items: "Tick at least one item." });
    const drop = items.filter((i) => !input.keepItemIds.includes(i.id));
    if (!drop.length) return getRequestState(tx, requestId);
    let body = v.body;
    for (const i of drop) {
      const lines = body.split("\n");
      const at = lines.findIndex((l) => l.replace(/^\s*(?:[-•]|\d+[.)])\s*/, "").trim() === i.label.trim());
      if (at < 0) throw new AppError("The wording no longer lists this item on its own line. Change it in the request editor.", "PRECONDITION");
      lines.splice(at, 1);
      body = lines.join("\n");
    }
    const attachmentIds = JSON.parse(v.attachmentIdsJson) as string[];
    return updateDraftTx(
      tx,
      actor,
      requestId,
      {
        expectedVersion: req.version,
        recipientId: v.recipientId,
        subject: v.subject,
        body,
        scope: v.scope,
        periodFrom: v.periodFrom,
        periodTo: v.periodTo,
        items: keep.map((i) => ({ label: i.label, itemType: i.itemType })),
        attachmentIds,
        changeNote: `${actor.rank === "Sub-Inspector" ? "SI" : actor.rank} ${actor.displayName} removed: ${drop.map((i) => i.label).join("; ")}`,
      },
      assistantId,
    );
  });
}

export type SendOutcome =
  | { outcome: "SUCCEEDED"; reference: string; externalReference: string | null; at: string; followUpAt: string | null; channel: string; attachments: number }
  | { outcome: "FAILED"; error: string }
  | { outcome: "PORTAL"; reference: string }
  | { outcome: "HANDED_OVER"; reference: string; to: string; at: string; transport: "SIMULATED" | "SMTP"; attachments: number }
  | { outcome: "APPROVED_GMAIL"; reference: string };

/**
 * "Approve and send" from Next actions: approves the current version (never one the officer wrote) and submits it
 * through the simulated adapter. A portal request is approved and then waits for the portal reference.
 */
export async function approveAndSend(db: Db, actor: SessionUser, requestId: string, input: { expectedVersion: number; idempotencyKey: string }): Promise<SendOutcome> {
  let version = input.expectedVersion;
  const req = await db.request.findUnique({ where: { id: requestId } });
  if (!req) throw notFoundError("request");
  if (req.status === "DRAFT") version = (await requestApproval(db, actor, requestId, version)).version;
  if (req.status === "DRAFT" || req.status === "AWAITING_APPROVAL") {
    try {
      version = (await approveRequest(db, actor, requestId, version, "Approved from Next actions")).version;
    } catch (err) {
      // The officer may not approve this version (they wrote it, or the route needs a supervisor): it stays
      // with the approver rather than going back to draft.
      if (err instanceof AppError && err.code === "FORBIDDEN") throw new AppError(`${err.message} It is now waiting for approval.`, "FORBIDDEN");
      throw err;
    }
  }
  const fresh = await db.request.findUniqueOrThrow({ where: { id: requestId }, include: { versions: { orderBy: { versionNo: "desc" }, take: 1 } } });
  // Gmail: approved here, sent only when the officer types (or confirms) the To address and presses Send (a portal
  // provider can be mailed too).
  if (deliverySettings().mode === "gmail") return { outcome: "APPROVED_GMAIL", reference: fresh.reference };
  if (fresh.channel === "PORTAL") return { outcome: "PORTAL", reference: fresh.reference };
  // v1: approved requests go to the PS IO's mailbox, and the IO forwards them from their own mailbox.
  if (deliverySettings().mode === "via-io") return handOverToIo(db, actor, requestId, { expectedVersion: version, idempotencyKey: input.idempotencyKey });
  const r = await submitRequest(db, actor, requestId, { expectedVersion: version, confirmed: true, idempotencyKey: input.idempotencyKey });
  if (r.outcome === "FAILED") return { outcome: "FAILED", error: r.error ?? "The simulated send failed." };
  const sent = await db.request.findUniqueOrThrow({ where: { id: requestId } });
  return {
    outcome: "SUCCEEDED",
    reference: sent.reference,
    externalReference: r.externalReference,
    at: (sent.submittedAt ?? now()).toISOString(),
    followUpAt: sent.followUpAt?.toISOString() ?? null,
    channel: sent.channel,
    attachments: (JSON.parse(fresh.versions[0]!.attachmentIdsJson) as string[]).length,
  };
}

/** A draft written before its addressee was known is edited and printed, but not approved or sent until addressed. */
const NOT_ADDRESSED = "This draft has no addressee yet. Record the missing detail (Next actions says what it is and how to find it), then address the draft; it can be approved and sent after that.";
/** With Gmail, the address the officer typed is the addressee: a draft with a real typed address is addressed. */
export function hasTypedTo(req: { gmailTo: string | null }): boolean {
  if (deliverySettings().mode !== "gmail" || !req.gmailTo) return false;
  const list = splitAddresses(req.gmailTo);
  return list.length > 0 && list.every((a) => !addressProblem(a));
}
function assertAddressed(req: { gmailTo: string | null; recipient: { organisationType: string } }) {
  if ((req.recipient.organisationType === "UNADDRESSED" || req.recipient.organisationType === "MANUAL") && !hasTypedTo(req)) throw new AppError(NOT_ADDRESSED, "PRECONDITION");
}

export function requestApproval(db: Db, actor: SessionUser, requestId: string, expectedVersion: number) {
  return db.$transaction(async (tx) => {
    const req = await loadRequestForUser(tx, actor, requestId);
    assertVersion(req.version, expectedVersion);
    assertAddressed(req);
    const t = nextRequestStatus(req.status, { type: "REQUEST_APPROVAL" });
    if (!t.ok) throw new AppError(t.error, "PRECONDITION");
    await tx.request.update({ where: { id: requestId }, data: { status: t.status, version: { increment: 1 } } });
    await recordAudit(tx, { caseId: req.caseId, actorId: actor.id, action: "request.approval_requested", objectType: "Request", objectId: requestId, summary: `${req.reference} sent for approval (version ${req.currentVersionNo})` });
    return getRequestState(tx, requestId);
  });
}

/**
 * Who approves a request: its route's approval role. A mail an officer wrote follows no route: investigating
 * officers approve it, as most routes have it. A draft written before its addressee was known has no route yet: it
 * takes the role of the route its kind of request (category and identifier) would take; a supervisor otherwise.
 */
export async function approvalRoleOf(db: Db | Tx, req: { id: string; routeId: string | null; writtenByOfficer: boolean; category: string }): Promise<string> {
  if (req.routeId) return approvalRoleFor(db, req.routeId);
  if (req.writtenByOfficer) return "INVESTIGATING_OFFICER";
  const subject = await db.requestSubject.findFirst({ where: { requestId: req.id }, include: { entity: { select: { kind: true } } } });
  if (!subject) return "SUPERVISOR";
  const rules = await db.routingRule.findMany({ where: { subjectKind: subject.entity.kind, category: req.category, active: true }, select: { approvalRole: true } });
  return rules.length && rules.every((r) => r.approvalRole === "INVESTIGATING_OFFICER") ? "INVESTIGATING_OFFICER" : "SUPERVISOR";
}

async function approvalRoleFor(tx: Db | Tx, routeId: string | null, writtenByOfficer = false): Promise<string> {
  // A mail an officer wrote from New mail follows no route: the investigating officers approve it, as most routes do.
  if (!routeId) return writtenByOfficer ? "INVESTIGATING_OFFICER" : "SUPERVISOR";
  const route = await tx.routingRule.findUnique({ where: { id: routeId } });
  return route?.approvalRole ?? "SUPERVISOR";
}

export function approveRequest(db: Db, actor: SessionUser, requestId: string, expectedVersion: number, note: string | null) {
  return db.$transaction(async (tx) => {
    const req = await loadRequestForUser(tx, actor, requestId);
    assertVersion(req.version, expectedVersion);
    assertAddressed(req);
    const v = await currentVersion(tx, requestId, req.currentVersionNo);
    const perm = checkApprovalPermission({
      status: req.status,
      actorId: actor.id,
      actorRole: actor.role,
      versionAuthorId: v.createdById,
      requiredRole: await approvalRoleOf(tx, req),
    });
    if (!perm.ok) throw new AppError(perm.reason, "FORBIDDEN");
    const t = nextRequestStatus(req.status, { type: "APPROVE" });
    if (!t.ok) throw new AppError(t.error, "PRECONDITION");
    await tx.approval.create({ data: { requestId, versionNo: v.versionNo, contentHash: v.contentHash, decision: "APPROVED", note, decidedById: actor.id, decidedAt: now() } });
    await tx.request.update({
      where: { id: requestId },
      data: { status: t.status, approvedVersionNo: v.versionNo, approvedHash: v.contentHash, version: { increment: 1 } },
    });
    await recordAudit(tx, { caseId: req.caseId, actorId: actor.id, action: "request.approved", objectType: "Request", objectId: requestId, summary: `${req.reference} version ${v.versionNo} approved`, detail: { contentHash: v.contentHash, note } });
    return getRequestState(tx, requestId);
  });
}

/**
 * Approval as part of pressing Send in the mail window. The usual rule applies (another officer approves a version
 * its author wrote; a supervisor route needs a supervisor), except that with gmail.senderApproves on, the officer
 * who sends a version they wrote approves it by sending it, which is logged as such. A route that needs a supervisor
 * still needs one: the request then waits for them, and nothing is sent.
 */
export async function approveForSending(db: Db, actor: SessionUser, requestId: string, expectedVersion: number): Promise<{ approved: true; version: number } | { approved: false; version: number; reason: string }> {
  let version = expectedVersion;
  const req = await db.request.findUnique({ where: { id: requestId } });
  if (!req) throw notFoundError("request");
  if (req.status === "APPROVED" || req.status === "SUBMISSION_FAILED") return { approved: true, version };
  if (req.status === "DRAFT") version = (await requestApproval(db, actor, requestId, version)).version;
  try {
    return { approved: true, version: (await approveRequest(db, actor, requestId, version, "Approved when sent from the mail window")).version };
  } catch (err) {
    if (!(err instanceof AppError && err.code === "FORBIDDEN")) throw err;
    const { gmailSettings } = await import("../gmail/oauth");
    const own = /You prepared this version/.test(err.message);
    if (!own || !gmailSettings().senderApproves) return { approved: false, version, reason: `${err.message} It is waiting for that approval; nothing was sent.` };
    return db.$transaction(async (tx) => {
      const r = await loadRequestForUser(tx, actor, requestId);
      assertVersion(r.version, version);
      assertAddressed(r);
      const v = await currentVersion(tx, requestId, r.currentVersionNo);
      // Only the author check is waived; the route's role still applies.
      const perm = checkApprovalPermission({ status: r.status, actorId: actor.id, actorRole: actor.role, versionAuthorId: `${v.createdById}:sender`, requiredRole: await approvalRoleOf(tx, r) });
      if (!perm.ok) return { approved: false as const, version: r.version, reason: `${perm.reason} It is waiting for that approval; nothing was sent.` };
      const t = nextRequestStatus(r.status, { type: "APPROVE" });
      if (!t.ok) throw new AppError(t.error, "PRECONDITION");
      await tx.approval.create({ data: { requestId, versionNo: v.versionNo, contentHash: v.contentHash, decision: "APPROVED", note: "Approved by its author on sending it (station setting: the sender approves)", decidedById: actor.id, decidedAt: now() } });
      const updated = await tx.request.update({ where: { id: requestId }, data: { status: t.status, approvedVersionNo: v.versionNo, approvedHash: v.contentHash, version: { increment: 1 } } });
      await recordAudit(tx, { caseId: r.caseId, actorId: actor.id, action: "request.approved_by_sender", objectType: "Request", objectId: requestId, summary: `${r.reference} version ${v.versionNo} approved by ${actor.displayName}, who wrote it, on sending it`, detail: { contentHash: v.contentHash } });
      return { approved: true as const, version: updated.version };
    });
  }
}

export function returnForChanges(db: Db, actor: SessionUser, requestId: string, expectedVersion: number, note: string) {
  return db.$transaction(async (tx) => {
    const req = await loadRequestForUser(tx, actor, requestId);
    assertVersion(req.version, expectedVersion);
    if (actor.role !== "SUPERVISOR") throw new AppError("Only a supervisor can return a request for changes.", "FORBIDDEN");
    if (note.trim().length < 3) throw new AppError("Say what needs to change.", "VALIDATION", { note: "Say what needs to change." });
    const t = nextRequestStatus(req.status, { type: "RETURN_FOR_CHANGES" });
    if (!t.ok) throw new AppError(t.error, "PRECONDITION");
    const v = await currentVersion(tx, requestId, req.currentVersionNo);
    await tx.approval.create({ data: { requestId, versionNo: v.versionNo, contentHash: v.contentHash, decision: "RETURNED", note, decidedById: actor.id, decidedAt: now() } });
    await tx.request.update({ where: { id: requestId }, data: { status: t.status, version: { increment: 1 } } });
    await recordAudit(tx, { caseId: req.caseId, actorId: actor.id, action: "request.returned", objectType: "Request", objectId: requestId, summary: `${req.reference} returned for changes`, detail: { note } });
    return getRequestState(tx, requestId);
  });
}

async function readiness(tx: Tx, req: Awaited<ReturnType<typeof loadRequestForUser>>, confirmed: boolean, opts: { officerTo?: boolean } = {}) {
  const v = await currentVersion(tx, req.id, req.currentVersionNo);
  if ((req.recipient.organisationType === "UNADDRESSED" || req.recipient.organisationType === "MANUAL") && !(opts.officerTo && hasTypedTo(req))) return { ok: false as const, reasons: [NOT_ADDRESSED] };
  // A real case is never sent to the demonstration directory, verified or not. (An address the officer typed
  // for Gmail is their own choice and is used instead of the directory's.)
  const kase = await tx.case.findUniqueOrThrow({ where: { id: req.caseId }, select: { isDemo: true } });
  if (!opts.officerTo && !kase.isDemo && req.recipient.isSynthetic && !["POLICE_UNIT", "NPCI"].includes(req.recipient.organisationType)) {
    return { ok: false as const, reasons: [`${req.recipient.organisation} is a demonstration directory entry; a real case's request is not sent to it. Re-address the draft from Next actions.`] };
  }
  return checkSubmissionReadiness({
    status: req.status,
    currentVersionNo: req.currentVersionNo,
    approvedVersionNo: req.approvedVersionNo,
    approvedHash: req.approvedHash,
    currentHash: v.contentHash,
    recipientVerification: opts.officerTo ? "VERIFIED" : req.recipient.verificationStatus,
    needsReview: req.needsReview,
    confirmed,
  });
}

async function followUpDate(tx: Tx, routeId: string | null, from: Date): Promise<Date> {
  const route = routeId ? await tx.routingRule.findUnique({ where: { id: routeId } }) : null;
  return new Date(from.getTime() + (route?.followUpDays ?? getAppConfig().requests.defaultFollowUpDays) * DAY_MS);
}

export interface SubmitInput {
  expectedVersion: number;
  confirmed: boolean;
  idempotencyKey: string;
  /**
   * Send through the (simulated) channel straight to the recipient even when requests are mailed to the IO: only the
   * demonstration seed sets it, to write the demo's history. Officers' actions never pass it.
   */
  direct?: boolean;
}

/** Simulated submission. Never contacts an external system. */
export function submitRequest(db: Db, actor: SessionUser, requestId: string, input: SubmitInput) {
  return db.$transaction(async (tx) => {
    const prior = await tx.submission.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (prior) {
      if (prior.requestId !== requestId) throw new AppError("This submission key belongs to another request.", "CONFLICT");
      return { submissionId: prior.id, outcome: prior.outcome as "SUCCEEDED" | "FAILED", error: prior.errorMessage, externalReference: prior.externalReference };
    }
    const req = await loadRequestForUser(tx, actor, requestId);
    assertVersion(req.version, input.expectedVersion);
    if (req.channel === "PORTAL") {
      throw new AppError("Portal requests are submitted by the officer on the provider's portal. Record the portal reference instead.", "PRECONDITION");
    }
    if (!isSimulatedChannel(req.channel)) throw new AppError(`No simulation adapter is configured for channel ${req.channel}.`, "PRECONDITION");
    if (deliverySettings().mode === "gmail" && !input.direct) throw new AppError("Requests are sent from the linked Gmail account: type the address and choose \"Send from Gmail\".", "PRECONDITION");
    if (deliverySettings().mode === "via-io" && !input.direct) throw new AppError(`Requests are mailed to the IO's mailbox (${deliverySettings().ioMailbox}) to forward; use "Mail to the IO" instead.`, "PRECONDITION");
    const ready = await readiness(tx, req, input.confirmed);
    if (!ready.ok) throw new AppError(ready.reasons.join(" "), "PRECONDITION");

    const meta = SIMULATED_CHANNELS[req.channel];
    const setting = await tx.integrationSetting.findUnique({ where: { key: meta.settingKey } });
    const v = await currentVersion(tx, requestId, req.currentVersionNo);
    const result = simulateSend({
      channel: req.channel,
      requestReference: req.reference,
      recipientAddress: req.recipient.address,
      fromAddress: v.fromAddress ?? getAppConfig().mailbox.fromAddress,
      contentHash: v.contentHash,
      failureSimulationEnabled: !!setting?.failNextSubmission,
    });
    if (setting?.failNextSubmission) {
      await tx.integrationSetting.update({ where: { key: meta.settingKey }, data: { failNextSubmission: false } });
    }
    const at = now();
    const submission = await tx.submission.create({
      data: {
        attemptedAt: now(),
        requestId,
        versionNo: v.versionNo,
        adapter: result.adapter,
        outcome: result.ok ? "SUCCEEDED" : "FAILED",
        externalReference: result.ok ? result.externalReference : null,
        errorMessage: result.ok ? null : result.error,
        recipientAddress: req.recipient.address,
        actorId: actor.id,
        idempotencyKey: input.idempotencyKey,
      },
    });
    if (result.ok) await markSubmittedTx(tx, req, actor, at, result.externalReference);
    else {
      const t = nextRequestStatus(req.status, { type: "SUBMIT_FAILED" });
      if (!t.ok) throw new AppError(t.error, "PRECONDITION");
      await tx.request.update({ where: { id: requestId }, data: { status: t.status, version: { increment: 1 } } });
    }
    await recordAudit(tx, {
      caseId: req.caseId,
      actorId: actor.id,
      action: result.ok ? "request.submitted" : "request.submission_failed",
      objectType: "Request",
      objectId: requestId,
      summary: result.ok
        ? `${req.reference} submitted through ${meta.inSentence}; nothing was sent`
        : `Simulated submission of ${req.reference} failed`,
      detail: { externalReference: result.ok ? result.externalReference : null, error: result.ok ? null : result.error, versionNo: v.versionNo },
    });
    return {
      submissionId: submission.id,
      outcome: result.ok ? ("SUCCEEDED" as const) : ("FAILED" as const),
      error: result.ok ? null : result.error,
      externalReference: result.ok ? result.externalReference : null,
    };
  });
}

/** The request has left the station (sent, submitted on a portal, or forwarded by the IO): follow-ups start now. */
async function markSubmittedTx(tx: Tx, req: { id: string; caseId: string; status: string; routeId: string | null; category: string }, actor: SessionUser, at: Date, externalReference: string | null) {
  const t = nextRequestStatus(req.status, { type: "SUBMIT_SUCCEEDED" });
  if (!t.ok) throw new AppError(t.error, "PRECONDITION");
  await tx.request.update({ where: { id: req.id }, data: { status: t.status, submittedAt: at, externalReference, followUpAt: await followUpDate(tx, req.routeId, at), version: { increment: 1 } } });
  await tx.task.updateMany({ where: { requestId: req.id, status: { in: ["OPEN", "DRAFT_PREPARED"] } }, data: { status: "WAITING", ...(externalReference ? { externalReference } : {}), version: { increment: 1 } } });
  if (req.category === "HOLD") {
    const subjects = await tx.requestSubject.findMany({ where: { requestId: req.id }, include: { entity: true } });
    for (const s of subjects) {
      if (["BANK_ACCOUNT", "UPI_ID", "WALLET"].includes(s.entity.kind)) await recordHoldRequestedTx(tx, req.caseId, req.id, s.entityId, actor.id);
    }
  }
}

/** The mail the IO receives: where to forward it, what to attach, then the request exactly as approved. */
function ioMail(req: { reference: string; recipient: { name: string; organisation: string; address: string } }, v: { subject: string; body: string }, files: string[], ioName: string): { subject: string; text: string } {
  const line = "-".repeat(64);
  return {
    subject: `Forward to ${req.recipient.organisation}: ${v.subject}`,
    text: [
      `${ioName},`,
      "",
      `Please forward the request below to ${req.recipient.name}, ${req.recipient.organisation}, from your mailbox:`,
      "",
      `  To:       ${req.recipient.address}`,
      `  Subject:  ${v.subject}`,
      `  Attach:   ${files.length ? `${files.join(", ")} (attached to this mail)` : "nothing"}`,
      "",
      `Send it as it is below. Then open ${req.reference} in T-CYBER and choose "Mark as forwarded", so its follow-up dates start from when it actually went.`,
      "",
      `${line}`,
      "",
      v.body,
      "",
    ].join("\n"),
  };
}

/**
 * v1 delivery: the approved request is mailed to the PS investigating officer's mailbox (configuration
 * delivery.ioMailbox) to forward to the nodal officer. It stays "approved, mailed to the IO" until the IO records that
 * it was forwarded. The mail is sent outside a database transaction (a mail server can take a while).
 */
export async function handOverToIo(db: Db, actor: SessionUser, requestId: string, input: { expectedVersion: number; idempotencyKey: string }): Promise<SendOutcome> {
  const d = deliverySettings();
  const prepared = await db.$transaction(async (tx) => {
    const prior = await tx.submission.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (prior) {
      if (prior.requestId !== requestId) throw new AppError("This submission key belongs to another request.", "CONFLICT");
      return { kind: "prior" as const, prior };
    }
    const req = await loadRequestForUser(tx, actor, requestId);
    assertVersion(req.version, input.expectedVersion);
    if (req.channel === "PORTAL") throw new AppError("Portal requests are submitted by the officer on the provider's portal. Record the portal reference instead.", "PRECONDITION");
    const ready = await readiness(tx, req, true);
    if (!ready.ok) throw new AppError(ready.reasons.join(" "), "PRECONDITION");
    const v = await currentVersion(tx, requestId, req.currentVersionNo);
    const attachmentIds = JSON.parse(v.attachmentIdsJson) as string[];
    const files = (await tx.evidenceItem.findMany({ where: { id: { in: attachmentIds } }, select: { fileName: true } })).map((f) => f.fileName);
    return { kind: "new" as const, req, v, attachmentIds, mail: ioMail(req, v, files, d.ioName) };
  });
  if (prepared.kind === "prior") {
    const r = await db.request.findUniqueOrThrow({ where: { id: requestId } });
    return prepared.prior.outcome === "SUCCEEDED" ? { outcome: "HANDED_OVER", reference: r.reference, to: prepared.prior.recipientAddress ?? d.ioMailbox, at: prepared.prior.attemptedAt.toISOString(), transport: /SMTP/.test(prepared.prior.adapter) ? "SMTP" : "SIMULATED", attachments: 0 } : { outcome: "FAILED", error: prepared.prior.errorMessage ?? "The mail to the IO failed." };
  }
  const { req, v, attachmentIds, mail } = prepared;
  const sent = await sendMail(db, { caseId: req.caseId, requestId, actorId: actor.id, to: d.ioMailbox, toName: d.ioName, from: v.fromAddress ?? getAppConfig().mailbox.fromAddress, fromName: "T-CYBER", subject: mail.subject, text: mail.text, attachmentIds });
  const at = now();
  const adapter = sent.transport === "SIMULATED" ? `Mailed to the IO mailbox ${d.ioMailbox} (simulated: kept in T-CYBER's outbox; nothing left this server)` : `Mailed to the IO mailbox ${d.ioMailbox} through the SMTP server`;
  await db.$transaction(async (tx) => {
    await tx.submission.create({ data: { attemptedAt: at, requestId, versionNo: v.versionNo, adapter, outcome: sent.ok ? "SUCCEEDED" : "FAILED", externalReference: null, errorMessage: sent.ok ? null : sent.error, recipientAddress: d.ioMailbox, actorId: actor.id, idempotencyKey: input.idempotencyKey } });
    if (sent.ok) await tx.request.update({ where: { id: requestId }, data: { handedOverAt: at, handedOverTo: d.ioMailbox, ...(req.status === "SUBMISSION_FAILED" ? { status: "APPROVED" } : {}), version: { increment: 1 } } });
    else {
      const t = nextRequestStatus(req.status, { type: "SUBMIT_FAILED" });
      await tx.request.update({ where: { id: requestId }, data: { ...(t.ok ? { status: t.status } : {}), version: { increment: 1 } } });
    }
    await recordAudit(tx, {
      caseId: req.caseId,
      actorId: actor.id,
      action: sent.ok ? "request.mailed_to_io" : "request.mail_to_io_failed",
      objectType: "Request",
      objectId: requestId,
      summary: sent.ok
        ? `${req.reference} mailed to the IO mailbox ${d.ioMailbox} to forward to ${req.recipient.organisation} (${req.recipient.address})${sent.transport === "SIMULATED" ? "; simulated, kept in T-CYBER's outbox, nothing left this server" : ""}`
        : `${req.reference} could not be mailed to the IO mailbox: ${sent.error}`,
      detail: { mailId: sent.mailId, transport: sent.transport, versionNo: v.versionNo },
    });
  });
  return sent.ok ? { outcome: "HANDED_OVER", reference: req.reference, to: d.ioMailbox, at: at.toISOString(), transport: sent.transport, attachments: attachmentIds.length } : { outcome: "FAILED", error: sent.error };
}

const EMAIL_RE = /^[^\s@<>(),;:"\[\]]+@[^\s@<>(),;:"\[\]]+\.[A-Za-z]{2,}$/;

/** "a@b.in, c@d.in" → the addresses, each checked; at most five. */
export function parseToList(raw: string): string[] {
  const list = raw.split(/[,;\s]+/).map((a) => a.trim().replace(/^<|>$/g, "")).filter(Boolean);
  if (!list.length) throw new AppError("Type the address to send it to.", "VALIDATION", { to: "Type the email address to send it to." });
  if (list.length > 5) throw new AppError("Send to at most five addresses.", "VALIDATION", { to: "At most five addresses." });
  const bad = list.find((a) => !EMAIL_RE.test(a));
  if (bad) throw new AppError(`"${bad.slice(0, 80)}" is not an email address.`, "VALIDATION", { to: `"${bad.slice(0, 80)}" is not an email address.` });
  return [...new Set(list.map((a) => a.toLowerCase()))];
}

/**
 * Gmail (prototype): the approved request is sent from the linked Gmail account to the address the officer typed.
 * The Gmail draft is first brought up to the approved version; if it was edited in Gmail since, that edit becomes a
 * new version needing approval and nothing is sent. Never sent without an approved, current version.
 */
export async function sendViaGmail(db: Db, actor: SessionUser, requestId: string, input: { expectedVersion: number; to: string; idempotencyKey: string }, api?: GmailApi): Promise<SendOutcome> {
  const to = parseToList(input.to);
  const gmail = gmailStatus();
  if (!gmail.enabled || !gmail.connected) throw new AppError(`Gmail is not ready: ${gmail.note}`, "PRECONDITION");
  const prepared = await db.$transaction(async (tx) => {
    const prior = await tx.submission.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (prior) {
      if (prior.requestId !== requestId) throw new AppError("This submission key belongs to another request.", "CONFLICT");
      return { kind: "prior" as const, prior };
    }
    const req = await loadRequestForUser(tx, actor, requestId);
    assertVersion(req.version, input.expectedVersion);
    // A provider that takes requests on its portal can still be mailed: the officer typed where it goes.
    const ready = await readiness(tx, req, true, { officerTo: true });
    if (!ready.ok) throw new AppError(ready.reasons.join(" "), "PRECONDITION");
    await tx.request.update({ where: { id: requestId }, data: { gmailTo: to.join(", ") } });
    return { kind: "new" as const, req };
  });
  if (prepared.kind === "prior") {
    const r = await db.request.findUniqueOrThrow({ where: { id: requestId } });
    return prepared.prior.outcome === "SUCCEEDED"
      ? { outcome: "SUCCEEDED", reference: r.reference, externalReference: r.externalReference, at: prepared.prior.attemptedAt.toISOString(), followUpAt: r.followUpAt?.toISOString() ?? null, channel: r.channel, attachments: 0 }
      : { outcome: "FAILED", error: prepared.prior.errorMessage ?? "Sending from Gmail failed." };
  }
  const { req } = prepared;
  const { syncRequestWithGmail } = await import("../gmail/sync");
  const { liveGmail } = await import("../gmail/api");
  const gm = api ?? liveGmail;
  const at = now();
  let error: string | null = null;
  let sentId: string | null = null;
  let threadId: string | null = null;
  try {
    let outcome = await syncRequestWithGmail(db, requestId, gm);
    if (outcome === "missing") outcome = await syncRequestWithGmail(db, requestId, gm, { recreate: true });
    if (outcome === "pulled") {
      const after = await db.request.findUniqueOrThrow({ where: { id: requestId } });
      if (after.currentVersionNo !== req.currentVersionNo) throw new AppError("The draft was edited in Gmail after it was approved. The edit is now in T-CYBER as a new version: check it and approve it again. Nothing was sent.", "CONFLICT");
    }
    const linked = await db.request.findUniqueOrThrow({ where: { id: requestId } });
    // Last look: a Gmail edit in the moment since the sync stops the send.
    const remote = await gm.getDraft(linked.gmailDraftId!);
    if (!remote || remote.messageId !== linked.gmailMessageId) throw new AppError("The Gmail draft changed just now. Nothing was sent; try again in a moment.", "CONFLICT");
    const sent = await gm.sendDraft(linked.gmailDraftId!);
    sentId = sent.messageId;
    threadId = sent.threadId ?? null;
  } catch (err) {
    if (err instanceof AppError && err.code === "CONFLICT") throw err;
    error = `Gmail did not send it: ${(err as Error).message} Nothing was sent.`;
  }
  const account = gmail.connectedAs ?? gmail.account ?? "the Gmail account";
  await db.$transaction(async (tx) => {
    await tx.submission.create({ data: { attemptedAt: at, requestId, versionNo: req.currentVersionNo, adapter: `Sent from Gmail (${account}) to ${to.join(", ")}`, outcome: sentId ? "SUCCEEDED" : "FAILED", externalReference: null, errorMessage: error, recipientAddress: to.join(", "), actorId: actor.id, idempotencyKey: input.idempotencyKey } });
    if (sentId) {
      await tx.request.update({ where: { id: requestId }, data: { gmailDraftId: null, gmailMessageId: sentId, gmailThreadId: threadId, gmailError: null, gmailSyncedAt: at, channel: "EMAIL" } });
      await markSubmittedTx(tx, req, actor, at, null);
    } else {
      const t = nextRequestStatus(req.status, { type: "SUBMIT_FAILED" });
      await tx.request.update({ where: { id: requestId }, data: { ...(t.ok ? { status: t.status } : {}), version: { increment: 1 } } });
    }
    await recordAudit(tx, {
      caseId: req.caseId,
      actorId: actor.id,
      action: sentId ? "request.sent_gmail" : "request.send_gmail_failed",
      objectType: "Request",
      objectId: requestId,
      summary: sentId ? `${req.reference} sent from Gmail (${account}) to ${to.join(", ")} by ${actor.displayName}` : `${req.reference} could not be sent from Gmail: ${error}`,
      detail: { versionNo: req.currentVersionNo, to },
    });
  });
  if (!sentId) return { outcome: "FAILED", error: error! };
  const sent = await db.request.findUniqueOrThrow({ where: { id: requestId }, include: { versions: { where: { versionNo: req.currentVersionNo } } } });
  return { outcome: "SUCCEEDED", reference: sent.reference, externalReference: null, at: at.toISOString(), followUpAt: sent.followUpAt?.toISOString() ?? null, channel: sent.channel, attachments: (JSON.parse(sent.versions[0]!.attachmentIdsJson) as string[]).length };
}

/** The officer asks to bring the Gmail draft up to date now (and to put it back if it was deleted in Gmail). */
export async function resyncGmailDraft(db: Db, actor: SessionUser, requestId: string, api?: GmailApi) {
  const req = await db.$transaction((tx) => loadRequestForUser(tx, actor, requestId));
  if (!["DRAFT", "AWAITING_APPROVAL", "APPROVED", "SUBMISSION_FAILED"].includes(req.status)) throw new AppError("This request has been sent; there is no draft to keep in Gmail.", "PRECONDITION");
  const gmail = gmailStatus();
  if (!gmail.enabled || !gmail.connected) throw new AppError(`Gmail is not ready: ${gmail.note}`, "PRECONDITION");
  const { syncRequestWithGmail } = await import("../gmail/sync");
  const { liveGmail } = await import("../gmail/api");
  const gm = api ?? liveGmail;
  let out = await syncRequestWithGmail(db, requestId, gm);
  if (out === "missing") out = await syncRequestWithGmail(db, requestId, gm, { recreate: true });
  return out;
}

/**
 * The IO forwarded the request to the nodal officer from their own mailbox: it is recorded as sent at that time, and
 * its follow-up dates start from then.
 */
export function recordForwarded(db: Db, actor: SessionUser, requestId: string, input: { expectedVersion: number; forwardedAt?: string | null; note?: string | null }) {
  return db.$transaction(async (tx) => {
    const req = await loadRequestForUser(tx, actor, requestId);
    assertVersion(req.version, input.expectedVersion);
    if (req.channel === "PORTAL") throw new AppError("This request goes through the provider's portal: record the portal reference instead.", "PRECONDITION");
    const ready = await readiness(tx, req, true);
    if (!ready.ok) throw new AppError(ready.reasons.join(" "), "PRECONDITION");
    const at = input.forwardedAt ? istInputToUtc(input.forwardedAt) : now();
    if (!at) throw new AppError("Enter when it was forwarded.", "VALIDATION", { forwardedAt: "Enter the date and time it was forwarded." });
    if (at.getTime() > now().getTime() + 5 * 60 * 1000) throw new AppError("The time it was forwarded is in the future.", "VALIDATION", { forwardedAt: "Enter a time that has passed." });
    if (req.handedOverAt && at < new Date(req.handedOverAt.getTime() - 60 * 1000)) throw new AppError("It cannot have been forwarded before it was mailed to the IO.", "VALIDATION", { forwardedAt: "Enter a time after it was mailed to the IO." });
    const note = input.note?.trim().slice(0, 200) || null;
    await tx.submission.create({ data: { attemptedAt: now(), requestId, versionNo: req.currentVersionNo, adapter: `Forwarded by ${actor.displayName} from their own mailbox to ${req.recipient.address}`, outcome: "SUCCEEDED", externalReference: note, recipientAddress: req.recipient.address, actorId: actor.id, idempotencyKey: `forward:${requestId}:${req.currentVersionNo}` } });
    await markSubmittedTx(tx, req, actor, at, note);
    await recordAudit(tx, { caseId: req.caseId, actorId: actor.id, action: "request.forwarded_recorded", objectType: "Request", objectId: requestId, summary: `${req.reference} recorded as forwarded to ${req.recipient.organisation} (${req.recipient.address}) by ${actor.displayName}${note ? `: ${note}` : ""}` });
    return getRequestState(tx, requestId);
  });
}

/** Portal work: the officer submits on the provider's portal and records the reference here. */
export function recordPortalSubmission(db: Db, actor: SessionUser, requestId: string, input: { expectedVersion: number; confirmed: boolean; portalReference: string }) {
  return db.$transaction(async (tx) => {
    const req = await loadRequestForUser(tx, actor, requestId);
    assertVersion(req.version, input.expectedVersion);
    if (req.channel !== "PORTAL") throw new AppError("This request is not routed through a provider portal.", "PRECONDITION");
    const ref = input.portalReference.trim();
    if (ref.length < 3) throw new AppError("Enter the reference shown by the portal.", "VALIDATION", { portalReference: "Enter the portal reference." });
    const ready = await readiness(tx, req, input.confirmed);
    if (!ready.ok) throw new AppError(ready.reasons.join(" "), "PRECONDITION");
    const at = now();
    await tx.submission.create({
      data: {
        attemptedAt: now(),
        requestId,
        versionNo: req.currentVersionNo,
        adapter: "Officer-recorded portal submission",
        outcome: "SUCCEEDED",
        externalReference: ref,
        recipientAddress: req.recipient.address,
        actorId: actor.id,
        idempotencyKey: `portal:${requestId}:${req.currentVersionNo}`,
      },
    });
    await markSubmittedTx(tx, req, actor, at, ref);
    await recordAudit(tx, { caseId: req.caseId, actorId: actor.id, action: "request.portal_submission_recorded", objectType: "Request", objectId: requestId, summary: `${req.reference} recorded as submitted on the provider portal (reference ${ref})` });
    return getRequestState(tx, requestId);
  });
}

/** Source facts changed: flag unsent drafts that concern the affected entities. */
export async function flagDraftsForReviewTx(tx: Tx, caseId: string, entityIds: string[], reason: string) {
  if (entityIds.length === 0) return 0;
  const drafts = await tx.request.findMany({
    // A draft with no addressee yet is rewritten from the case when it is addressed, so it is not flagged.
    where: { caseId, status: { in: ["DRAFT", "AWAITING_APPROVAL", "APPROVED", "SUBMISSION_FAILED"] }, subjects: { some: { entityId: { in: entityIds } } }, recipient: { organisationType: { not: "UNADDRESSED" } } },
    select: { id: true, reference: true, needsReview: true, needsReviewReason: true },
  });
  for (const d of drafts) {
    // Already flagged for the same reason: nothing new to record.
    if (d.needsReview && d.needsReviewReason === reason) continue;
    await tx.request.update({ where: { id: d.id }, data: { needsReview: true, needsReviewReason: reason, version: { increment: 1 } } });
    await recordAudit(tx, { caseId, actorId: null, action: "request.flagged_for_review", objectType: "Request", objectId: d.id, summary: `${d.reference} flagged for renewed review: ${reason}` });
  }
  return drafts.length;
}

export function flagDraftsForReview(db: Db, caseId: string, entityIds: string[], reason: string) {
  return db.$transaction((tx) => flagDraftsForReviewTx(tx, caseId, entityIds, reason));
}

export function markDraftReviewed(db: Db, actor: SessionUser, requestId: string, expectedVersion: number, note: string) {
  return db.$transaction(async (tx) => {
    const req = await loadRequestForUser(tx, actor, requestId);
    assertVersion(req.version, expectedVersion);
    if (!req.needsReview) return getRequestState(tx, requestId);
    if (!isEditableStatus(req.status)) throw new AppError("Only unsent requests can be marked as reviewed.", "PRECONDITION");
    await tx.request.update({ where: { id: requestId }, data: { needsReview: false, needsReviewReason: null, version: { increment: 1 } } });
    await recordAudit(tx, { caseId: req.caseId, actorId: actor.id, action: "request.review_confirmed", objectType: "Request", objectId: requestId, summary: `${req.reference} reviewed after source changes: ${note || "no note"}`, detail: { previousReason: req.needsReviewReason } });
    return getRequestState(tx, requestId);
  });
}

export function addRequestNote(db: Db, actor: SessionUser, requestId: string, body: string) {
  return db.$transaction(async (tx) => {
    const req = await loadRequestForUser(tx, actor, requestId);
    const text = body.trim();
    if (text.length < 2) throw new AppError("Write a note before saving.", "VALIDATION", { body: "Write a note." });
    const note = await tx.requestNote.create({ data: { requestId, authorId: actor.id, body: text, createdAt: now() } });
    await recordAudit(tx, { caseId: req.caseId, actorId: actor.id, action: "request.note_added", objectType: "Request", objectId: requestId, summary: `Internal note added to ${req.reference}` });
    return note;
  });
}
