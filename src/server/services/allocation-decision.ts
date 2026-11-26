import { firstInFirstOutSplit, proportionalSplit, totalsByClaim, type Share } from "@/domain/allocation";
import { formatInr } from "@/domain/money";
import { formatDayMonthIST } from "@/domain/time";
import type { Db, Tx } from "../db";
import type { SessionUser } from "../auth/session";
import { loadCaseForUser } from "../auth/access";
import { recordAudit } from "../audit";
import { now } from "../clock";
import { AppError } from "../errors";
import { refreshRecommendationsTx } from "./tasks";

/**
 * The officer's decision on how held money is split between victims whose payments were mixed (SOP 2026, §7.3).
 * The assistant never chooses: it shows what each route gives. Recording a split proposes the allocations, which
 * a supervisor confirms in the ledger before any restoration is filed. Decisions are append-only.
 */

export type SplitMethod = "PROPORTIONAL" | "FIRST_IN_FIRST_OUT" | "COURT";

async function load(tx: Tx | Db, caseId: string) {
  const [claims, holds, trail, contradicted] = await Promise.all([
    tx.victimClaim.findMany({ where: { caseId, status: "ACTIVE" }, include: { victim: true }, orderBy: { createdAt: "asc" } }),
    tx.hold.findMany({ where: { caseId, status: "CONFIRMED_HELD", confirmedAmountMinor: { gt: 0n } }, include: { account: true }, orderBy: { createdAt: "asc" } }),
    tx.transaction.findMany({ where: { caseId }, orderBy: { occurredAt: "asc" } }),
    tx.sourceAssertion.findMany({ where: { caseId, stance: "CONTRADICTS", subjectType: "TRANSACTION" }, select: { subjectId: true } }),
  ]);
  return { claims, holds, trail, contradicted: new Set(contradicted.map((c) => c.subjectId)) };
}

function compute(d: Awaited<ReturnType<typeof load>>) {
  const holds = d.holds.map((h) => ({ holdId: h.id, accountId: h.accountEntityId, heldMinor: h.confirmedAmountMinor! }));
  const claims = d.claims.map((c) => ({ claimId: c.id, lossMinor: c.lossAmountMinor }));
  const prop = proportionalSplit(holds, claims);
  const fifo = firstInFirstOutSplit(
    holds,
    d.trail.map((t) => ({ id: t.id, fromId: t.fromEntityId, toId: t.toEntityId, amountMinor: t.amountMinor, at: t.occurredAt, kind: t.kind, claimId: t.claimId })),
  );
  return { holds, claims, prop, fifo };
}

const name = (label: string) => label.replace(/\s*\(synthetic\)$/, "");

/** What each route would give, for the officer to compare. */
export async function previewSplit(db: Db, user: SessionUser, caseId: string) {
  await loadCaseForUser(db, user, caseId, "read");
  const d = await load(db, caseId);
  const heldMinor = d.holds.reduce((s, h) => s + (h.confirmedAmountMinor ?? 0n), 0n);
  const decisions = await db.allocationDecision.findMany({ where: { caseId }, orderBy: { decidedAt: "desc" }, take: 1 });
  if (d.claims.length < 2 || heldMinor === 0n) return { needed: false as const, held: formatInr(heldMinor), decided: decisions[0] ? describeDecision(decisions[0], d) : null };
  const { claims, prop, fifo } = compute(d);
  const victim = (id: string) => name(d.claims.find((c) => c.id === id)?.victim.label ?? "A victim");
  const line = (shares: Share[]) => totalsByClaim(shares, claims).map((t) => `${victim(t.claimId)} ${formatInr(t.amountMinor)}`).join(" · ");
  const totalLoss = d.claims.reduce((s, c) => s + c.lossAmountMinor, 0n);
  const ratio = d.claims.map((c) => Math.round(Number((c.lossAmountMinor * 1000n) / totalLoss) / 10)).join(":");
  const disputed = d.trail.filter((t) => d.contradicted.has(t.id) && t.kind === "VICTIM_PAYMENT");
  const untraced = fifo.untraced.reduce((s, u) => s + u.amountMinor, 0n);
  const blocking = await db.request.count({ where: { caseId, status: { in: ["SUBMITTED", "ACKNOWLEDGED", "PARTIAL_RESPONSE"] }, items: { some: { itemType: "KYC", status: { in: ["PENDING", "NOT_PROVIDED"] } } } } });
  return {
    needed: true as const,
    held: formatInr(heldMinor),
    decided: decisions[0] ? describeDecision(decisions[0], d) : null,
    options: [
      { method: "PROPORTIONAL" as const, title: `Split ${ratio}, as the victims paid in`, detail: `${line(prop)}. You record the reason; the SOP gives no formula.` },
      {
        method: "FIRST_IN_FIRST_OUT" as const,
        title: "First in, first out",
        detail: `Follows each transfer back to the earliest payment in: ${line(fifo.shares)}.${untraced > 0n ? ` ${formatInr(untraced)} of the held money cannot be traced to a victim and is left unallocated.` : ""}${disputed.length ? ` ${disputed.map((t) => `${victim(t.claimId ?? "")}’s payment time`).join(" and ")} is disputed; this uses the time as recorded.` : " The recorded timestamps are precise enough."}`,
      },
      { method: "COURT" as const, title: "Let the court decide", detail: "Interim custody application under the multiple-victim route. Slowest, but nothing to defend later. No split is proposed." },
    ],
    note: `Holds are confirmed and ${d.claims.length === 2 ? "both" : `all ${d.claims.length}`} claims are recorded.${blocking ? " A KYC asked for is still missing; it does not block this decision." : ""}`,
  };
}

