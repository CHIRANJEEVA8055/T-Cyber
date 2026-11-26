import crypto from "node:crypto";
import { computeLedger } from "@/domain/ledger";
import { formatInr, parseRupeesToMinor } from "@/domain/money";
import { istInputToUtc } from "@/domain/time";
import type { Db, Tx } from "../db";
import type { SessionUser } from "../auth/session";
import { loadCaseForUser } from "../auth/access";
import { recordAudit } from "../audit";
import { now } from "../clock";
import { AppError, notFoundError } from "../errors";
import { parseAttributes } from "./facts";
import { refreshRecommendationsTx } from "./tasks";
import { recomputeLayersTx } from "./layers";

/**
 * Financial records. Every amount is parsed with parseRupeesToMinor (bigint paise) and every
 * total is computed by the deterministic ledger in src/domain/ledger.ts — never by hand here.
 */

function money(field: string, raw: string): bigint {
  const parsed = parseRupeesToMinor(raw);
  if (!parsed.ok) throw new AppError(parsed.error, "VALIDATION", { [field]: parsed.error });
  if (parsed.value <= 0n) throw new AppError("Enter an amount greater than zero.", "VALIDATION", { [field]: "Enter an amount greater than zero." });
  return parsed.value;
}

function when(field: string, raw: string): Date {
  const d = istInputToUtc(raw);
  if (!d) throw new AppError("Enter a valid date and time.", "VALIDATION", { [field]: "Enter a valid date and time (IST)." });
  return d;
}

async function entityInCase(tx: Tx, caseId: string, id: string, field: string) {
  const e = await tx.entity.findUnique({ where: { id } });
  if (!e || e.caseId !== caseId) throw new AppError("Choose a record from this case.", "VALIDATION", { [field]: "Choose a record from this case." });
  return e;
}

async function claimInCase(tx: Tx, caseId: string, id: string) {
  const c = await tx.victimClaim.findUnique({ where: { id }, include: { victim: true } });
  if (!c || c.caseId !== caseId) throw new AppError("Choose a victim claim from this case.", "VALIDATION", { claimId: "Choose a claim from this case." });
  return c;
}

export function upsertClaim(db: Db, user: SessionUser, caseId: string, input: { victimEntityId: string; lossRupees: string; basis: string }) {
  return db.$transaction(async (tx) => {
    await loadCaseForUser(tx, user, caseId, "write");
    const victim = await entityInCase(tx, caseId, input.victimEntityId, "victimEntityId");
    if (victim.kind !== "PERSON") throw new AppError("A claim must belong to a person.", "VALIDATION", { victimEntityId: "Choose a person." });
    const loss = money("lossRupees", input.lossRupees);
    if (input.basis.trim().length < 3) throw new AppError("State the basis for the loss figure.", "VALIDATION", { basis: "State where the loss figure comes from." });
    const existing = await tx.victimClaim.findUnique({ where: { caseId_victimEntityId: { caseId, victimEntityId: victim.id } } });
    const claim = await tx.victimClaim.upsert({
      where: { caseId_victimEntityId: { caseId, victimEntityId: victim.id } },
      create: { caseId, victimEntityId: victim.id, lossAmountMinor: loss, basis: input.basis.trim(), createdAt: now() },
      update: { lossAmountMinor: loss, basis: input.basis.trim(), status: "ACTIVE" },
    });
    await tx.partyRole.upsert({
      where: { caseId_entityId_role: { caseId, entityId: victim.id, role: "VICTIM" } },
      create: { caseId, entityId: victim.id, role: "VICTIM", basis: input.basis.trim(), createdAt: now() },
      update: {},
    });
    await recordAudit(tx, {
      caseId,
      actorId: user.id,
      action: existing ? "funds.claim_updated" : "funds.claim_recorded",
      objectType: "VictimClaim",
      objectId: claim.id,
      summary: existing
        ? `Loss for ${victim.label} changed from ${formatInr(existing.lossAmountMinor)} to ${formatInr(loss)}`
        : `Loss of ${formatInr(loss)} recorded for ${victim.label}`,
      detail: { basis: input.basis },
    });
    return claim;
  });
}

