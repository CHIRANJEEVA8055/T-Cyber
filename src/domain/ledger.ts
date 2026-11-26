/**
 * Recovery ledger: deterministic bigint arithmetic over confirmed financial records.
 *
 * Rules (from the product brief):
 * - Outstanding victim loss = loss − credit-confirmed refunds.
 * - Neither returned nor secured = loss − credit-confirmed refunds − confirmed allocations
 *   of currently confirmed holds — only when allocations are consistent; otherwise null
 *   and the case shows "Needs reconciliation".
 * - Onward transfers are observations per layer and are never added to the loss.
 * - Unknown hold amounts stay unknown (null); they are never treated as zero.
 * - Proposed allocations (competing claims, mixed funds) are not counted as secured.
 */

export type ClaimStatus = "ACTIVE" | "WITHDRAWN";
export type HoldStatus = "REQUESTED" | "RESTRICTION_CONFIRMED" | "CONFIRMED_HELD" | "RELEASED";
export type AllocationStatus = "PROPOSED" | "CONFIRMED" | "WITHDRAWN";
export type RefundStatus = "AUTHORISED" | "INITIATED" | "CREDIT_CONFIRMED" | "FAILED" | "CANCELLED";
export type TransactionKind = "VICTIM_PAYMENT" | "ONWARD_TRANSFER" | "CASH_WITHDRAWAL";

export interface LedgerInput {
  claims: { id: string; lossMinor: bigint; status: ClaimStatus | string }[];
  holds: { id: string; status: HoldStatus | string; confirmedMinor: bigint | null }[];
  allocations: { id: string; holdId: string; claimId: string; amountMinor: bigint; status: AllocationStatus | string }[];
  refunds: { id: string; claimId: string; amountMinor: bigint; status: RefundStatus | string }[];
  transactions: { id: string; layer: number; amountMinor: bigint; claimId: string | null; kind: TransactionKind | string }[];
}

export type LedgerIssueCode = "HOLD_OVER_ALLOCATED" | "ALLOCATION_ON_UNCONFIRMED_HOLD" | "CLAIM_OVER_ALLOCATED";
export type LedgerNoteCode =
  | "UNKNOWN_HOLD_AMOUNT"
  | "UNALLOCATED_HELD"
  | "COMPETING_PROPOSALS"
  | "CLAIM_PAYMENTS_MISMATCH";

export interface LedgerIssue {
  code: LedgerIssueCode;
  holdId?: string;
  claimId?: string;
  message: string;
}

export interface LedgerNote {
  code: LedgerNoteCode;
  holdId?: string;
  claimId?: string;
  message: string;
}

export interface HoldPosition {
  holdId: string;
  status: string;
  confirmedMinor: bigint | null;
  isSecuring: boolean;
  allocatedConfirmedMinor: bigint;
  proposedMinor: bigint;
  unallocatedMinor: bigint | null;
  competingProposals: boolean;
}

export interface ClaimPosition {
  claimId: string;
  lossMinor: bigint;
  confirmedRefundsMinor: bigint;
  outstandingMinor: bigint;
  allocatedMinor: bigint;
  proposedMinor: bigint;
  neitherMinor: bigint | null;
  victimPaymentsMinor: bigint;
}

export interface LedgerPosition {
  totalLossMinor: bigint;
  confirmedRefundsMinor: bigint;
  outstandingLossMinor: bigint;
  refundPipeline: { authorisedMinor: bigint; initiatedMinor: bigint; failedMinor: bigint };
  confirmedHeldMinor: bigint;
  unknownHoldCount: number;
  allocatedConfirmedMinor: bigint;
  unallocatedHeldMinor: bigint | null;
  neitherReturnedNorSecuredMinor: bigint | null;
  reconciliation: { status: "CONSISTENT" | "NEEDS_RECONCILIATION"; issues: LedgerIssue[] };
  notes: LedgerNote[];
  perHold: HoldPosition[];
  perClaim: ClaimPosition[];
  transfersByLayer: { layer: number; totalMinor: bigint; count: number }[];
}

function isSecuringHold(h: { status: string; confirmedMinor: bigint | null }): boolean {
  return h.status === "CONFIRMED_HELD" && h.confirmedMinor !== null;
}

