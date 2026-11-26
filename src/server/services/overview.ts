import { computeLedger } from "@/domain/ledger";
import { shortRank } from "@/lib/cn";
import type { Db } from "../db";
import type { SessionUser } from "../auth/session";
import { loadCaseForUser } from "../auth/access";
import { caseReference } from "./cases";
import { now as clockNow } from "../clock";
import { caseMo, moLine } from "@/domain/mo-verticals";

export async function getCaseHeader(db: Db, user: SessionUser, caseId: string) {
  const c = await loadCaseForUser(db, user, caseId, "read");
  const io = c.assignments.find((a) => a.role === "INVESTIGATING_OFFICER");
  const ioUser = io ? await db.user.findUnique({ where: { id: io.userId } }) : null;
  const [toReview, pendingExtraction, victims] = await Promise.all([
    db.response.count({ where: { caseId, OR: [{ reviewStatus: { in: ["UNREVIEWED", "IN_REVIEW"] }, matchStatus: "MATCHED" }, { matchStatus: "NEEDS_MATCH_REVIEW" }] } }),
    db.extractionCandidate.count({ where: { caseId, status: "PENDING" } }),
    db.victimClaim.findMany({ where: { caseId, status: "ACTIVE" }, orderBy: { createdAt: "asc" }, select: { victim: { select: { label: true } } } }),
  ]);
  return {
    id: c.id,
    reference: caseReference(c),
    referenceType: c.referenceType,
    complaintRef: c.complaintRef,
    title: c.title,
    fraudCategory: c.fraudCategory,
    /** The investigation vertical (MO.docx): the officer's choice, or what the facts show. */
    mo: { vertical: c.moVertical, subtype: c.moSubtype, basis: c.moBasis, line: moLine(caseMo(c)) },
    status: c.status,
    closureReason: c.closureReason,
    isDemo: c.isDemo,
    stationName: c.station.name,
    investigatingOfficer: ioUser ? `${shortRank(ioUser.rank)} ${ioUser.displayName}` : "Not assigned",
    registeredAt: (c.registeredAt ?? c.createdAt).toISOString(),
    incidentStart: c.incidentStart?.toISOString() ?? null,
    incidentEnd: c.incidentEnd?.toISOString() ?? null,
    reportedAt: c.reportedAt?.toISOString() ?? null,
    legalSections: c.legalSections,
    legalSectionsSource: c.legalSectionsSource,
    narrative: c.narrative,
    version: c.version,
    responsesToReview: toReview,
    candidatesPending: pendingExtraction,
    /** Victims with an active claim: the first one's name and how many there are, for the case summary. */
    victims: { first: victims[0]?.victim.label ?? null, count: victims.length },
    canWrite: true,
  };
}

export type CaseHeaderData = Awaited<ReturnType<typeof getCaseHeader>>;

const TASK_ORDER: Record<string, number> = { REVIEW: 0, MISSING_INFORMATION: 1, RECOMMENDATION: 2, EXTERNAL_SUBMISSION: 3, OFFICER_TASK: 4 };
const PRIORITY_ORDER: Record<string, number> = { HIGH: 0, NORMAL: 1, LOW: 2 };

export function sortTasks<T extends { kind: string; priority: string; createdAt: Date }>(tasks: T[]): T[] {
  return [...tasks].sort(
    (a, b) => (PRIORITY_ORDER[a.priority] ?? 9) - (PRIORITY_ORDER[b.priority] ?? 9) || (TASK_ORDER[a.kind] ?? 9) - (TASK_ORDER[b.kind] ?? 9) || b.createdAt.getTime() - a.createdAt.getTime(),
  );
}

