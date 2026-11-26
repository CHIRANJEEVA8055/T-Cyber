import type { Db } from "../db";
import type { SessionUser } from "../auth/session";
import { loadCaseForUser } from "../auth/access";
import { recordAudit } from "../audit";
import { AppError, notFoundError } from "../errors";
import { getAppConfig } from "../config";
import { buildMime } from "../mail/message";
import { attachmentsFor } from "../mail/outbox";
import { fileSafeRef } from "@/domain/request-ref";

const READY = ["APPROVED", "SUBMISSION_FAILED", "SUBMITTED", "ACKNOWLEDGED", "PARTIAL_RESPONSE", "COMPLETE_RESPONSE"];

/**
 * The approved version of a request as an email to the nodal officer, for the IO to send from their own mailbox:
 * To, Subject and body exactly as approved, with its attachments. Only an approved version is offered, so what the
 * IO sends is what was approved. The download is logged.
 */
export async function requestEml(db: Db, user: SessionUser, requestId: string): Promise<{ fileName: string; buffer: Buffer }> {
  const req = await db.request.findUnique({ where: { id: requestId }, include: { recipient: true } });
  if (!req) throw notFoundError("request");
  await loadCaseForUser(db, user, req.caseId, "read");
  if (!READY.includes(req.status) || req.approvedVersionNo !== req.currentVersionNo) throw new AppError("Approve the request first: only an approved version is offered to send.", "PRECONDITION");
  if (req.recipient.organisationType === "UNADDRESSED") throw new AppError("This request has no addressee yet.", "PRECONDITION");
  const v = await db.requestVersion.findUniqueOrThrow({ where: { requestId_versionNo: { requestId, versionNo: req.currentVersionNo } } });
  const { mime } = buildMime({
    from: v.fromAddress ?? getAppConfig().mailbox.fromAddress,
    to: req.recipient.address,
    toName: req.recipient.name,
    subject: v.subject,
    text: v.body,
    attachments: await attachmentsFor(db, JSON.parse(v.attachmentIdsJson) as string[]),
    headers: { "X-Unsent": "1" },
  });
  await db.$transaction((tx) => recordAudit(tx, { caseId: req.caseId, actorId: user.id, action: "request.eml_downloaded", objectType: "Request", objectId: requestId, summary: `${req.reference} downloaded as an email to send to ${req.recipient.organisation} (${req.recipient.address})` }));
  return { fileName: `${fileSafeRef(req.reference)}.eml`, buffer: Buffer.from(mime, "utf8") };
}
