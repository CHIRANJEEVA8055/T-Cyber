import { describe, expect, it } from "vitest";
import { computeLedger, type LedgerInput } from "@/domain/ledger";

const L = (rupees: number) => BigInt(rupees) * 100n; // test helper: whole rupees → paise

/** FIR 1/2026 as seeded: Bank A response accepted, Bank B response not yet reviewed. */
function fir1Seed(): LedgerInput {
  return {
    claims: [{ id: "c1", lossMinor: L(2000000), status: "ACTIVE" }],
    holds: [
      { id: "hA", status: "CONFIRMED_HELD", confirmedMinor: L(200000) },
      { id: "hB", status: "REQUESTED", confirmedMinor: null },
    ],
    allocations: [{ id: "a1", holdId: "hA", claimId: "c1", amountMinor: L(200000), status: "CONFIRMED" }],
    refunds: [],
    transactions: [
      { id: "t1", layer: 1, amountMinor: L(1000000), claimId: "c1", kind: "VICTIM_PAYMENT" },
      { id: "t2", layer: 1, amountMinor: L(600000), claimId: "c1", kind: "VICTIM_PAYMENT" },
      { id: "t3", layer: 1, amountMinor: L(400000), claimId: "c1", kind: "VICTIM_PAYMENT" },
      { id: "t4", layer: 2, amountMinor: L(800000), claimId: null, kind: "ONWARD_TRANSFER" },
    ],
  };
}

describe("computeLedger — FIR 1/2026 seed", () => {
  it("reports ₹20,00,000 outstanding and ₹18,00,000 neither returned nor secured", () => {
    const ledger = computeLedger(fir1Seed());
    expect(ledger.totalLossMinor).toBe(L(2000000));
    expect(ledger.confirmedRefundsMinor).toBe(0n);
    expect(ledger.outstandingLossMinor).toBe(L(2000000));
    expect(ledger.confirmedHeldMinor).toBe(L(200000));
    expect(ledger.allocatedConfirmedMinor).toBe(L(200000));
    expect(ledger.neitherReturnedNorSecuredMinor).toBe(L(1800000));
    expect(ledger.reconciliation.status).toBe("CONSISTENT");
  });

  it("does not add onward transfers to the loss (no double counting across layers)", () => {
    const input = fir1Seed();
    input.transactions.push({ id: "t5", layer: 2, amountMinor: L(400000), claimId: null, kind: "ONWARD_TRANSFER" });
    const ledger = computeLedger(input);
    expect(ledger.totalLossMinor).toBe(L(2000000));
    expect(ledger.transfersByLayer).toEqual([
      { layer: 1, totalMinor: L(2000000), count: 3 },
      { layer: 2, totalMinor: L(1200000), count: 2 },
    ]);
    expect(ledger.neitherReturnedNorSecuredMinor).toBe(L(1800000));
  });

  it("treats a hold with no confirmed amount as unknown, not zero", () => {
    const ledger = computeLedger(fir1Seed());
    const holdB = ledger.perHold.find((h) => h.holdId === "hB");
    expect(holdB?.confirmedMinor).toBeNull();
    expect(ledger.unknownHoldCount).toBe(1);
    expect(ledger.notes.map((n) => n.code)).toContain("UNKNOWN_HOLD_AMOUNT");
  });
});

/** Two victims, money mixed in one account, a ₹20,000 refund already credited from N. */
function multiVictim(): LedgerInput {
  return {
    claims: [
      { id: "v1", lossMinor: L(60000), status: "ACTIVE" },
      { id: "v2", lossMinor: L(40000), status: "ACTIVE" },
    ],
    holds: [
      { id: "hN", status: "CONFIRMED_HELD", confirmedMinor: L(30000) },
      { id: "hP", status: "CONFIRMED_HELD", confirmedMinor: L(30000) },
    ],
    allocations: [
      { id: "a1", holdId: "hN", claimId: "v1", amountMinor: L(20000), status: "CONFIRMED" },
      { id: "a2", holdId: "hN", claimId: "v2", amountMinor: L(10000), status: "CONFIRMED" },
      { id: "a3", holdId: "hP", claimId: "v1", amountMinor: L(20000), status: "PROPOSED" },
      { id: "a4", holdId: "hP", claimId: "v2", amountMinor: L(30000), status: "PROPOSED" },
    ],
    refunds: [
      { id: "r1", claimId: "v1", amountMinor: L(20000), status: "CREDIT_CONFIRMED" },
      { id: "r2", claimId: "v2", amountMinor: L(5000), status: "AUTHORISED" },
    ],
    transactions: [
      { id: "t1", layer: 1, amountMinor: L(60000), claimId: "v1", kind: "VICTIM_PAYMENT" },
      { id: "t2", layer: 1, amountMinor: L(40000), claimId: "v2", kind: "VICTIM_PAYMENT" },
    ],
  };
}

