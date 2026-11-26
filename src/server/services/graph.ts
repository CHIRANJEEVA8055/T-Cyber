import { isVictimOwned } from "@/domain/providers";
import type { GraphData, GraphHoldSummary, GraphProvenance, GraphSource } from "@/contracts/graph";
import { isDateOnlyObservation } from "@/domain/time";
import type { Db } from "../db";
import type { SessionUser } from "../auth/session";
import { loadCaseForUser } from "../auth/access";
import { recordAudit } from "../audit";
import { now } from "../clock";
import { parseAttributes } from "./facts";

const ENTITY_REF_KEYS = ["counterpartyId", "personId", "entityId"] as const;

function parseRefs(json: string | null): Record<string, unknown> {
  if (!json) return {};
  try {
    const v = JSON.parse(json) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * The graph is a view over the canonical records; it never stores facts of its own.
 * Money edges come from transactions; identity edges from relationships with their exact statements.
 * Provenance is exact: a record was learned from an applied response finding or a reviewed document
 * field when that apply step created it (same transaction timestamp), never by guesswork.
 */
export async function getGraphData(db: Db, user: SessionUser, caseId: string): Promise<GraphData> {
  await loadCaseForUser(db, user, caseId, "read");
  const [entities, transactions, relationships, marker, sources, tasks, requests, locations, findings, candidates, holds, evidence] = await Promise.all([
    db.entity.findMany({ where: { caseId }, include: { partyRoles: true } }),
    db.transaction.findMany({ where: { caseId }, orderBy: { occurredAt: "asc" } }),
    db.relationship.findMany({ where: { caseId } }),
    db.reviewMarker.findUnique({ where: { caseId_userId_scope: { caseId, userId: user.id, scope: "GRAPH" } } }),
    db.sourceAssertion.findMany({ where: { caseId, subjectType: { in: ["ENTITY", "TRANSACTION", "RELATIONSHIP"] } }, include: { evidence: { select: { title: true } } } }),
    db.task.findMany({ where: { caseId, status: { in: ["OPEN", "DRAFT_PREPARED", "WAITING", "BLOCKED"] } }, select: { id: true, title: true, subjectEntityIdsJson: true, status: true } }),
    db.request.findMany({ where: { caseId, status: { not: "DISCARDED" } }, include: { subjects: true }, orderBy: { reference: "asc" } }),
    db.locationObservation.findMany({ where: { caseId }, orderBy: { eventAt: "asc" } }),
    db.responseFinding.findMany({
      where: { caseId, appliedAt: { not: null } },
      orderBy: { appliedAt: "asc" },
      select: {
        findingType: true,
        summary: true,
        appliedAt: true,
        appliedRefJson: true,
        response: { select: { id: true, request: { select: { id: true, reference: true, recipient: { select: { organisation: true } }, subjects: { select: { entityId: true } } } } } },
      },
    }),
    db.extractionCandidate.findMany({ where: { caseId, appliedAt: { not: null } }, orderBy: { appliedAt: "asc" }, select: { evidenceId: true, appliedAt: true, appliedRefJson: true } }),
    db.hold.findMany({ where: { caseId } }),
    db.evidenceItem.findMany({ where: { caseId }, select: { id: true, title: true } }),
  ]);

  const reviewedAt = marker?.reviewedAt ?? null;
  const isNew = (d: Date) => !!reviewedAt && d > reviewedAt;
  const src = (type: string, id: string): GraphSource[] =>
    sources.filter((s) => s.subjectType === type && s.subjectId === id).map((s) => ({ evidenceId: s.evidenceId, evidenceTitle: s.evidence.title, locator: s.locator, excerpt: s.excerpt, stance: s.stance }));

  // --- Provenance: which apply step created each record ---------------------------------------
  const entityAt = new Map(entities.map((e) => [e.id, e.discoveredAt.getTime()]));
  const txAt = new Map(transactions.map((t) => [t.id, t.discoveredAt.getTime()]));
  const relAt = new Map(relationships.map((r) => [r.id, r.discoveredAt.getTime()]));
  const learned = { entity: new Map<string, GraphProvenance>(), transaction: new Map<string, GraphProvenance>(), relationship: new Map<string, GraphProvenance>() };
  const claim = (map: Map<string, GraphProvenance>, at: Map<string, number>, id: unknown, appliedAt: Date, prov: GraphProvenance) => {
    if (typeof id === "string" && at.get(id) === appliedAt.getTime() && !map.has(id)) map.set(id, prov);
  };
  for (const f of findings) {
    if (!f.appliedAt) continue;
    const refs = parseRefs(f.appliedRefJson);
    const req = f.response.request;
    const prov: GraphProvenance = {
      kind: "RESPONSE",
      responseId: f.response.id,
      requestId: req?.id ?? null,
      requestReference: req?.reference ?? null,
      organisation: req?.recipient.organisation ?? null,
      appliedAt: f.appliedAt.toISOString(),
      findingType: f.findingType,
      findingSummary: f.summary,
      leadEntityIds: req?.subjects.map((s) => s.entityId) ?? [],
    };
    for (const k of ENTITY_REF_KEYS) claim(learned.entity, entityAt, refs[k], f.appliedAt, prov);
    claim(learned.transaction, txAt, refs.transactionId, f.appliedAt, prov);
    claim(learned.relationship, relAt, refs.relationshipId, f.appliedAt, prov);
  }
  const evidenceTitle = new Map(evidence.map((e) => [e.id, e.title]));
  for (const c of candidates) {
    if (!c.appliedAt) continue;
    const refs = parseRefs(c.appliedRefJson);
    const prov: GraphProvenance = { kind: "DOCUMENT", evidenceId: c.evidenceId, evidenceTitle: evidenceTitle.get(c.evidenceId) ?? "Document", appliedAt: c.appliedAt.toISOString() };
    for (const k of ENTITY_REF_KEYS) claim(learned.entity, entityAt, refs[k], c.appliedAt, prov);
    claim(learned.transaction, txAt, refs.transactionId, c.appliedAt, prov);
  }
  // A payment row creates its beneficiary in the same step; the beneficiary shares the row's provenance.
  for (const t of transactions) {
    const prov = learned.transaction.get(t.id);
    if (prov) claim(learned.entity, entityAt, t.toEntityId, new Date(prov.appliedAt), prov);
  }

  // --- Transfer depth -------------------------------------------------------------------------
  const victimAccounts = new Set(transactions.filter((t) => t.kind === "VICTIM_PAYMENT").map((t) => t.fromEntityId));
  const layerOf = new Map<string, number>();
  for (const id of victimAccounts) layerOf.set(id, 0);
  for (const t of transactions) if (!victimAccounts.has(t.toEntityId)) layerOf.set(t.toEntityId, Math.min(layerOf.get(t.toEntityId) ?? Number.MAX_SAFE_INTEGER, t.layer));

  // --- Holds ----------------------------------------------------------------------------------
  const holdOf = new Map<string, GraphHoldSummary>();
  for (const h of holds) {
    if (h.status === "RELEASED") continue;
    const cur = holdOf.get(h.accountEntityId) ?? { heldMinor: null, amountUnknown: false, requested: false };
    if (h.status === "REQUESTED") cur.requested = true;
    else if (h.status === "CONFIRMED_HELD" && h.confirmedAmountMinor !== null) cur.heldMinor = (BigInt(cur.heldMinor ?? "0") + h.confirmedAmountMinor).toString();
    else cur.amountUnknown = true;
    holdOf.set(h.accountEntityId, cur);
  }

  // --- Discovery phases, labelled by the step that produced them ------------------------------
  const maxPhase = Math.max(0, ...entities.map((e) => e.discoveryPhase), ...transactions.map((t) => t.discoveryPhase), ...relationships.map((r) => r.discoveryPhase));
  const phases = [{ phase: 0, title: "Intake", detail: "FIR and complainant documents" }];
  for (let p = 1; p <= maxPhase; p++) {
    const prov =
      entities.filter((e) => e.discoveryPhase === p).map((e) => learned.entity.get(e.id)).find(Boolean) ??
      transactions.filter((t) => t.discoveryPhase === p).map((t) => learned.transaction.get(t.id)).find(Boolean) ??
      relationships.filter((r) => r.discoveryPhase === p).map((r) => learned.relationship.get(r.id)).find(Boolean);
    // Without an applied response or extraction, name the document the officer cited, if any.
    const cited = !prov
      ? [
          ...entities.filter((e) => e.discoveryPhase === p).flatMap((e) => src("ENTITY", e.id)),
          ...transactions.filter((t) => t.discoveryPhase === p).flatMap((t) => src("TRANSACTION", t.id)),
          ...relationships.filter((r) => r.discoveryPhase === p).flatMap((r) => src("RELATIONSHIP", r.id)),
        ][0]
      : undefined;
    const detail = !prov
      ? cited
        ? `Recorded by an officer from ${cited.evidenceTitle}`
        : "Recorded by an officer"
      : prov.kind === "RESPONSE"
        ? `${prov.organisation ?? "Provider"} response${prov.requestReference ? ` to ${prov.requestReference}` : ""}`
        : prov.evidenceTitle;
    phases.push({ phase: p, title: `Phase ${p}`, detail });
  }

  return {
    reviewedAt: reviewedAt?.toISOString() ?? null,
    phases,
    nodes: entities.map((e) => ({
      id: e.id,
      kind: e.kind,
      label: e.label,
      value: e.value,
      bank: (parseAttributes(e.attributesJson).bank as string | undefined) ?? null,
      caseRole: e.caseRole,
      roles: e.partyRoles.map((r) => r.role),
      verification: e.verificationStatus,
      discoveryPhase: e.discoveryPhase,
      discoveredAt: e.discoveredAt.toISOString(),
      layer: layerOf.get(e.id) ?? null,
      isVictimAccount: victimAccounts.has(e.id),
      victimSide: victimAccounts.has(e.id) || isVictimOwned({ caseRole: e.caseRole, attributes: parseAttributes(e.attributesJson), belongsTo: e.belongsTo }) || (e.kind === "PERSON" && e.partyRoles.some((r) => r.role === "VICTIM" || r.role === "COMPLAINANT")),
      isNew: isNew(e.discoveredAt),
      hold: holdOf.get(e.id) ?? null,
      learnedFrom: learned.entity.get(e.id) ?? null,
      sources: src("ENTITY", e.id),
      openActions: tasks.filter((t) => (JSON.parse(t.subjectEntityIdsJson) as string[]).includes(e.id)).map((t) => ({ id: t.id, title: t.title, status: t.status })),
      requests: requests.filter((r) => r.subjects.some((s) => s.entityId === e.id)).map((r) => ({ id: r.id, reference: r.reference, status: r.status })),
    })),
    moneyEdges: transactions.map((t) => ({
      id: t.id,
      source: t.fromEntityId,
      target: t.toEntityId,
      amountMinor: t.amountMinor.toString(),
      occurredAt: t.occurredAt.toISOString(),
      channel: t.channel,
      reference: t.reference,
      layer: t.layer,
      kind: t.kind,
      status: t.status,
      discoveredAt: t.discoveredAt.toISOString(),
      discoveryPhase: t.discoveryPhase,
      isNew: isNew(t.discoveredAt),
      learnedFrom: learned.transaction.get(t.id) ?? null,
      sources: src("TRANSACTION", t.id),
    })),
    identityEdges: relationships.map((r) => ({
      id: r.id,
      source: r.fromEntityId,
      target: r.toEntityId,
      type: r.type,
      statement: r.statement,
      status: r.status,
      discoveredAt: r.discoveredAt.toISOString(),
      discoveryPhase: r.discoveryPhase,
      isNew: isNew(r.discoveredAt),
      learnedFrom: learned.relationship.get(r.id) ?? null,
      sources: src("RELATIONSHIP", r.id),
    })),
    locations: locations.map((l) => ({
      id: l.id,
      entityId: l.entityId,
      description: l.description,
      eventAt: l.eventAt?.toISOString() ?? null,
      eventAtNote: l.eventAtNote,
      eventDateOnly: isDateOnlyObservation(l.observationType),
      receivedAt: l.receivedAt.toISOString(),
    })),
  };
}

export async function markGraphReviewed(db: Db, user: SessionUser, caseId: string) {
  return db.$transaction(async (tx) => {
    await loadCaseForUser(tx, user, caseId, "read");
    const at = now();
    await tx.reviewMarker.upsert({ where: { caseId_userId_scope: { caseId, userId: user.id, scope: "GRAPH" } }, create: { caseId, userId: user.id, scope: "GRAPH", reviewedAt: at }, update: { reviewedAt: at } });
    await recordAudit(tx, { caseId, actorId: user.id, action: "graph.reviewed", objectType: "Case", objectId: caseId, summary: "Graph marked as reviewed; later changes will be highlighted as new" });
  });
}