export interface ManualTransactionInput {
  fromEntityId: string;
  toEntityId: string;
  amountRupees: string;
  occurredAt: string;
  channel: string;
  reference: string | null;
  kind: "VICTIM_PAYMENT" | "ONWARD_TRANSFER" | "CASH_WITHDRAWAL";
  claimId: string | null;
  sourceNote: string;
  evidenceId?: string | null;
  locator?: string | null;
  excerpt?: string | null;
}

export function addManualTransaction(db: Db, user: SessionUser, caseId: string, input: ManualTransactionInput) {
  return db.$transaction(async (tx) => {
    await loadCaseForUser(tx, user, caseId, "write");
    const from = await entityInCase(tx, caseId, input.fromEntityId, "fromEntityId");
    const to = await entityInCase(tx, caseId, input.toEntityId, "toEntityId");
    if (from.id === to.id) throw new AppError("The sending and receiving accounts must be different.", "VALIDATION", { toEntityId: "Choose a different account." });
    const amount = money("amountRupees", input.amountRupees);
    const occurredAt = when("occurredAt", input.occurredAt);
    if (input.kind === "VICTIM_PAYMENT" && !input.claimId) throw new AppError("Link a victim payment to the victim's claim.", "VALIDATION", { claimId: "Choose the victim's claim." });
    if (input.claimId) await claimInCase(tx, caseId, input.claimId);
    if (input.sourceNote.trim().length < 3 && !input.evidenceId) throw new AppError("Cite the source of this transaction.", "VALIDATION", { sourceNote: "Cite the document or record this comes from." });
    let layer = 1;
    if (input.kind !== "VICTIM_PAYMENT") {
      const incoming = await tx.transaction.findMany({ where: { caseId, toEntityId: from.id } });
      layer = incoming.length ? Math.min(...incoming.map((t) => t.layer)) + 1 : 2;
    }
    const reference = input.reference?.trim() || null;
    const dedupeKey = reference ? `REF:${reference.toUpperCase()}` : `MANUAL:${crypto.randomUUID()}`;
    const exists = await tx.transaction.findUnique({ where: { caseId_dedupeKey: { caseId, dedupeKey } } });
    if (exists) throw new AppError(`A transaction with reference ${reference} is already recorded in this case.`, "CONFLICT", { reference: "Already recorded." });
    const at = now();
    const txn = await tx.transaction.create({
      data: {
        caseId,
        fromEntityId: from.id,
        toEntityId: to.id,
        amountMinor: amount,
        occurredAt,
        channel: input.channel,
        reference,
        kind: input.kind,
        layer,
        claimId: input.claimId,
        status: input.kind === "VICTIM_PAYMENT" ? "REPORTED_BY_VICTIM" : "CONFIRMED_BY_BANK",
        discoveredAt: at,
        // A transfer cannot be discovered before the records at either end of it.
        discoveryPhase: Math.max(from.discoveryPhase, to.discoveryPhase),
        dedupeKey,
        createdAt: at,
      },
    });
    if (input.evidenceId) {
      const ev = await tx.evidenceItem.findUnique({ where: { id: input.evidenceId } });
      if (!ev || ev.caseId !== caseId) throw new AppError("Choose evidence from this case.", "VALIDATION", { evidenceId: "Choose evidence from this case." });
      const locator = input.locator?.trim() || "document";
      await tx.sourceAssertion.create({
        data: { caseId, evidenceId: ev.id, locator, excerpt: input.excerpt?.trim() || input.sourceNote.trim(), subjectType: "TRANSACTION", subjectId: txn.id, stance: "SUPPORTS", dedupeKey: `TRANSACTION:${txn.id}:${ev.id}:${locator}:SUPPORTS`, createdById: user.id, createdAt: at },
      });
    }
    await recordAudit(tx, {
      caseId,
      actorId: user.id,
      action: "funds.transaction_recorded",
      objectType: "Transaction",
      objectId: txn.id,
      summary: `Transaction recorded: ${formatInr(amount)} from ${from.label} to ${to.label} (layer ${layer})`,
      detail: { sourceNote: input.sourceNote, evidenceId: input.evidenceId ?? null },
    });
    await recomputeLayersTx(tx, caseId);
    await refreshRecommendationsTx(tx, caseId, user.id);
    return tx.transaction.findUniqueOrThrow({ where: { id: txn.id } });
  });
}

