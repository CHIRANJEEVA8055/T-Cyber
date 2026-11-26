import type { Tx } from "./db";
import { now } from "./clock";

export interface AuditInput {
  caseId: string | null;
  actorId: string | null;
  action: string;
  objectType: string;
  objectId?: string | null;
  summary: string;
  detail?: Record<string, unknown>;
  correctsId?: string | null;
  at?: Date;
}

const replacer = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

/** Append-only: the database rejects updates and deletes of audit events (see migrations). */
export async function recordAudit(tx: Tx, input: AuditInput) {
  return tx.auditEvent.create({
    data: {
      caseId: input.caseId,
      actorId: input.actorId,
      action: input.action,
      objectType: input.objectType,
      objectId: input.objectId ?? null,
      summary: input.summary,
      detailJson: JSON.stringify(input.detail ?? {}, replacer),
      correctsId: input.correctsId ?? null,
      at: input.at ?? now(),
    },
  });
}