describe("computeLedger — multiple victims", () => {
  it("counts only credit-confirmed refunds as returned", () => {
    const ledger = computeLedger(multiVictim());
    expect(ledger.confirmedRefundsMinor).toBe(L(20000));
    expect(ledger.refundPipeline.authorisedMinor).toBe(L(5000));
    expect(ledger.outstandingLossMinor).toBe(L(80000));
  });

  it("counts only confirmed allocations as secured and leaves competing proposals unresolved", () => {
    const ledger = computeLedger(multiVictim());
    expect(ledger.allocatedConfirmedMinor).toBe(L(30000));
    expect(ledger.unallocatedHeldMinor).toBe(L(30000));
    expect(ledger.neitherReturnedNorSecuredMinor).toBe(L(50000));
    const holdP = ledger.perHold.find((h) => h.holdId === "hP");
    expect(holdP?.competingProposals).toBe(true);
    expect(ledger.notes.map((n) => n.code)).toContain("COMPETING_PROPOSALS");
    expect(ledger.reconciliation.status).toBe("CONSISTENT");
  });

  it("computes per-victim positions", () => {
    const ledger = computeLedger(multiVictim());
    const v1 = ledger.perClaim.find((c) => c.claimId === "v1");
    const v2 = ledger.perClaim.find((c) => c.claimId === "v2");
    expect(v1).toMatchObject({ outstandingMinor: L(40000), allocatedMinor: L(20000), neitherMinor: L(20000) });
    expect(v2).toMatchObject({ outstandingMinor: L(40000), allocatedMinor: L(10000), neitherMinor: L(30000) });
  });
});

describe("computeLedger — needs reconciliation", () => {
  it("flags confirmed allocations that exceed the confirmed held amount", () => {
    const input = multiVictim();
    input.allocations = input.allocations.map((a) => (a.holdId === "hP" ? { ...a, status: "CONFIRMED" } : a));
    const ledger = computeLedger(input);
    expect(ledger.reconciliation.status).toBe("NEEDS_RECONCILIATION");
    expect(ledger.reconciliation.issues.map((i) => i.code)).toContain("HOLD_OVER_ALLOCATED");
    expect(ledger.neitherReturnedNorSecuredMinor).toBeNull();
  });

  it("flags confirmed allocations on a hold whose amount is unknown", () => {
    const input = fir1Seed();
    input.allocations.push({ id: "a2", holdId: "hB", claimId: "c1", amountMinor: L(100000), status: "CONFIRMED" });
    const ledger = computeLedger(input);
    expect(ledger.reconciliation.issues.map((i) => i.code)).toContain("ALLOCATION_ON_UNCONFIRMED_HOLD");
    expect(ledger.neitherReturnedNorSecuredMinor).toBeNull();
  });

  it("flags allocations still recorded against a released hold", () => {
    const input = fir1Seed();
    input.holds[0] = { id: "hA", status: "RELEASED", confirmedMinor: L(200000) };
    const ledger = computeLedger(input);
    expect(ledger.reconciliation.issues.map((i) => i.code)).toContain("ALLOCATION_ON_UNCONFIRMED_HOLD");
  });

  it("flags a claim whose refunds and allocations exceed its loss", () => {
    const input = fir1Seed();
    input.refunds.push({ id: "r1", claimId: "c1", amountMinor: L(1900000), status: "CREDIT_CONFIRMED" });
    const ledger = computeLedger(input);
    expect(ledger.reconciliation.issues.map((i) => i.code)).toContain("CLAIM_OVER_ALLOCATED");
  });

  it("notes when victim payments for a claim do not add up to the recorded loss", () => {
    const input = fir1Seed();
    input.transactions = input.transactions.filter((t) => t.id !== "t3");
    const ledger = computeLedger(input);
    expect(ledger.notes.map((n) => n.code)).toContain("CLAIM_PAYMENTS_MISMATCH");
  });

  it("ignores withdrawn claims and withdrawn allocations", () => {
    const input = multiVictim();
    input.claims[1] = { id: "v2", lossMinor: L(40000), status: "WITHDRAWN" };
    input.allocations = input.allocations.filter((a) => a.claimId === "v1");
    input.refunds = input.refunds.filter((r) => r.claimId === "v1");
    input.transactions = input.transactions.filter((t) => t.claimId === "v1");
    const ledger = computeLedger(input);
    expect(ledger.totalLossMinor).toBe(L(60000));
  });
});
