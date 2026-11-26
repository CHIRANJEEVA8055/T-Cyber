import { compareNames } from "@/domain/providers";
import type { Tx } from "../db";
import { recordAudit } from "../audit";
import { parseAttributes } from "./facts";

/**
 * The name the FIR stated for an identifier, against the name a record now gives (a bank's KYC, a CAF, a provider's
 * registration). Said with the finding, and kept on the identifier when the finding is applied.
 */
export function statedNameCheck(subject: { label: string; attributesJson: string }, recordName: string, source: string): { note: string; check: { stated: string; recordName: string; verdict: string; source: string } } | null {
  const stated = parseAttributes(subject.attributesJson).statedName;
  if (typeof stated !== "string" || !stated.trim()) return null;
  const c = compareNames(stated, recordName);
  return { note: ` The FIR stated ${subject.label} to be “${stated}”; ${source} names ${recordName}: ${c.words}.`, check: { stated, recordName, verdict: c.verdict, source } };
}

/** Keeps the comparison on the identifier and in the audit log (applied findings only). */
export async function recordNameCheck(tx: Tx, caseId: string, actorId: string, entityId: string, recordName: string, source: string, at: Date) {
  const e = await tx.entity.findUniqueOrThrow({ where: { id: entityId } });
  const c = statedNameCheck(e, recordName, source);
  if (!c) return;
  const attrs = parseAttributes(e.attributesJson);
  await tx.entity.update({ where: { id: e.id }, data: { attributesJson: JSON.stringify({ ...attrs, statedNameCheck: { ...c.check, at: at.toISOString() } }) } });
  await recordAudit(tx, { caseId, actorId, action: "entity.stated_name_checked", objectType: "Entity", objectId: e.id, summary: c.note.trim(), detail: c.check });
}