function holdKeyFor(account: { attributesJson: string; normalizedValue: string }): string {
  return `${parseAttributes(account.attributesJson).bank ?? "BANK"}:${account.normalizedValue}`;
}

/** Called inside request submission: records that a hold was requested. Never sets an amount held. */
export async function recordHoldRequestedTx(tx: Tx, caseId: string, requestId: string, accountEntityId: string, actorId: string) {
  const account = await tx.entity.findUniqueOrThrow({ where: { id: accountEntityId } });
  const holdKey = holdKeyFor(account);
  const existing = await tx.hold.findUnique({ where: { caseId_holdKey: { caseId, holdKey } } });
  if (existing && existing.status !== "REQUESTED") return existing;
  const incoming = await tx.transaction.findMany({ where: { caseId, toEntityId: account.id } });
  const requested = incoming.length ? incoming.reduce((s, t) => s + t.amountMinor, 0n) : null;
  const at = now();
  const hold = await tx.hold.upsert({
    where: { caseId_holdKey: { caseId, holdKey } },
    create: { caseId, accountEntityId: account.id, holdKey, status: "REQUESTED", requestedAmountMinor: requested, requestId, createdAt: at },
    update: { requestedAmountMinor: requested, requestId, version: { increment: 1 } },
  });
  await tx.holdEvent.create({
    data: { holdId: hold.id, caseId, at, recordedAt: at, type: "REQUESTED", amountMinor: requested, note: `Hold requested from the bank. No amount is held until the bank confirms it.`, actorId },
  });
  return hold;
}

export function recordHoldConfirmation(
  db: Db,
  user: SessionUser,
  caseId: string,
  input: { accountEntityId: string; amountRupees: string | null; asOf: string; bankReference: string | null; note: string; evidenceId?: string | null; locator?: string | null; excerpt?: string | null },
) {
  return db.$transaction(async (tx) => {
    await loadCaseForUser(tx, user, caseId, "write");
    const account = await entityInCase(tx, caseId, input.accountEntityId, "accountEntityId");
    const amount = input.amountRupees ? money("amountRupees", input.amountRupees) : null;
    const asOf = when("asOf", input.asOf);
    if (input.note.trim().length < 3 && !input.evidenceId) throw new AppError("Cite the bank's confirmation.", "VALIDATION", { note: "Cite the bank's confirmation." });
    const holdKey = holdKeyFor(account);
    const existing = await tx.hold.findUnique({ where: { caseId_holdKey: { caseId, holdKey } } });
    const at = now();
    const hold = await tx.hold.upsert({
      where: { caseId_holdKey: { caseId, holdKey } },
      create: { caseId, accountEntityId: account.id, holdKey, bankReference: input.bankReference, status: amount === null ? "RESTRICTION_CONFIRMED" : "CONFIRMED_HELD", confirmedAmountMinor: amount, confirmedAsOf: amount === null ? null : asOf, createdAt: at },
      update: { bankReference: input.bankReference ?? existing?.bankReference, status: amount === null ? "RESTRICTION_CONFIRMED" : "CONFIRMED_HELD", confirmedAmountMinor: amount, confirmedAsOf: amount === null ? null : asOf, version: { increment: 1 } },
    });
    await tx.holdEvent.create({
      data: {
        holdId: hold.id,
        caseId,
        at: asOf,
        recordedAt: at,
        type: amount === null ? "RESTRICTION_CONFIRMED" : existing?.confirmedAmountMinor != null ? "AMOUNT_CHANGED" : "AMOUNT_CONFIRMED",
        amountMinor: amount,
        previousAmountMinor: existing?.confirmedAmountMinor ?? null,
        note: input.note.trim(),
        actorId: user.id,
      },
    });
    if (input.evidenceId) {
      const locator = input.locator?.trim() || "document";
      await tx.sourceAssertion.upsert({
        where: { caseId_dedupeKey: { caseId, dedupeKey: `HOLD:${hold.id}:${input.evidenceId}:${locator}:SUPPORTS` } },
        create: { caseId, evidenceId: input.evidenceId, locator, excerpt: input.excerpt?.trim() || input.note.trim(), subjectType: "HOLD", subjectId: hold.id, stance: "SUPPORTS", dedupeKey: `HOLD:${hold.id}:${input.evidenceId}:${locator}:SUPPORTS`, createdById: user.id, createdAt: at },
        update: {},
      });
    }
    await recordAudit(tx, {
      caseId,
      actorId: user.id,
      action: "funds.hold_confirmed",
      objectType: "Hold",
      objectId: hold.id,
      summary: amount === null ? `Restriction confirmed on ${account.label}; amount not stated` : `Hold of ${formatInr(amount)} confirmed on ${account.label}`,
    });
    await refreshRecommendationsTx(tx, caseId, user.id);
    return hold;
  });
}

