import type { Db, Tx } from "../db";
import { deliverySettings } from "../config";
import { readStoredFile } from "../storage";
import { buildMime, type MailAttachment } from "./message";
import { smtpFromEnv, smtpSend } from "./smtp";

/**
 * T-CYBER's outbox. Every mail it sends is recorded here. With the configured transport "simulated" (the default), the
 * mail is kept in the outbox and nothing leaves this server; with "smtp" it is sent through the mail server set in the
 * environment and the outcome (sent or failed, with the reason) is recorded.
 */

export interface OutgoingMail {
  caseId: string | null;
  requestId: string | null;
  actorId: string;
  to: string;
  toName?: string | null;
  from: string;
  fromName?: string | null;
  subject: string;
  text: string;
  /** Evidence items to attach (their stored originals). */
  attachmentIds: string[];
}

export type SendResult = { ok: true; mailId: string; transport: "SIMULATED" | "SMTP"; status: "KEPT" | "SENT" } | { ok: false; mailId: string; transport: "SMTP"; error: string };

/** The stored originals of evidence items, as mail attachments. */
export async function attachmentsFor(tx: Db | Tx, ids: string[]): Promise<MailAttachment[]> {
  if (!ids.length) return [];
  const items = await tx.evidenceItem.findMany({ where: { id: { in: ids } }, select: { fileName: true, mimeType: true, storageKey: true } });
  return items.map((e) => ({ fileName: e.fileName, contentType: e.mimeType, content: readStoredFile(e.storageKey) }));
}

/** Sends (or keeps) one mail. Call it outside a database transaction: a mail server can take a while to answer. */
export async function sendMail(tx: Db | Tx, m: OutgoingMail): Promise<SendResult> {
  const { transport } = deliverySettings();
  const base = { caseId: m.caseId, requestId: m.requestId, toAddress: m.to, fromAddress: m.from, subject: m.subject, bodyText: m.text, attachmentIdsJson: JSON.stringify(m.attachmentIds), actorId: m.actorId };
  if (transport === "simulated") {
    const row = await tx.outboundMail.create({ data: { ...base, transport: "SIMULATED", status: "KEPT" } });
    return { ok: true, mailId: row.id, transport: "SIMULATED", status: "KEPT" };
  }
  const env = smtpFromEnv();
  if (!env.ok) {
    const row = await tx.outboundMail.create({ data: { ...base, transport: "SMTP", status: "FAILED", error: env.error } });
    return { ok: false, mailId: row.id, transport: "SMTP", error: `${env.error} Nothing was sent.` };
  }
  const { mime, messageId } = buildMime({ from: m.from, fromName: m.fromName, to: m.to, toName: m.toName, subject: m.subject, text: m.text, attachments: await attachmentsFor(tx, m.attachmentIds) });
  try {
    await smtpSend(env.settings, { from: m.from, to: [m.to] }, mime);
    const row = await tx.outboundMail.create({ data: { ...base, transport: "SMTP", status: "SENT", messageId } });
    return { ok: true, mailId: row.id, transport: "SMTP", status: "SENT" };
  } catch (err) {
    const error = (err as Error).message || "The mail server could not be used.";
    const row = await tx.outboundMail.create({ data: { ...base, transport: "SMTP", status: "FAILED", error, messageId } });
    return { ok: false, mailId: row.id, transport: "SMTP", error: `${error} Nothing was sent.` };
  }
}
