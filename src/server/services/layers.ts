import type { Tx } from "../db";

/**
 * Layers of the money trail: a victim's payment is layer 1; money leaving an account is one layer deeper than the
 * shallowest money that reached it. Stored on each transaction, and recomputed whenever a movement is recorded,
 * because records arrive out of order (a cash withdrawal can be reported before the transfer that funded it).
 */
export async function recomputeLayersTx(tx: Tx, caseId: string) {
  const txns = await tx.transaction.findMany({ where: { caseId }, select: { id: true, fromEntityId: true, toEntityId: true, kind: true, layer: true } });
  const layer = new Map<string, number>();
  for (const t of txns) if (t.kind === "VICTIM_PAYMENT") layer.set(t.id, 1);
  // Shallowest layer of money reaching each account, settled breadth-first.
  for (let pass = 0; pass < txns.length + 1; pass++) {
    let changed = false;
    const reached = new Map<string, number>();
    for (const t of txns) {
      const l = layer.get(t.id);
      if (l !== undefined) reached.set(t.toEntityId, Math.min(reached.get(t.toEntityId) ?? Infinity, l));
    }
    for (const t of txns) {
      if (t.kind === "VICTIM_PAYMENT") continue;
      const into = reached.get(t.fromEntityId);
      if (into === undefined) continue;
      const next = into + 1;
      if (layer.get(t.id) !== next) {
        layer.set(t.id, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
  let updated = 0;
  for (const t of txns) {
    const l = layer.get(t.id);
    if (l !== undefined && l !== t.layer) {
      await tx.transaction.update({ where: { id: t.id }, data: { layer: l } });
      updated++;
    }
  }
  return updated;
}