export function recordHoldChange(db: Db, user: SessionUser, holdId: string, input: { type: "AMOUNT_CHANGED" | "RELEASED"; amountRupees: string | null; at: string; note: string }) {
  return db.$transaction(async (tx) => {
    const hold = await tx.hold.findUnique({ where: { id: holdId }, include: { account: true } });
    if (!hold) throw notFoundError("hold");
    await loadCaseForUser(tx, user, hold.caseId, "write");
    if (input.note.trim().length < 3) throw new AppError("Describe the change and its source.", "VALIDATION", { note: "Describe the change and its source." });
    const at = when("at", input.at);
    const amount = input.type === "AMOUNT_CHANGED" ? money("amountRupees", input.amountRupees ?? "") : null;
    await tx.hold.update({
      where: { id: holdId },
      data: input.type === "RELEASED" ? { status: "RELEASED", version: { increment: 1 } } : { status: "CONFIRMED_HELD", confirmedAmountMinor: amount, confirmedAsOf: at, version: { increment: 1 } },
    });
    await tx.holdEvent.create({ data: { holdId, caseId: hold.caseId, at, recordedAt: now(), type: input.type, amountMinor: amount, previousAmountMinor: hold.confirmedAmountMinor, note: input.note.trim(), actorId: user.id } });
    await recordAudit(tx, {
      caseId: hold.caseId,
      actorId: user.id,
      action: input.type === "RELEASED" ? "funds.hold_released" : "funds.hold_changed",
      objectType: "Hold",
      objectId: holdId,
      summary: input.type === "RELEASED" ? `Hold on ${hold.account.label} released by the bank` : `Held amount on ${hold.account.label} changed to ${formatInr(amount!)}`,
    });
    await refreshRecommendationsTx(tx, hold.caseId, user.id);
  });
}

export function proposeAllocation(db: Db, user: SessionUser, caseId: string, input: { holdId: string; claimId: string; amountRupees: string; basis: string }) {
  return db.$transaction(async (tx) => {
    await loadCaseForUser(tx, user, caseId, "write");
    const hold = await tx.hold.findUnique({ where: { id: input.holdId }, include: { account: true } });
    if (!hold || hold.caseId !== caseId) throw new AppError("Choose a hold from this case.", "VALIDATION", { holdId: "Choose a hold." });
    const claim = await claimInCase(tx, caseId, input.claimId);
    const amount = money("amountRupees", input.amountRupees);
    if (input.basis.trim().length < 5) throw new AppError("Explain why these funds belong to this claim.", "VALIDATION", { basis: "Explain the basis (at least 5 characters)." });
    const allocation = await tx.allocation.create({ data: { caseId, holdId: hold.id, claimId: claim.id, amountMinor: amount, status: "PROPOSED", basis: input.basis.trim(), createdById: user.id, createdAt: now() } });
    await recordAudit(tx, { caseId, actorId: user.id, action: "funds.allocation_proposed", objectType: "Allocation", objectId: allocation.id, summary: `Proposed: ${formatInr(amount)} held in ${hold.account.label} for ${claim.victim.label}`, detail: { basis: input.basis } });
    return allocation;
  });
}