export async function getCaseOverview(db: Db, user: SessionUser, caseId: string) {
  await loadCaseForUser(db, user, caseId, "read");
  const [claims, holds, allocations, refunds, transactions, tasks, audit, requests, entities, locations, evidence, users] = await Promise.all([
    db.victimClaim.findMany({ where: { caseId }, include: { victim: true } }),
    db.hold.findMany({ where: { caseId }, include: { account: true } }),
    db.allocation.findMany({ where: { caseId } }),
    db.refund.findMany({ where: { caseId } }),
    db.transaction.findMany({ where: { caseId } }),
    db.task.findMany({ where: { caseId, status: { in: ["OPEN", "DRAFT_PREPARED", "WAITING", "BLOCKED"] } } }),
    db.auditEvent.findMany({ where: { caseId, NOT: [{ action: { startsWith: "task." } }, { action: "evidence.accessed" }] }, orderBy: { at: "desc" }, take: 8 }),
    db.request.findMany({ where: { caseId, status: { in: ["SUBMITTED", "ACKNOWLEDGED", "PARTIAL_RESPONSE", "AWAITING_APPROVAL", "APPROVED", "SUBMISSION_FAILED", "DRAFT"] } }, include: { recipient: true, versions: { orderBy: { versionNo: "desc" }, take: 1 }, responses: true } }),
    db.entity.findMany({ where: { caseId }, include: { partyRoles: true } }),
    db.locationObservation.count({ where: { caseId } }),
    db.evidenceItem.findMany({ where: { caseId }, select: { id: true, reviewStatus: true, derivation: true } }),
    db.user.findMany({ select: { id: true, displayName: true, rank: true } }),
  ]);
  const ledger = computeLedger({
    claims: claims.map((c) => ({ id: c.id, lossMinor: c.lossAmountMinor, status: c.status })),
    holds: holds.map((h) => ({ id: h.id, status: h.status, confirmedMinor: h.confirmedAmountMinor })),
    allocations: allocations.map((a) => ({ id: a.id, holdId: a.holdId, claimId: a.claimId, amountMinor: a.amountMinor, status: a.status })),
    refunds: refunds.map((r) => ({ id: r.id, claimId: r.claimId, amountMinor: r.amountMinor, status: r.status })),
    transactions: transactions.map((t) => ({ id: t.id, layer: t.layer, amountMinor: t.amountMinor, claimId: t.claimId, kind: t.kind })),
  });
  const asOfCandidates = [...holds.map((h) => h.confirmedAsOf), ...refunds.map((r) => r.creditConfirmedAt)].filter((d): d is Date => !!d);
  const name = (id: string | null) => {
    const u = users.find((x) => x.id === id);
    return u ? `${shortRank(u.rank)} ${u.displayName}` : "System";
  };
  const unknownHolds = holds.filter((h) => h.status !== "RELEASED" && h.confirmedAmountMinor === null).map((h) => h.account.label);
  const identifiers = entities.filter((e) => !["PERSON", "ORGANISATION", "CASH"].includes(e.kind));
  const people = entities.filter((e) => e.kind === "PERSON");
  // Priority first (a prepared debit-freeze draft is as urgent as an undrafted one); items waiting on a reply last.
  const openTasks = sortTasks(tasks).sort((a, b) => Number(a.status === "WAITING") - Number(b.status === "WAITING"));
  const awaiting = requests.filter((r) => ["SUBMITTED", "ACKNOWLEDGED", "PARTIAL_RESPONSE"].includes(r.status));
  const now = clockNow().getTime();
  return {
    ledger: {
      victimCount: claims.filter((c) => c.status === "ACTIVE").length,
      totalLossMinor: ledger.totalLossMinor.toString(),
      confirmedRefundsMinor: ledger.confirmedRefundsMinor.toString(),
      outstandingLossMinor: ledger.outstandingLossMinor.toString(),
      allocatedConfirmedMinor: ledger.allocatedConfirmedMinor.toString(),
      confirmedHeldMinor: ledger.confirmedHeldMinor.toString(),
      unallocatedHeldMinor: ledger.unallocatedHeldMinor?.toString() ?? null,
      neitherMinor: ledger.neitherReturnedNorSecuredMinor?.toString() ?? null,
      refundsInPipelineMinor: (ledger.refundPipeline.authorisedMinor + ledger.refundPipeline.initiatedMinor).toString(),
      reconciliation: ledger.reconciliation.status,
      issues: ledger.reconciliation.issues.map((i) => i.message),
      unknownHolds,
      competing: ledger.notes.some((n) => n.code === "COMPETING_PROPOSALS"),
      asOf: asOfCandidates.length ? new Date(Math.max(...asOfCandidates.map((d) => d.getTime()))).toISOString() : null,
    },
    investigation: {
      people: people.length,
      victims: people.filter((p) => p.partyRoles.some((r) => r.role === "VICTIM")).length,
      holdersOnRecord: people.filter((p) => p.partyRoles.some((r) => r.role === "ACCOUNT_HOLDER_ON_RECORD")).length,
      identifiers: identifiers.length,
      unverifiedIdentifiers: identifiers.filter((i) => i.verificationStatus === "UNVERIFIED").length,
      locations,
      identityActions: openTasks.filter((t) => t.objective === "IDENTITY").length,
      evidenceItems: evidence.filter((e) => e.derivation === "ORIGINAL").length,
      evidenceInReview: evidence.filter((e) => e.reviewStatus === "IN_REVIEW").length,
    },
    nextActions: openTasks.slice(0, 6).map((t) => ({
      id: t.id,
      kind: t.kind,
      objective: t.objective,
      title: t.title,
      question: t.question,
      status: t.status,
      priority: t.priority,
      requestId: t.requestId,
      responseId: t.responseId,
      requestCategory: t.requestCategory,
      ruleId: t.ruleId,
    })),
    openActionCount: openTasks.length,
    needActionCount: openTasks.filter((t) => t.status !== "WAITING").length,
    waitingCount: openTasks.filter((t) => t.status === "WAITING").length,
    recent: audit.map((a) => ({ id: a.id, at: a.at.toISOString(), summary: a.summary, actor: name(a.actorId), action: a.action })),
    awaiting: awaiting
      .sort((a, b) => (a.followUpAt?.getTime() ?? 0) - (b.followUpAt?.getTime() ?? 0))
      .map((r) => ({
        id: r.id,
        reference: r.reference,
        status: r.status,
        recipient: r.recipient.organisation,
        subject: r.versions[0]?.subject ?? "",
        submittedAt: r.submittedAt?.toISOString() ?? null,
        followUpAt: r.followUpAt?.toISOString() ?? null,
        followUpDue: !!r.followUpAt && r.followUpAt.getTime() < now,
        responsesToReview: r.responses.filter((x) => x.reviewStatus !== "APPLIED").length,
      })),
    draftsInProgress: requests.filter((r) => ["DRAFT", "AWAITING_APPROVAL", "APPROVED", "SUBMISSION_FAILED"].includes(r.status)).length,
  };
}
