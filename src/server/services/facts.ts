import type { RecoFacts } from "@/domain/recommendations";
import type { Db, Tx } from "../db";
import { now as clockNow } from "../clock";

export function parseAttributes(json: string): Record<string, unknown> {
  try {
    const v = JSON.parse(json) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Snapshot of the canonical case records used by the next-action engine. */
export async function loadRecoFacts(db: Db | Tx, caseId: string, now = clockNow()): Promise<RecoFacts> {
  const [kase, entities, transactions, holds, allocations, refunds, requests, responses, relationships, locations, sources, claims, decisions] = await Promise.all([
    db.case.findUnique({ where: { id: caseId }, select: { isDemo: true } }),
    db.entity.findMany({ where: { caseId } }),
    db.transaction.findMany({ where: { caseId } }),
    db.hold.findMany({ where: { caseId } }),
    db.allocation.findMany({ where: { caseId } }),
    db.refund.findMany({ where: { caseId } }),
    db.request.findMany({ where: { caseId, status: { not: "DISCARDED" } }, include: { recipient: true, subjects: true, items: true } }),
    db.response.findMany({ where: { caseId }, include: { request: { include: { recipient: true } } } }),
    db.relationship.findMany({ where: { caseId } }),
    db.locationObservation.findMany({ where: { caseId } }),
    db.sourceAssertion.findMany({ where: { caseId, stance: { in: ["SUPPORTS", "MENTIONS"] } } }),
    db.victimClaim.findMany({ where: { caseId } }),
    db.allocationDecision.findMany({ where: { caseId }, orderBy: { decidedAt: "asc" } }),
  ]);

  const victimAccountIds = new Set<string>();
  for (const t of transactions) if (t.kind === "VICTIM_PAYMENT") victimAccountIds.add(t.fromEntityId);
  for (const e of entities) if (parseAttributes(e.attributesJson).isVictimAccount === true) victimAccountIds.add(e.id);

  return {
    now,
    isDemo: kase?.isDemo ?? true,
    entities: entities.map((e) => ({
      id: e.id,
      kind: e.kind,
      label: e.label,
      value: e.value,
      attributes: parseAttributes(e.attributesJson) as RecoFacts["entities"][number]["attributes"],
      caseRole: e.caseRole,
      belongsTo: e.belongsTo,
    })),
    victimAccountIds: [...victimAccountIds],
    transactions: transactions.map((t) => ({
      id: t.id,
      fromEntityId: t.fromEntityId,
      toEntityId: t.toEntityId,
      amountMinor: t.amountMinor,
      layer: t.layer,
      kind: t.kind,
      occurredAt: t.occurredAt,
      reference: t.reference,
    })),
    holds: holds.map((h) => ({ id: h.id, accountEntityId: h.accountEntityId, status: h.status, confirmedMinor: h.confirmedAmountMinor })),
    allocations: allocations.map((a) => ({ holdId: a.holdId, amountMinor: a.amountMinor, status: a.status })),
    refunds: refunds.map((r) => ({ holdId: r.holdId, status: r.status })),
    requests: requests.map((r) => ({
      id: r.id,
      reference: r.reference,
      category: r.category,
      status: r.status,
      recipientName: r.recipient.organisation,
      subjectEntityIds: r.subjects.map((s) => s.entityId),
      items: r.items.map((i) => ({ itemType: i.itemType, status: i.status })),
      followUpAt: r.followUpAt,
      parentRequestId: r.parentRequestId,
    })),
    responses: responses.map((r) => ({
      id: r.id,
      requestId: r.requestId,
      requestReference: r.request?.reference ?? null,
      recipientName: r.request?.recipient.organisation ?? r.fromAddress,
      reviewStatus: r.reviewStatus,
      matchStatus: r.matchStatus,
    })),
    relationships: relationships.map((r) => ({ id: r.id, fromEntityId: r.fromEntityId, toEntityId: r.toEntityId, type: r.type, statement: r.statement })),
    locations: locations.map((l) => {
      // The ATM ID, once known, is the reference on the cash withdrawal recorded at that moment.
      const cash = l.observationType === "ATM_WITHDRAWAL" && l.eventAt
        ? transactions.find((t) => t.kind === "CASH_WITHDRAWAL" && t.fromEntityId === l.entityId && t.occurredAt.getTime() === l.eventAt!.getTime())
        : undefined;
      return { id: l.id, entityId: l.entityId, observationType: l.observationType, limitations: l.limitations, locationText: l.locationText, eventAt: l.eventAt, atmId: cash?.reference ?? null, description: l.description };
    }),
    claims: claims.map((c) => ({ id: c.id, victimEntityId: c.victimEntityId, lossMinor: c.lossAmountMinor })),
    allocationDecisions: decisions.map((d) => ({ method: d.method, decidedAt: d.decidedAt })),
    sources: sources.map((s) => ({ subjectType: s.subjectType, subjectId: s.subjectId, evidenceId: s.evidenceId, locator: s.locator, excerpt: s.excerpt })),
  };
}