export function confirmAllocation(db: Db, user: SessionUser, allocationId: string, input: { acknowledgeOverAllocation: boolean }) {
  return db.$transaction(async (tx) => {
    const a = await tx.allocation.findUnique({ where: { id: allocationId }, include: { hold: { include: { account: true } }, claim: { include: { victim: true } } } });
    if (!a) throw notFoundError("allocation");
    await loadCaseForUser(tx, user, a.caseId, "write");
    if (a.status !== "PROPOSED") throw new AppError("Only a proposed allocation can be confirmed.", "PRECONDITION");
    const confirmed = await tx.allocation.findMany({ where: { holdId: a.holdId, status: "CONFIRMED" } });
    const already = confirmed.reduce((s, x) => s + x.amountMinor, 0n);
    const held = a.hold.status === "CONFIRMED_HELD" ? a.hold.confirmedAmountMinor : null;
    const exceeds = held === null || already + a.amountMinor > held;
    if (exceeds && !input.acknowledgeOverAllocation) {
      throw new AppError(
        held === null
          ? "The bank has not confirmed a held amount for this account, so this allocation cannot be backed by held funds. Confirm only if you accept that the case will show 'Needs reconciliation'."
          : `This would exceed the confirmed held amount (${formatInr(held)}) by ${formatInr(already + a.amountMinor - held)}. Confirm only if you accept that the case will show 'Needs reconciliation'.`,
        "PRECONDITION",
      );
    }
    await tx.allocation.update({ where: { id: allocationId }, data: { status: "CONFIRMED", decidedById: user.id, decidedAt: now(), decisionNote: exceeds ? "Confirmed with acknowledged over-allocation; needs reconciliation." : null } });
    await recordAudit(tx, {
      caseId: a.caseId,
      actorId: user.id,
      action: "funds.allocation_confirmed",
      objectType: "Allocation",
      objectId: allocationId,
      summary: `Confirmed: ${formatInr(a.amountMinor)} held in ${a.hold.account.label} allocated to ${a.claim.victim.label}${exceeds ? " (exceeds held amount: needs reconciliation)" : ""}`,
    });
    await refreshRecommendationsTx(tx, a.caseId, user.id);
  });
}

export function withdrawAllocation(db: Db, user: SessionUser, allocationId: string, reason: string) {
  return db.$transaction(async (tx) => {
    const a = await tx.allocation.findUnique({ where: { id: allocationId }, include: { hold: { include: { account: true } }, claim: { include: { victim: true } } } });
    if (!a) throw notFoundError("allocation");
    await loadCaseForUser(tx, user, a.caseId, "write");
    if (a.status === "WITHDRAWN") return;
    if (reason.trim().length < 3) throw new AppError("Give a reason for withdrawing.", "VALIDATION", { reason: "Give a reason." });
    await tx.allocation.update({ where: { id: allocationId }, data: { status: "WITHDRAWN", decidedById: user.id, decidedAt: now(), decisionNote: reason.trim() } });
    await recordAudit(tx, { caseId: a.caseId, actorId: user.id, action: "funds.allocation_withdrawn", objectType: "Allocation", objectId: allocationId, summary: `Withdrawn: ${formatInr(a.amountMinor)} for ${a.claim.victim.label} from ${a.hold.account.label}. ${reason.trim()}` });
    await refreshRecommendationsTx(tx, a.caseId, user.id);
  });
}

export function recordRefund(
  db: Db,
  user: SessionUser,
  caseId: string,
  input: { claimId: string; holdId: string | null; amountRupees: string; authorityReference: string; authorisedAt: string },
) {
  return db.$transaction(async (tx) => {
    await loadCaseForUser(tx, user, caseId, "write");
    const claim = await claimInCase(tx, caseId, input.claimId);
    const amount = money("amountRupees", input.amountRupees);
    if (input.authorityReference.trim().length < 3) {
      throw new AppError("Record the order or approval reference that authorises this refund.", "VALIDATION", { authorityReference: "Enter the authorising order or approval reference." });
    }
    if (input.holdId) {
      const hold = await tx.hold.findUnique({ where: { id: input.holdId } });
      if (!hold || hold.caseId !== caseId) throw new AppError("Choose a hold from this case.", "VALIDATION", { holdId: "Choose a hold from this case." });
    }
    const authorisedAt = when("authorisedAt", input.authorisedAt);
    const refund = await tx.refund.create({
      data: { caseId, claimId: claim.id, holdId: input.holdId, amountMinor: amount, status: "AUTHORISED", authorityReference: input.authorityReference.trim(), authorisedAt, createdById: user.id, createdAt: now() },
    });
    await recordAudit(tx, { caseId, actorId: user.id, action: "funds.refund_authorised", objectType: "Refund", objectId: refund.id, summary: `Refund of ${formatInr(amount)} to ${claim.victim.label} authorised (${input.authorityReference.trim()}). Not yet returned.` });
    await refreshRecommendationsTx(tx, caseId, user.id);
    return refund;
  });
}