function describeDecision(dec: { method: string; note: string; decidedAt: Date; sharesJson: string }, d: Awaited<ReturnType<typeof load>>) {
  const shares = JSON.parse(dec.sharesJson) as { claimId: string; amountMinor: string }[];
  const victim = (id: string) => name(d.claims.find((c) => c.id === id)?.victim.label ?? "A victim");
  return {
    method: dec.method as SplitMethod,
    on: formatDayMonthIST(dec.decidedAt),
    note: dec.note,
    split: shares.length ? shares.map((s) => `${victim(s.claimId)} ${formatInr(BigInt(s.amountMinor))}`).join(" · ") : null,
  };
}

export function recordSplitDecision(db: Db, user: SessionUser, caseId: string, input: { method: SplitMethod; note: string }) {
  return db.$transaction(async (tx) => {
    await loadCaseForUser(tx, user, caseId, "write");
    if (!["PROPORTIONAL", "FIRST_IN_FIRST_OUT", "COURT"].includes(input.method)) throw new AppError("Choose one of the three routes.", "VALIDATION", { method: "Choose a route." });
    const note = input.note.trim();
    if (note.length < 10) throw new AppError("Write down why this route fits the case; the SOP asks for a recorded reason.", "VALIDATION", { note: "Give your reason in a sentence (at least 10 characters)." });
    const d = await load(tx, caseId);
    if (d.claims.length < 2) throw new AppError("A split is needed only when more than one victim has a claim.", "PRECONDITION");
    if (!d.holds.length) throw new AppError("No hold with a confirmed amount: there is nothing to split yet.", "PRECONDITION");
    const pending = await tx.allocation.count({ where: { caseId, status: { in: ["PROPOSED", "CONFIRMED"] } } });
    if (pending) throw new AppError("Allocations are already proposed or confirmed for this case. Withdraw them in the ledger before recording a different split.", "CONFLICT");
    const { claims, prop, fifo } = compute(d);
    const shares = input.method === "PROPORTIONAL" ? prop : input.method === "FIRST_IN_FIRST_OUT" ? fifo.shares : [];
    const at = now();
    const decision = await tx.allocationDecision.create({
      data: { caseId, method: input.method, note, sharesJson: JSON.stringify(totalsByClaim(shares, claims).map((t) => ({ claimId: t.claimId, amountMinor: t.amountMinor.toString() }))), decidedById: user.id, decidedAt: at },
    });
    const label = { PROPORTIONAL: "in proportion to the losses", FIRST_IN_FIRST_OUT: "first in, first out", COURT: "left to the court" }[input.method];
    for (const s of shares) {
      if (!s.claimId || s.amountMinor <= 0n) continue;
      const hold = d.holds.find((h) => h.id === s.holdId)!;
      const claim = d.claims.find((c) => c.id === s.claimId)!;
      const a = await tx.allocation.create({ data: { caseId, holdId: s.holdId, claimId: s.claimId, amountMinor: s.amountMinor, status: "PROPOSED", basis: `Split ${label} (decision of ${formatDayMonthIST(at)}): ${note}`, createdById: user.id, createdAt: at } });
      await recordAudit(tx, { caseId, actorId: user.id, action: "funds.allocation_proposed", objectType: "Allocation", objectId: a.id, summary: `Proposed: ${formatInr(s.amountMinor)} held in ${hold.account.label} for ${claim.victim.label}`, detail: { decisionId: decision.id }, at });
    }
    await recordAudit(tx, { caseId, actorId: user.id, action: "funds.split_decided", objectType: "AllocationDecision", objectId: decision.id, summary: `Split of the held money decided: ${label}`, detail: { method: input.method, note }, at });
    await refreshRecommendationsTx(tx, caseId, user.id, at);
    return { id: decision.id, proposed: shares.filter((s) => s.claimId).length };
  });
}
