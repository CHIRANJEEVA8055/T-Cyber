import { AUTO_MATCH_SCORE, scoreReply, type RequestForMatch } from "@/domain/reply-match";
import type { Db, Tx } from "../db";
import type { SessionUser } from "../auth/session";
import { loadCaseForUser } from "../auth/access";
import { AppError, notFoundError } from "../errors";
import { readStoredFile, storeFile, validateUpload } from "../storage";
import { importResponse, type IncomingMessage } from "./responses";
import { getAppConfig } from "../config";
import { now as clockNow } from "../clock";

/**
 * The station mailbox (SIMULATED). Messages land here and wait, unread, until an officer reads one into a
 * case. Nothing here sends mail; the demo's messages are synthetic and delivered by the seed or by an officer.
 */
export interface InboxAttachment {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  storageKey: string;
  sha256: string;
}

export async function deliverToInbox(db: Db, msg: IncomingMessage & { isSynthetic?: boolean }) {
  const attachments: InboxAttachment[] = msg.attachments.map((a) => {
    const { mimeType } = validateUpload(a.fileName, a.buffer);
    const stored = storeFile(a.buffer, a.fileName);
    return { fileName: a.fileName, mimeType, sizeBytes: stored.sizeBytes, storageKey: stored.storageKey, sha256: stored.sha256 };
  });
  return db.inboxMessage.create({
    data: {
      fromAddress: msg.fromAddress,
      toAddress: msg.toAddress,
      subject: msg.subject,
      receivedAt: msg.receivedAt,
      bodyText: msg.bodyText,
      channel: msg.channel,
      attachmentsJson: JSON.stringify(attachments),
      isSynthetic: msg.isSynthetic ?? false,
    },
  });
}

const AWAITING = ["SUBMITTED", "ACKNOWLEDGED", "PARTIAL_RESPONSE"];

/** The case's requests that may still get a reply, in the shape the matcher needs. */
export async function requestsForMatching(db: Db | Tx, caseId: string) {
  const kase = await db.case.findUniqueOrThrow({ where: { id: caseId } });
  const requests = await db.request.findMany({
    where: { caseId, status: { in: [...AWAITING, "COMPLETE_RESPONSE"] } },
    include: { recipient: true, subjects: { include: { entity: true } } },
    orderBy: { caseSeq: "asc" },
  });
  const firReference = kase.firNumber ? `${kase.firNumber}/${kase.firYear}` : null;
  const replyDomains = (configKey: string | null) => getAppConfig().directory.find((d) => d.key === configKey)?.replyDomains ?? [];
  return requests.map((r) => ({
    request: r,
    match: { reference: r.reference, legacyReference: r.legacyReference, recipientAddress: r.recipient.address, firReference, identifiers: r.subjects.map((s) => s.entity.value), replyDomains: replyDomains(r.recipient.configKey) } satisfies RequestForMatch,
  }));
}

/** Scores a message against each of the case's requests, best first. */
export async function rankRequestsFor(db: Db | Tx, caseId: string, msg: { fromAddress: string; subject: string; bodyText: string }) {
  const reqs = await requestsForMatching(db, caseId);
  return reqs
    .map(({ request, match }) => ({ request, ...scoreReply(msg, match) }))
    .sort((a, b) => b.score - a.score || (a.request.caseSeq ?? 0) - (b.request.caseSeq ?? 0));
}

/** Unread mailbox messages that look like replies to this case (any of its requests scores 30 or more). */
export async function listInboxForCase(db: Db, user: SessionUser, caseId: string) {
  await loadCaseForUser(db, user, caseId, "write");
  const unread = await db.inboxMessage.findMany({ where: { status: "UNREAD" }, orderBy: { receivedAt: "desc" } });
  const out = [];
  for (const m of unread) {
    const ranked = await rankRequestsFor(db, caseId, m);
    // A reply read from Gmail that the local model or the rules suggested for one of this case's requests is shown
    // here with that suggestion, even when the rules alone would not have scored it.
    const suggested = m.suggestedRequestId ? ranked.find((r) => r.request.id === m.suggestedRequestId) : undefined;
    const best = suggested ?? ranked[0];
    if (!best || (best.score < 30 && !suggested)) continue;
    out.push({
      id: m.id,
      fromAddress: m.fromAddress,
      fromLabel: best.score >= AUTO_MATCH_SCORE ? best.request.recipient.organisation : m.fromAddress,
      subject: m.subject,
      receivedAt: m.receivedAt,
      attachments: (JSON.parse(m.attachmentsJson) as InboxAttachment[]).length,
      score: best.score,
      reasons: best.reasons,
      requestId: best.request.id,
      requestReference: best.request.reference,
      requestSeq: best.request.caseSeq,
      looksLike: /acknowledg|received your|under process/i.test(`${m.subject} ${m.bodyText}`) ? "ACKNOWLEDGEMENT" : "REPLY",
      source: m.source === "GMAIL" ? ("GMAIL" as const) : ("STATION" as const),
      suggestion: suggested ? m.suggestionNote : null,
    });
  }
  return out.sort((a, b) => b.score - a.score || b.receivedAt.getTime() - a.receivedAt.getTime());
}

export type InboxCandidate = Awaited<ReturnType<typeof listInboxForCase>>[number];

/** Reads an unread mailbox message into the case as a reply. Matching follows the usual rules; nothing is applied. */
export async function importInboxMessage(db: Db, user: SessionUser, caseId: string, messageId: string, opts: { requestId?: string | null } = {}) {
  await loadCaseForUser(db, user, caseId, "write");
  const m = await db.inboxMessage.findUnique({ where: { id: messageId } });
  if (!m) throw notFoundError("message");
  if (m.status !== "UNREAD") throw new AppError("This message has already been read in.", "PRECONDITION");
  const attachments = (JSON.parse(m.attachmentsJson) as InboxAttachment[]).map((a) => ({ fileName: a.fileName, buffer: readStoredFile(a.storageKey) }));
  const res = await importResponse(
    db,
    { fromAddress: m.fromAddress, toAddress: m.toAddress, subject: m.subject, receivedAt: m.receivedAt, bodyText: m.bodyText, channel: m.channel as IncomingMessage["channel"], attachments },
    { actorId: user.id, actor: user, caseId, requestIdHint: opts.requestId ?? null, isSynthetic: m.isSynthetic },
  );
  const marked = await db.inboxMessage.updateMany({ where: { id: m.id, status: "UNREAD" }, data: { status: "IMPORTED", caseId, responseId: res.responseId, importedById: user.id, importedAt: clockNow() } });
  if (marked.count === 0) throw new AppError("This message has already been read in.", "PRECONDITION");
  return res;
}