const REFUND_NEXT: Record<string, string[]> = {
  AUTHORISED: ["INITIATED", "FAILED", "CANCELLED"],
  INITIATED: ["CREDIT_CONFIRMED", "FAILED"],
  FAILED: ["INITIATED", "CANCELLED"],
};

export function advanceRefund(db: Db, user: SessionUser, refundId: string, input: { to: "INITIATED" | "CREDIT_CONFIRMED" | "FAILED" | "CANCELLED"; at: string; note: string }) {
  return db.$transaction(async (tx) => {
    const r = await tx.refund.findUnique({ where: { id: refundId }, include: { claim: { include: { victim: true } } } });
    if (!r) throw notFoundError("refund");
    await loadCaseForUser(tx, user, r.caseId, "write");
    if (!(REFUND_NEXT[r.status] ?? []).includes(input.to)) {
      throw new AppError(
        input.to === "CREDIT_CONFIRMED" ? "A refund must be initiated before its credit can be confirmed." : `A refund that is ${r.status.toLowerCase().replace(/_/g, " ")} cannot move to ${input.to.toLowerCase().replace(/_/g, " ")}.`,
        "PRECONDITION",
      );
    }
    if (input.note.trim().length < 3) throw new AppError("Describe the confirmation and its source.", "VALIDATION", { note: "Describe the source of this update." });
    const at = when("at", input.at);
    if (input.to === "CREDIT_CONFIRMED" && r.holdId) {
      const hold = await tx.hold.findUniqueOrThrow({ where: { id: r.holdId }, include: { account: true } });
      if (hold.status !== "CONFIRMED_HELD" || hold.confirmedAmountMinor === null || hold.confirmedAmountMinor < r.amountMinor) {
        throw new AppError(`The refund (${formatInr(r.amountMinor)}) is larger than the amount confirmed as held in ${hold.account.label}. Update the hold first.`, "PRECONDITION");
      }
      const remaining = hold.confirmedAmountMinor - r.amountMinor;
      await tx.hold.update({ where: { id: hold.id }, data: { confirmedAmountMinor: remaining, confirmedAsOf: at, status: remaining === 0n ? "RELEASED" : "CONFIRMED_HELD", version: { increment: 1 } } });
      await tx.holdEvent.create({
        data: { holdId: hold.id, caseId: r.caseId, at, recordedAt: now(), type: "RELEASED_TO_VICTIM", amountMinor: remaining, previousAmountMinor: hold.confirmedAmountMinor, note: `${formatInr(r.amountMinor)} returned to ${r.claim.victim.label} (refund credit confirmed).`, actorId: user.id },
      });
      const allocation = await tx.allocation.findFirst({ where: { holdId: hold.id, claimId: r.claimId, status: "CONFIRMED" } });
      if (allocation) {
        const left = allocation.amountMinor > r.amountMinor ? allocation.amountMinor - r.amountMinor : 0n;
        await tx.allocation.update({
          where: { id: allocation.id },
          data: left === 0n ? { amountMinor: 0n, status: "WITHDRAWN", decisionNote: "Fully paid out by a confirmed refund." } : { amountMinor: left },
        });
      }
    }
    await tx.refund.update({
      where: { id: refundId },
      data: {
        status: input.to,
        ...(input.to === "INITIATED" ? { initiatedAt: at } : {}),
        ...(input.to === "CREDIT_CONFIRMED" ? { creditConfirmedAt: at } : {}),
        note: input.note.trim(),
        version: { increment: 1 },
      },
    });
    await recordAudit(tx, {
      caseId: r.caseId,
      actorId: user.id,
      action: `funds.refund_${input.to.toLowerCase()}`,
      objectType: "Refund",
      objectId: refundId,
      summary:
        input.to === "CREDIT_CONFIRMED"
          ? `${formatInr(r.amountMinor)} returned to ${r.claim.victim.label}: credit confirmed`
          : `Refund of ${formatInr(r.amountMinor)} to ${r.claim.victim.label}: ${input.to.toLowerCase().replace(/_/g, " ")}`,
      detail: { note: input.note },
    });
    await refreshRecommendationsTx(tx, r.caseId, user.id);
  });
}

