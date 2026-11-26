import type { Db, Tx } from "./db";

/**
 * The station's assistant identity: a system user (role SYSTEM, never active, no usable password) recorded as
 * the author of drafts the rules prepare. Recording it as the author keeps the approval rule honest: an officer
 * may approve the assistant's wording, but not wording the officer wrote.
 */
export async function assistantAuthorId(db: Db | Tx, stationId: string): Promise<string | null> {
  const u = await db.user.findFirst({ where: { role: "SYSTEM", stationId }, select: { id: true } });
  return u?.id ?? null;
}
