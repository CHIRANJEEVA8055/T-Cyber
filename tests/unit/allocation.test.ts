import { describe, expect, it } from "vitest";
import { firstInFirstOutSplit, proportionalSplit, totalsByClaim, type TrailTxn } from "@/domain/allocation";

const L = (r: number) => BigInt(r) * 100n;
const at = (d: string) => new Date(`${d}+05:30`);
const holds = [
  { holdId: "hB", accountId: "B", heldMinor: L(50000) },
  { holdId: "hC", accountId: "C", heldMinor: L(30000) },
];
const claims = [
  { claimId: "v1", lossMinor: L(60000) },
  { claimId: "v2", lossMinor: L(40000) },
];
// FIR 412: both victims pay Account A; A sends ₹70,000 to B and ₹30,000 to C; ₹20,000 leaves B as cash.
const trail: TrailTxn[] = [
  { id: "p1", fromId: "V1", toId: "A", amountMinor: L(60000), at: at("2026-11-02T10:42"), kind: "VICTIM_PAYMENT", claimId: "v1" },
  { id: "p2", fromId: "V2", toId: "A", amountMinor: L(40000), at: at("2026-11-02T10:55"), kind: "VICTIM_PAYMENT", claimId: "v2" },
  { id: "t1", fromId: "A", toId: "B", amountMinor: L(70000), at: at("2026-11-04T09:10"), kind: "ONWARD_TRANSFER", claimId: null },
  { id: "t2", fromId: "A", toId: "C", amountMinor: L(30000), at: at("2026-11-04T09:12"), kind: "ONWARD_TRANSFER", claimId: null },
  { id: "c1", fromId: "B", toId: "CASH", amountMinor: L(20000), at: at("2026-11-05T21:14"), kind: "CASH_WITHDRAWAL", claimId: null },
];

describe("splitting held money between victims", () => {
  it("splits each hold in proportion to the losses: 60:40 gives ₹48,000 and ₹32,000", () => {
    const s = proportionalSplit(holds, claims);
    expect(totalsByClaim(s, claims)).toEqual([
      { claimId: "v1", amountMinor: L(48000) },
      { claimId: "v2", amountMinor: L(32000) },
    ]);
    expect(s.filter((x) => x.holdId === "hB").map((x) => x.amountMinor)).toEqual([L(30000), L(20000)]);
  });

  it("rounds to whole rupees and gives the remainder to the largest loss, so the parts add up", () => {
    const s = proportionalSplit([{ holdId: "h", accountId: "X", heldMinor: L(1000) }], [
      { claimId: "a", lossMinor: L(1) },
      { claimId: "b", lossMinor: L(1) },
      { claimId: "c", lossMinor: L(1) },
    ]);
    expect(s.reduce((t, x) => t + x.amountMinor, 0n)).toBe(L(1000));
    expect(s.map((x) => x.amountMinor)).toEqual([L(334), L(333), L(333)]);
  });

  it("follows the trail first in, first out: the cash took Victim 1's oldest money, so each victim has ₹40,000 held", () => {
    const { shares, untraced } = firstInFirstOutSplit(holds, trail);
    expect(untraced).toEqual([]);
    expect(totalsByClaim(shares, claims)).toEqual([
      { claimId: "v1", amountMinor: L(40000) },
      { claimId: "v2", amountMinor: L(40000) },
    ]);
    expect(shares.filter((x) => x.holdId === "hC")).toEqual([{ holdId: "hC", claimId: "v2", amountMinor: L(30000) }]);
  });

  it("never guesses: held money the trail cannot account for is reported as untraced", () => {
    const { untraced } = firstInFirstOutSplit([{ holdId: "hB", accountId: "B", heldMinor: L(60000) }], trail);
    expect(untraced).toEqual([{ holdId: "hB", amountMinor: L(10000) }]);
  });
});