const s = (v: bigint | null) => (v === null ? null : v.toString());

export async function getLedgerView(db: Db, user: SessionUser, caseId: string) {
  await loadCaseForUser(db, user, caseId, "read");
  const [claims, holds, allocations, refunds, transactions, assertions, users] = await Promise.all([
    db.victimClaim.findMany({ where: { caseId }, include: { victim: true }, orderBy: { createdAt: "asc" } }),
    db.hold.findMany({ where: { caseId }, include: { account: true, events: { orderBy: { at: "asc" } } }, orderBy: { createdAt: "asc" } }),
    db.allocation.findMany({ where: { caseId }, orderBy: { createdAt: "asc" } }),
    db.refund.findMany({ where: { caseId }, orderBy: { createdAt: "asc" } }),
    db.transaction.findMany({ where: { caseId }, include: { fromEntity: true, toEntity: true }, orderBy: [{ layer: "asc" }, { occurredAt: "asc" }] }),
    db.sourceAssertion.findMany({ where: { caseId, subjectType: { in: ["TRANSACTION", "HOLD", "CLAIM", "REFUND"] } }, include: { evidence: { select: { title: true } } } }),
    db.user.findMany({ select: { id: true, displayName: true, rank: true } }),
  ]);
  const requests = await db.request.findMany({ where: { caseId, id: { in: holds.map((h) => h.requestId).filter((x): x is string => !!x) } }, select: { id: true, reference: true } });
  const position = computeLedger({
    claims: claims.map((c) => ({ id: c.id, lossMinor: c.lossAmountMinor, status: c.status })),
    holds: holds.map((h) => ({ id: h.id, status: h.status, confirmedMinor: h.confirmedAmountMinor })),
    allocations: allocations.map((a) => ({ id: a.id, holdId: a.holdId, claimId: a.claimId, amountMinor: a.amountMinor, status: a.status })),
    refunds: refunds.map((r) => ({ id: r.id, claimId: r.claimId, amountMinor: r.amountMinor, status: r.status })),
    transactions: transactions.map((t) => ({ id: t.id, layer: t.layer, amountMinor: t.amountMinor, claimId: t.claimId, kind: t.kind })),
  });
  const userName = (id: string | null) => {
    const u = users.find((x) => x.id === id);
    return u ? `${u.rank} ${u.displayName}` : null;
  };
  const sourcesFor = (type: string, id: string) =>
    assertions.filter((a) => a.subjectType === type && a.subjectId === id).map((a) => ({ evidenceId: a.evidenceId, evidenceTitle: a.evidence.title, locator: a.locator, excerpt: a.excerpt, stance: a.stance }));
  const times = [...holds.map((h) => h.confirmedAsOf), ...refunds.map((r) => r.creditConfirmedAt ?? r.initiatedAt ?? r.authorisedAt), ...transactions.map((t) => t.discoveredAt)].filter((d): d is Date => !!d);
  const asOf = times.length ? new Date(Math.max(...times.map((d) => d.getTime()))) : null;
  return {
    asOf: asOf?.toISOString() ?? null,
    position: {
      ...position,
      totalLossMinor: position.totalLossMinor.toString(),
      confirmedRefundsMinor: position.confirmedRefundsMinor.toString(),
      outstandingLossMinor: position.outstandingLossMinor.toString(),
      refundPipeline: {
        authorisedMinor: position.refundPipeline.authorisedMinor.toString(),
        initiatedMinor: position.refundPipeline.initiatedMinor.toString(),
        failedMinor: position.refundPipeline.failedMinor.toString(),
      },
      confirmedHeldMinor: position.confirmedHeldMinor.toString(),
      allocatedConfirmedMinor: position.allocatedConfirmedMinor.toString(),
      unallocatedHeldMinor: s(position.unallocatedHeldMinor),
      neitherReturnedNorSecuredMinor: s(position.neitherReturnedNorSecuredMinor),
      perHold: position.perHold.map((h) => ({ ...h, confirmedMinor: s(h.confirmedMinor), allocatedConfirmedMinor: h.allocatedConfirmedMinor.toString(), proposedMinor: h.proposedMinor.toString(), unallocatedMinor: s(h.unallocatedMinor) })),
      perClaim: position.perClaim.map((c) => ({
        ...c,
        lossMinor: c.lossMinor.toString(),
        confirmedRefundsMinor: c.confirmedRefundsMinor.toString(),
        outstandingMinor: c.outstandingMinor.toString(),
        allocatedMinor: c.allocatedMinor.toString(),
        proposedMinor: c.proposedMinor.toString(),
        neitherMinor: s(c.neitherMinor),
        victimPaymentsMinor: c.victimPaymentsMinor.toString(),
      })),
      transfersByLayer: position.transfersByLayer.map((l) => ({ ...l, totalMinor: l.totalMinor.toString() })),
    },
    claims: claims.map((c) => ({ id: c.id, victimEntityId: c.victimEntityId, victimLabel: c.victim.label, lossMinor: c.lossAmountMinor.toString(), basis: c.basis, status: c.status })),
    holds: holds.map((h) => ({
      id: h.id,
      accountEntityId: h.accountEntityId,
      accountLabel: h.account.label,
      accountValue: h.account.value,
      bank: (parseAttributes(h.account.attributesJson).bank as string | undefined) ?? null,
      status: h.status,
      requestedMinor: s(h.requestedAmountMinor),
      confirmedMinor: s(h.confirmedAmountMinor),
      confirmedAsOf: h.confirmedAsOf?.toISOString() ?? null,
      bankReference: h.bankReference,
      requestReference: requests.find((r) => r.id === h.requestId)?.reference ?? null,
      requestId: h.requestId,
      events: h.events.map((e) => ({ id: e.id, at: e.at.toISOString(), type: e.type, amountMinor: s(e.amountMinor), previousAmountMinor: s(e.previousAmountMinor), note: e.note, actor: userName(e.actorId) })),
      sources: sourcesFor("HOLD", h.id),
    })),
    allocations: allocations.map((a) => ({ id: a.id, holdId: a.holdId, claimId: a.claimId, amountMinor: a.amountMinor.toString(), status: a.status, basis: a.basis, createdBy: userName(a.createdById), createdAt: a.createdAt.toISOString(), decidedBy: userName(a.decidedById), decidedAt: a.decidedAt?.toISOString() ?? null, decisionNote: a.decisionNote })),
    refunds: refunds.map((r) => ({ id: r.id, claimId: r.claimId, holdId: r.holdId, amountMinor: r.amountMinor.toString(), status: r.status, authorityReference: r.authorityReference, authorisedAt: r.authorisedAt?.toISOString() ?? null, initiatedAt: r.initiatedAt?.toISOString() ?? null, creditConfirmedAt: r.creditConfirmedAt?.toISOString() ?? null, note: r.note })),
    transactions: transactions.map((t) => ({
      id: t.id,
      fromEntityId: t.fromEntityId,
      fromLabel: t.fromEntity.label,
      toEntityId: t.toEntityId,
      toLabel: t.toEntity.label,
      toValue: t.toEntity.value,
      amountMinor: t.amountMinor.toString(),
      occurredAt: t.occurredAt.toISOString(),
      reference: t.reference,
      channel: t.channel,
      kind: t.kind,
      layer: t.layer,
      status: t.status,
      claimId: t.claimId,
      discoveredAt: t.discoveredAt.toISOString(),
      discoveryPhase: t.discoveryPhase,
      sources: sourcesFor("TRANSACTION", t.id),
    })),
  };
}

export type LedgerView = Awaited<ReturnType<typeof getLedgerView>>;

/** Options for funds forms: accounts and people in the case, and its original documents. */
export async function getFundsFormOptions(db: Db, user: SessionUser, caseId: string) {
  await loadCaseForUser(db, user, caseId, "read");
  const [entities, evidence] = await Promise.all([
    db.entity.findMany({ where: { caseId }, orderBy: { label: "asc" }, select: { id: true, label: true, value: true, kind: true } }),
    db.evidenceItem.findMany({ where: { caseId, derivation: "ORIGINAL" }, orderBy: { receivedAt: "asc" }, select: { id: true, title: true } }),
  ]);
  return { entities: entities.map((e) => ({ id: e.id, kind: e.kind, label: e.kind === "PERSON" || e.label === e.value ? e.label : `${e.label} (${e.value})` })), evidence };
}
