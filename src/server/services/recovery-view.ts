import { computeLedger } from "@/domain/ledger";
import { formatInr } from "@/domain/money";
import { formatDateIST, formatTimeIST } from "@/domain/time";
import type { Tone } from "@/domain/standing";
import { canWriteCase } from "@/domain/permissions";
import { shortRank } from "@/lib/cn";
import type { Db } from "../db";
import type { SessionUser } from "../auth/session";
import { loadCaseForUser } from "../auth/access";
import { now } from "../clock";
import { calendarDays, shortOrg } from "./dashboard";
import { parseAttributes } from "./facts";
import { shownId } from "@/domain/identifiers";

/**
 * Transactions & recovery (design: Recovery artboard). Every figure is read from a bank record or a recorded
 * decision; nothing is estimated. "Lost" falls only when a victim's bank confirms a credit.
 */

const plain = (s: string) => s.replace(/\s*\(synthetic\)$/, "");
const when = (d: Date) => `${formatDateIST(d)} ${formatTimeIST(d).replace(" IST", "")}`;
const NUM = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const maskRef = (r: string) => r.trim();

export async function getRecoveryView(db: Db, user: SessionUser, caseId: string, at = now()) {
  const kase = await loadCaseForUser(db, user, caseId, "read");
  const writer = canWriteCase(user, { stationId: kase.stationId, assignedUserIds: kase.assignments.map((a) => a.userId) });
  const [claims, holds, allocations, refunds, transactions, entities, assertions, contacts, users, requests] = await Promise.all([
    db.victimClaim.findMany({ where: { caseId }, include: { victim: true }, orderBy: { createdAt: "asc" } }),
    db.hold.findMany({ where: { caseId }, include: { account: true }, orderBy: { createdAt: "asc" } }),
    db.allocation.findMany({ where: { caseId }, orderBy: { createdAt: "asc" } }),
    db.refund.findMany({ where: { caseId }, orderBy: { createdAt: "asc" } }),
    db.transaction.findMany({ where: { caseId }, include: { fromEntity: true, toEntity: true }, orderBy: { occurredAt: "asc" } }),
    db.entity.findMany({ where: { caseId } }),
    db.sourceAssertion.findMany({ where: { caseId, subjectType: { in: ["TRANSACTION", "HOLD"] } }, include: { evidence: { select: { title: true, category: true, response: { select: { request: { select: { recipient: { select: { organisation: true } } } } } } } } }, orderBy: { createdAt: "asc" } }),
    db.contactLog.findMany({ where: { caseId }, orderBy: { at: "desc" } }),
    db.user.findMany({ where: { stationId: kase.stationId }, select: { id: true, displayName: true, rank: true } }),
    db.request.findMany({ where: { caseId, status: { not: "DISCARDED" } }, include: { items: true, subjects: true } }),
  ]);
  const ledger = computeLedger({
    claims: claims.map((c) => ({ id: c.id, lossMinor: c.lossAmountMinor, status: c.status })),
    holds: holds.map((h) => ({ id: h.id, status: h.status, confirmedMinor: h.confirmedAmountMinor })),
    allocations: allocations.map((a) => ({ id: a.id, holdId: a.holdId, claimId: a.claimId, amountMinor: a.amountMinor, status: a.status })),
    refunds: refunds.map((r) => ({ id: r.id, claimId: r.claimId, amountMinor: r.amountMinor, status: r.status })),
    transactions: transactions.map((t) => ({ id: t.id, layer: t.layer, amountMinor: t.amountMinor, claimId: t.claimId, kind: t.kind })),
  });
  const active = claims.filter((c) => c.status === "ACTIVE");
  const entity = new Map(entities.map((e) => [e.id, e]));
  const bankOf = (id: string) => (parseAttributes(entity.get(id)?.attributesJson ?? "{}") as { bank?: string }).bank;
  const victimName = (claimId: string | null) => plain(claims.find((c) => c.id === claimId)?.victim.label ?? "A victim");
  const who = (id: string) => {
    if (id === user.id) return "you";
    const u = users.find((x) => x.id === id);
    return u ? `${shortRank(u.rank)} ${u.displayName}` : "an officer";
  };
  const recordOf = (type: string, id: string, fallback: string) => {
    const mine = assertions.filter((x) => x.subjectType === type && x.subjectId === id && x.stance !== "CONTRADICTS");
    const a = mine.find((x) => x.evidence.response) ?? mine[0];
    if (!a) return fallback;
    const org = a.evidence.response?.request?.recipient.organisation;
    const row = /row (\d+)/i.exec(a.locator)?.[1];
    if (org && row) return `${shortOrg(org)} row ${row}`;
    if (org) return `${shortOrg(org)} ${a.evidence.category === "BANK_RESPONSE" ? "statement" : "reply"}`;
    if (a.evidence.category === "FIR_COPY") return `FIR${/page (\d+)/i.exec(a.locator) ? `, page ${/page (\d+)/i.exec(a.locator)![1]}` : ""}`;
    return a.evidence.title;
  };
  const disputeNote = (id: string) => {
    const a = assertions.find((x) => x.subjectId === id && x.stance === "CONTRADICTS");
    const d = /dates this \w+ (\d{2} \w{3})/.exec(a?.note ?? "");
    const org = a?.evidence.response?.request?.recipient.organisation;
    return d ? `${org ? shortOrg(org) : "The bank"} dates it ${d[1]}` : "a record disagrees";
  };
  const contradicted = new Set(assertions.filter((a) => a.stance === "CONTRADICTS").map((a) => a.subjectId));

  // --- Measures -------------------------------------------------------------------------------
  const cash = transactions.filter((t) => t.kind === "CASH_WITHDRAWAL");
  const cashMinor = cash.reduce((s, t) => s + t.amountMinor, 0n);
  const heldHolds = holds.filter((h) => h.status === "CONFIRMED_HELD" && (h.confirmedAmountMinor ?? 0n) > 0n);
  const credited = refunds.filter((r) => r.status === "CREDIT_CONFIRMED");
  const accountShort = (id: string) => plain(entity.get(id)?.label ?? "").replace(/^Account\s+/, "") || shownId(entity.get(id)?.value ?? "");
  const measures = {
    lost: { value: formatInr(ledger.totalLossMinor), sub: `by ${active.length === 1 ? "one victim" : `${NUM[active.length] ?? active.length} victims`}` },
    held: { value: formatInr(ledger.confirmedHeldMinor), minor: ledger.confirmedHeldMinor.toString(), sub: heldHolds.length ? heldHolds.map((h) => `${accountShort(h.accountEntityId)} ${formatInr(h.confirmedAmountMinor!)}`).join(" · ") : ledger.unknownHoldCount ? `${ledger.unknownHoldCount} hold amount not confirmed` : "No hold confirmed yet" },
    cash: { value: formatInr(cashMinor), sub: cash.length ? `from ${[...new Set(cash.map((c) => accountShort(c.fromEntityId)))].join(", ")}${ledger.neitherReturnedNorSecuredMinor && ledger.neitherReturnedNorSecuredMinor > 0n ? ", being traced" : ""}` : "None recorded" },
    returned: { value: formatInr(ledger.confirmedRefundsMinor), minor: ledger.confirmedRefundsMinor.toString(), sub: credited.length ? `${credited.length} ${credited.length === 1 ? "credit" : "credits"} confirmed` : "nothing yet" },
  };
  const holdRequested = requests.filter((r) => r.category === "HOLD" && !["DRAFT", "AWAITING_APPROVAL", "APPROVED", "SUBMISSION_FAILED"].includes(r.status)).length ? ledger.totalLossMinor : 0n;
  const allocatedMinor = allocations.filter((a) => a.status !== "WITHDRAWN").reduce((s, a) => s + a.amountMinor, 0n);
  const authorisedMinor = ledger.refundPipeline.authorisedMinor + ledger.refundPipeline.initiatedMinor;
  const movementsMinor = transactions.reduce((s, t) => s + t.amountMinor, 0n);
  const alsoTracked = `Also tracked: hold requested ${formatInr(holdRequested)} · allocated to victims ${formatInr(allocatedMinor)} · refund authorised ${formatInr(authorisedMinor)} · all movements ${formatInr(movementsMinor)}`;

  // --- Where the money went -------------------------------------------------------------------
  const trailAccounts = [...new Set(transactions.flatMap((t) => [t.toEntityId, t.fromEntityId]))].filter((id) => entity.get(id)?.kind === "BANK_ACCOUNT" && !claims.some((c) => c.victimEntityId === id) && (transactions.some((t) => t.toEntityId === id && t.kind !== "CASH_WITHDRAWAL")));
  const payerOwned = (id: string) => /own|payer|not stated/i.test(entity.get(id)?.caseRole ?? "") || /account \(not stated\)/i.test(entity.get(id)?.label ?? "");
  const accounts = trailAccounts.filter((id) => !payerOwned(id));
  const rows: { key: string; at: string; when: string; movement: string; sub: string; amount: string; amountMinor: string; tone: "cash" | "held" | null; record: string; accounts: string[] }[] = [];
  for (const t of transactions) {
    const toBank = bankOf(t.toEntityId);
    const disputed = contradicted.has(t.id);
    const refNote = t.reference ? (t.reference.includes("?") ? `${(t.reference.match(/\?/g) ?? []).length === 2 ? "2 digits" : "some digits"} unreadable` : maskRef(t.reference)) : null;
    const movement =
      t.kind === "VICTIM_PAYMENT"
        ? `${victimName(t.claimId)} paid ${plain(t.toEntity.label)}`
        : t.kind === "CASH_WITHDRAWAL"
          ? `Cash withdrawn from ${plain(t.fromEntity.label)}`
          : `${plain(t.fromEntity.label)} → ${plain(t.toEntity.label)}${toBank ? `, ${toBank}` : ""}`;
    const atmAsked = t.kind === "CASH_WITHDRAWAL" && requests.some((r) => r.items.some((i) => i.itemType === "ATM_DETAILS") && r.subjects.some((s) => s.entityId === t.fromEntityId) && !["DRAFT", "AWAITING_APPROVAL", "APPROVED", "SUBMISSION_FAILED"].includes(r.status));
    const sub =
      t.kind === "CASH_WITHDRAWAL"
        ? `${t.reference ? `ATM ${t.reference}` : "ATM"} · ${t.reference ? "ATM ID on record" : atmAsked ? "ATM ID requested" : "ATM ID not yet asked for"}`
        : [t.channel === "OTHER" ? null : t.channel, refNote, disputed ? disputeNote(t.id) : null].filter(Boolean).join(" · ");
    rows.push({ key: t.id, at: t.occurredAt.toISOString(), when: when(t.occurredAt), movement, sub, amount: formatInr(t.amountMinor), amountMinor: t.amountMinor.toString(), tone: t.kind === "CASH_WITHDRAWAL" ? "cash" : null, record: recordOf("TRANSACTION", t.id, t.status === "CONFIRMED_BY_BANK" ? "Bank record" : t.status === "REPORTED_ON_NCRP" ? "NCRP money trail" : "Victim's account"), accounts: [t.fromEntityId, t.toEntityId] });
  }
  for (const h of heldHolds) {
    const atTime = h.confirmedAsOf ?? h.updatedAt;
    rows.push({ key: `hold:${h.id}`, at: atTime.toISOString(), when: when(atTime), movement: `Hold confirmed on ${plain(h.account.label)}`, sub: ["CFCFRMS", h.bankReference].filter(Boolean).join(" · "), amount: formatInr(h.confirmedAmountMinor!), amountMinor: h.confirmedAmountMinor!.toString(), tone: "held", record: shortOrg(bankOf(h.accountEntityId) ?? "Bank"), accounts: [h.accountEntityId] });
  }
  rows.sort((a, b) => a.at.localeCompare(b.at));

  // --- The accounts ---------------------------------------------------------------------------
  const accountCards = accounts.map((id) => {
    const e = entity.get(id)!;
    const ins = transactions.filter((t) => t.toEntityId === id);
    const outs = transactions.filter((t) => t.fromEntityId === id);
    const inMinor = ins.reduce((s, t) => s + t.amountMinor, 0n);
    const cashOut = outs.filter((t) => t.kind === "CASH_WITHDRAWAL");
    const hold = holds.find((h) => h.accountEntityId === id);
    const UNSENT = ["DRAFT", "AWAITING_APPROVAL", "APPROVED", "SUBMISSION_FAILED"];
    const pendingItems = requests.filter((r) => r.subjects.some((s) => s.entityId === id)).flatMap((r) => r.items.filter((i) => i.status === "PENDING" || i.status === "NOT_PROVIDED").map((i) => ({ i, r })));
    const NAME: Record<string, string> = { STATEMENT: "Statement", KYC: "KYC", ATM_DETAILS: "ATM ID" };
    const asked = [...new Set(pendingItems.filter(({ r }) => !UNSENT.includes(r.status)).map(({ i }) => NAME[i.itemType]).filter((x): x is string => !!x))];
    const drafted = [...new Set(pendingItems.filter(({ r }) => UNSENT.includes(r.status)).map(({ i }) => NAME[i.itemType]).filter((x): x is string => !!x && !asked.includes(x)))];
    const victimsIn = new Set(ins.filter((t) => t.kind === "VICTIM_PAYMENT").map((t) => t.claimId)).size;
    const firstIn = ins[0]?.occurredAt;
    const lastOut = outs.filter((t) => t.kind !== "CASH_WITHDRAWAL").at(-1)?.occurredAt;
    const hours = firstIn && lastOut ? Math.round((lastOut.getTime() - firstIn.getTime()) / 3600000) : null;
    const held = hold?.status === "CONFIRMED_HELD" ? (hold.confirmedAmountMinor ?? null) : null;
    const bits: string[] = [];
    if (victimsIn >= 2) bits.push(`Received ${victimsIn === 2 ? "both" : victimsIn} payments${hours !== null && outs.length && held === 0n ? ` and sent everything on within ${hours} hours` : ""}.`);
    else bits.push(`Got ${formatInr(inMinor)}.`);
    if (cashOut.length) bits.push(`${formatInr(cashOut.reduce((s, t) => s + t.amountMinor, 0n))} went out as cash${hold?.confirmedAsOf && cashOut.every((c) => c.occurredAt < hold.confirmedAsOf!) ? " before the hold" : ""}.`);
    else if (!outs.length && held !== null && held > 0n) bits.push("Nothing moved out. Fully held.");
    if (held === 0n) bits.push(`Now ${hold?.status === "RESTRICTION_CONFIRMED" || held === 0n ? "restricted and empty" : "empty"}.`);
    const and = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
    if (asked.length) bits.push(`${and(asked)} ${asked.length === 1 && asked[0] === "KYC" ? "still awaited" : "asked for"}.`);
    if (drafted.length) bits.push(`${and(drafted)} drafted, not sent yet.`);
    const pill: { text: string; tone: Tone } = held !== null && held > 0n ? { text: `Holds ${formatInr(held)}`, tone: "ok" } : held === 0n ? { text: "Empty", tone: "neutral" } : hold ? { text: hold.status === "REQUESTED" ? "Hold requested" : "Amount not confirmed", tone: "wait" } : { text: "No hold", tone: "gap" };
    return { id, name: `${plain(e.label)} ${shownId(e.value)}`, bank: bankOf(id) ?? null, sentence: bits.join(" "), pill, short: plain(e.label) };
  });

  // --- Each victim ----------------------------------------------------------------------------
  const victims = active.map((c) => {
    const pos = ledger.perClaim.find((p) => p.claimId === c.id);
    const alloc = allocations.filter((a) => a.claimId === c.id && a.status !== "WITHDRAWN").reduce((s, a) => s + a.amountMinor, 0n);
    const cred = pos?.confirmedRefundsMinor ?? 0n;
    const left = c.lossAmountMinor - cred;
    const pct = (m: bigint) => (c.lossAmountMinor > 0n ? Math.min(100, Number((m * 1000n) / c.lossAmountMinor) / 10) : 0);
    return {
      claimId: c.id,
      victimId: c.victimEntityId,
      name: plain(c.victim.label),
      lost: formatInr(c.lossAmountMinor),
      lossMinor: c.lossAmountMinor.toString(),
      remaining: formatInr(left < 0n ? 0n : left),
      creditedMinor: cred.toString(),
      allocatedMinor: alloc.toString(),
      credited: formatInr(cred),
      allocated: formatInr(alloc),
      creditPct: pct(cred),
      allocPct: Math.min(100 - pct(cred), pct(alloc)),
    };
  });

  // --- Keeping the victims informed -----------------------------------------------------------
  const latestFor = new Map<string, string>();
  for (const l of contacts) if (!latestFor.has(l.victimEntityId)) latestFor.set(l.victimEntityId, l.id);
  const calls = contacts.map((l) => {
    const due = l.nextDueAt;
    const latest = latestFor.get(l.victimEntityId) === l.id;
    return {
      id: l.id,
      who: plain(entity.get(l.victimEntityId)?.label ?? "Victim"),
      text: `${formatDateIST(l.at)}, ${formatTimeIST(l.at).replace(" IST", "")} · ${l.channel === "CALL_IN" ? "they called: " : l.channel === "VISIT" ? "visit: " : l.channel === "MESSAGE" ? "message: " : ""}${l.summary.charAt(0).toLowerCase()}${l.summary.slice(1)}`,
      pill: latest && l.followUp ? { text: l.followUp.charAt(0).toUpperCase() + l.followUp.slice(1), tone: "wait" as Tone } : latest && due ? { text: calendarDays(at, due) < 0 ? `Call overdue since ${formatDateIST(due)}` : `Next call ${formatDateIST(due)}`, tone: (calendarDays(at, due) < 0 ? "gap" : "neutral") as Tone } : null,
      by: l.byUserId === user.id ? "Logged by you" : `Logged by ${who(l.byUserId)}`,
      mine: l.byUserId === user.id,
    };
  });
  const silent = victims.filter((v) => {
    const last = contacts.find((l) => l.victimEntityId === v.victimId);
    return !last || calendarDays(last.at, at) >= 7;
  });

  // --- Allocations proposed by a recorded decision -------------------------------------------
  const proposed = allocations
    .filter((a) => a.status !== "WITHDRAWN")
    .map((a) => {
      const h = holds.find((x) => x.id === a.holdId);
      return { id: a.id, status: a.status, text: `${formatInr(a.amountMinor)} held in ${plain(h?.account.label ?? "an account")} for ${victimName(a.claimId)}`, by: who(a.createdById), canConfirm: writer && a.status === "PROPOSED" && user.role === "SUPERVISOR" && a.createdById !== user.id };
    });
  const refundPreview = (() => {
    // The largest allocation, confirmed ones first: the refund most worth previewing.
    const a = allocations.filter((x) => x.status === "CONFIRMED" || x.status === "PROPOSED").sort((p, q) => Number(q.status === "CONFIRMED") - Number(p.status === "CONFIRMED") || (q.amountMinor > p.amountMinor ? 1 : q.amountMinor < p.amountMinor ? -1 : 0))[0];
    if (!a) return null;
    const h = holds.find((x) => x.id === a.holdId);
    return { claimId: a.claimId, amountMinor: a.amountMinor.toString(), label: `Preview a ${formatInr(a.amountMinor)} refund to ${victimName(a.claimId)}`, from: plain(h?.account.label ?? "the account"), victim: victimName(a.claimId), amount: formatInr(a.amountMinor) };
  })();

  return {
    caseId,
    canWrite: writer,
    isSupervisor: user.role === "SUPERVISOR",
    measures,
    alsoTracked,
    reconciliation: ledger.reconciliation.status === "CONSISTENT" ? null : ledger.reconciliation.issues.map((i) => i.message),
    rows,
    accountFilters: accountCards.map((a) => ({ id: a.id, label: a.short })),
    accounts: accountCards,
    victims,
    victimOptions: active.map((c) => ({ id: c.victimEntityId, name: plain(c.victim.label) })),
    calls,
    silent: silent.map((v) => v.name),
    proposed,
    refundPreview,
    totals: { lossMinor: ledger.totalLossMinor.toString(), heldMinor: ledger.confirmedHeldMinor.toString(), returnedMinor: ledger.confirmedRefundsMinor.toString() },
  };
}
export type RecoveryViewData = Awaited<ReturnType<typeof getRecoveryView>>;
