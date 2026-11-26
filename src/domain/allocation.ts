/**
 * Splitting held money between victims whose payments were mixed. The officer chooses the method and records the
 * reason; these functions only do the arithmetic for the two methods that have one. Amounts are minor units.
 */

export interface SplitHold {
  holdId: string;
  accountId: string;
  heldMinor: bigint;
}
export interface SplitClaim {
  claimId: string;
  lossMinor: bigint;
}
export interface TrailTxn {
  id: string;
  fromId: string;
  toId: string;
  amountMinor: bigint;
  at: Date;
  kind: "VICTIM_PAYMENT" | "ONWARD_TRANSFER" | "CASH_WITHDRAWAL" | string;
  claimId: string | null;
}
export interface Share {
  holdId: string;
  claimId: string | null;
  amountMinor: bigint;
}

const RUPEE = 100n;

/**
 * Each hold is split in proportion to the victims' losses, in whole rupees; what rounding leaves over goes to
 * the largest loss (the earliest claim on a tie), so the parts always add up to the held amount.
 */
export function proportionalSplit(holds: SplitHold[], claims: SplitClaim[]): Share[] {
  const total = claims.reduce((s, c) => s + c.lossMinor, 0n);
  if (total <= 0n) return [];
  const largest = [...claims].sort((a, b) => (b.lossMinor > a.lossMinor ? 1 : b.lossMinor < a.lossMinor ? -1 : 0))[0]!;
  const out: Share[] = [];
  for (const h of holds) {
    const parts = claims.map((c) => ({ claimId: c.claimId, amountMinor: ((h.heldMinor * c.lossMinor) / total / RUPEE) * RUPEE }));
    const left = h.heldMinor - parts.reduce((s, p) => s + p.amountMinor, 0n);
    parts.find((p) => p.claimId === largest.claimId)!.amountMinor += left;
    for (const p of parts) if (p.amountMinor > 0n) out.push({ holdId: h.holdId, ...p });
  }
  return out;
}

/**
 * First in, first out: follows the money trail in time order. Each account keeps its incoming money as lots in
 * the order it arrived; anything leaving takes the oldest lots first. What a hold secures is the newest money
 * left in its account. Money the trail cannot account for is returned with claimId null, never guessed.
 */
export function firstInFirstOutSplit(holds: SplitHold[], trail: TrailTxn[]): { shares: Share[]; untraced: { holdId: string; amountMinor: bigint }[] } {
  const lots = new Map<string, { claimId: string | null; amountMinor: bigint }[]>();
  const queue = (id: string) => lots.get(id) ?? (lots.set(id, []), lots.get(id)!);
  const order = (k: string) => (k === "VICTIM_PAYMENT" ? 0 : 1);
  const take = (id: string, amount: bigint) => {
    const q = queue(id);
    const taken: { claimId: string | null; amountMinor: bigint }[] = [];
    let need = amount;
    while (need > 0n && q.length) {
      const lot = q[0]!;
      const part = lot.amountMinor <= need ? lot.amountMinor : need;
      taken.push({ claimId: lot.claimId, amountMinor: part });
      lot.amountMinor -= part;
      need -= part;
      if (lot.amountMinor === 0n) q.shift();
    }
    // Money leaving that the trail never saw arrive.
    if (need > 0n) taken.push({ claimId: null, amountMinor: need });
    return taken;
  };
  for (const t of [...trail].sort((a, b) => a.at.getTime() - b.at.getTime() || order(a.kind) - order(b.kind))) {
    if (t.kind === "VICTIM_PAYMENT") queue(t.toId).push({ claimId: t.claimId, amountMinor: t.amountMinor });
    else if (t.kind === "CASH_WITHDRAWAL") take(t.fromId, t.amountMinor);
    else queue(t.toId).push(...take(t.fromId, t.amountMinor));
  }
  const shares: Share[] = [];
  const untraced: { holdId: string; amountMinor: bigint }[] = [];
  for (const h of holds) {
    // The newest lots are what is still in the account.
    const q = [...queue(h.accountId)].reverse();
    let need = h.heldMinor;
    const byClaim = new Map<string | null, bigint>();
    for (const lot of q) {
      if (need <= 0n) break;
      const part = lot.amountMinor <= need ? lot.amountMinor : need;
      byClaim.set(lot.claimId, (byClaim.get(lot.claimId) ?? 0n) + part);
      need -= part;
    }
    for (const [claimId, amountMinor] of byClaim) {
      if (claimId === null) untraced.push({ holdId: h.holdId, amountMinor });
      else shares.push({ holdId: h.holdId, claimId, amountMinor });
    }
    if (need > 0n) untraced.push({ holdId: h.holdId, amountMinor: need });
  }
  return { shares, untraced };
}

/** Per-claim totals of a split, in claim order. */
export function totalsByClaim(shares: Share[], claims: SplitClaim[]): { claimId: string; amountMinor: bigint }[] {
  return claims.map((c) => ({ claimId: c.claimId, amountMinor: shares.filter((s) => s.claimId === c.claimId).reduce((s, x) => s + x.amountMinor, 0n) }));
}