export function computeLedger(input: LedgerInput): LedgerPosition {
  const activeClaims = input.claims.filter((c) => c.status === "ACTIVE");
  const activeClaimIds = new Set(activeClaims.map((c) => c.id));
  const allocations = input.allocations.filter((a) => a.status !== "WITHDRAWN" && activeClaimIds.has(a.claimId));
  const refunds = input.refunds.filter((r) => activeClaimIds.has(r.claimId));

  const issues: LedgerIssue[] = [];
  const notes: LedgerNote[] = [];

  // Refunds: only a confirmed credit to the victim counts as money returned.
  let confirmedRefundsMinor = 0n;
  const pipeline = { authorisedMinor: 0n, initiatedMinor: 0n, failedMinor: 0n };
  for (const r of refunds) {
    if (r.status === "CREDIT_CONFIRMED") confirmedRefundsMinor += r.amountMinor;
    else if (r.status === "AUTHORISED") pipeline.authorisedMinor += r.amountMinor;
    else if (r.status === "INITIATED") pipeline.initiatedMinor += r.amountMinor;
    else if (r.status === "FAILED") pipeline.failedMinor += r.amountMinor;
  }

  const totalLossMinor = activeClaims.reduce((sum, c) => sum + c.lossMinor, 0n);

  // Holds and their allocations.
  let confirmedHeldMinor = 0n;
  let unknownHoldCount = 0;
  let allocatedConfirmedMinor = 0n;
  const perHold: HoldPosition[] = [];
  for (const h of input.holds) {
    const securing = isSecuringHold(h);
    if (securing) confirmedHeldMinor += h.confirmedMinor as bigint;
    if (h.status !== "RELEASED" && h.confirmedMinor === null) {
      unknownHoldCount += 1;
      notes.push({
        code: "UNKNOWN_HOLD_AMOUNT",
        holdId: h.id,
        message: "The bank has not confirmed an amount for this hold. It is shown as unknown, not ₹0.",
      });
    }
    const forHold = allocations.filter((a) => a.holdId === h.id);
    const confirmedAlloc = forHold.filter((a) => a.status === "CONFIRMED").reduce((s, a) => s + a.amountMinor, 0n);
    const proposed = forHold.filter((a) => a.status === "PROPOSED").reduce((s, a) => s + a.amountMinor, 0n);

    let unallocated: bigint | null = null;
    if (securing) {
      const held = h.confirmedMinor as bigint;
      if (confirmedAlloc > held) {
        issues.push({
          code: "HOLD_OVER_ALLOCATED",
          holdId: h.id,
          message: "Confirmed allocations exceed the amount the bank has confirmed as held.",
        });
      } else {
        unallocated = held - confirmedAlloc;
        allocatedConfirmedMinor += confirmedAlloc;
      }
    } else if (confirmedAlloc > 0n) {
      issues.push({
        code: "ALLOCATION_ON_UNCONFIRMED_HOLD",
        holdId: h.id,
        message: "Funds are allocated against a hold that is not currently confirmed with a known amount.",
      });
    }

    const competing = proposed > 0n && proposed > (unallocated ?? 0n);
    if (competing) {
      notes.push({
        code: "COMPETING_PROPOSALS",
        holdId: h.id,
        message: "Proposed allocations exceed the unallocated held amount. Competing claims remain unresolved until reviewed.",
      });
    }
    if (unallocated !== null && unallocated > 0n) {
      notes.push({
        code: "UNALLOCATED_HELD",
        holdId: h.id,
        message: "Part of the held amount is not yet allocated to any victim claim.",
      });
    }

    perHold.push({
      holdId: h.id,
      status: h.status,
      confirmedMinor: h.confirmedMinor,
      isSecuring: securing,
      allocatedConfirmedMinor: confirmedAlloc,
      proposedMinor: proposed,
      unallocatedMinor: unallocated,
      competingProposals: competing,
    });
  }

  // Claims.
  const securingHoldIds = new Set(input.holds.filter(isSecuringHold).map((h) => h.id));
  const perClaim: ClaimPosition[] = activeClaims.map((c) => {
    const claimRefunds = refunds
      .filter((r) => r.claimId === c.id && r.status === "CREDIT_CONFIRMED")
      .reduce((s, r) => s + r.amountMinor, 0n);
    const claimAllocs = allocations.filter((a) => a.claimId === c.id);
    const allocated = claimAllocs
      .filter((a) => a.status === "CONFIRMED" && securingHoldIds.has(a.holdId))
      .reduce((s, a) => s + a.amountMinor, 0n);
    const proposed = claimAllocs.filter((a) => a.status === "PROPOSED").reduce((s, a) => s + a.amountMinor, 0n);
    const victimPayments = input.transactions
      .filter((t) => t.claimId === c.id && t.kind === "VICTIM_PAYMENT")
      .reduce((s, t) => s + t.amountMinor, 0n);

    if (claimRefunds + allocated > c.lossMinor) {
      issues.push({
        code: "CLAIM_OVER_ALLOCATED",
        claimId: c.id,
        message: "Confirmed refunds plus confirmed allocations exceed this victim's recorded loss.",
      });
    }
    if (victimPayments !== c.lossMinor) {
      notes.push({
        code: "CLAIM_PAYMENTS_MISMATCH",
        claimId: c.id,
        message: "Recorded victim payments do not add up to the claimed loss. Check the claim amount and transactions.",
      });
    }

    return {
      claimId: c.id,
      lossMinor: c.lossMinor,
      confirmedRefundsMinor: claimRefunds,
      outstandingMinor: c.lossMinor - claimRefunds,
      allocatedMinor: allocated,
      proposedMinor: proposed,
      neitherMinor: null,
      victimPaymentsMinor: victimPayments,
    };
  });

  const consistent = issues.length === 0;
  if (consistent) {
    for (const p of perClaim) p.neitherMinor = p.outstandingMinor - p.allocatedMinor;
  }

  // Observed transfers, grouped by depth. Reported for tracing only — never summed into loss.
  const byLayer = new Map<number, { totalMinor: bigint; count: number }>();
  for (const t of input.transactions) {
    const entry = byLayer.get(t.layer) ?? { totalMinor: 0n, count: 0 };
    entry.totalMinor += t.amountMinor;
    entry.count += 1;
    byLayer.set(t.layer, entry);
  }
  const transfersByLayer = [...byLayer.entries()]
    .sort(([a], [b]) => a - b)
    .map(([layer, v]) => ({ layer, totalMinor: v.totalMinor, count: v.count }));

  return {
    totalLossMinor,
    confirmedRefundsMinor,
    outstandingLossMinor: totalLossMinor - confirmedRefundsMinor,
    refundPipeline: pipeline,
    confirmedHeldMinor,
    unknownHoldCount,
    allocatedConfirmedMinor,
    unallocatedHeldMinor: consistent ? confirmedHeldMinor - allocatedConfirmedMinor : null,
    neitherReturnedNorSecuredMinor: consistent ? totalLossMinor - confirmedRefundsMinor - allocatedConfirmedMinor : null,
    reconciliation: { status: consistent ? "CONSISTENT" : "NEEDS_RECONCILIATION", issues },
    notes,
    perHold,
    perClaim,
    transfersByLayer,
  };
}
