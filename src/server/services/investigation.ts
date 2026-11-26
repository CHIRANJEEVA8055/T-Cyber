import { shortRank } from "@/lib/cn";
import type { Db } from "../db";
import type { SessionUser } from "../auth/session";
import { loadCaseForUser } from "../auth/access";
import { recordAudit } from "../audit";
import { now } from "../clock";
import { AppError, notFoundError } from "../errors";
import { parseAttributes } from "./facts";
import { sortTasks } from "./overview";

export const RELATIONSHIP_TYPES = ["REGISTERED_TO", "USED_BY", "CONTROLLED_BY", "POTENTIALLY_ASSOCIATED_WITH", "LINKED_IDENTIFIER", "CONTACTED"] as const;

type SourceRow = { subjectType: string; subjectId: string; evidenceId: string; locator: string; excerpt: string; stance: string; evidence: { title: string } };

async function context(db: Db, user: SessionUser, caseId: string) {
  await loadCaseForUser(db, user, caseId, "read");
  const users = await db.user.findMany({ select: { id: true, displayName: true, rank: true } });
  const who = (id: string | null) => {
    const u = users.find((x) => x.id === id);
    return u ? `${shortRank(u.rank)} ${u.displayName}` : null;
  };
  const sources = (await db.sourceAssertion.findMany({ where: { caseId }, include: { evidence: { select: { title: true } } } })) as SourceRow[];
  const sourcesFor = (type: string, id: string) =>
    sources.filter((s) => s.subjectType === type && s.subjectId === id).map((s) => ({ evidenceId: s.evidenceId, evidenceTitle: s.evidence.title, locator: s.locator, excerpt: s.excerpt, stance: s.stance }));
  return { who, sourcesFor };
}

export async function listTasks(db: Db, user: SessionUser, caseId: string, filters: { status?: string; objective?: string }) {
  const { who, sourcesFor } = await context(db, user, caseId);
  const active = ["OPEN", "DRAFT_PREPARED", "WAITING", "BLOCKED", "DEFERRED"];
  const closed = ["COMPLETED", "SUPERSEDED", "DISMISSED"];
  const statuses = filters.status === "closed" ? closed : filters.status === "all" ? [...active, ...closed] : active;
  const tasks = await db.task.findMany({ where: { caseId, status: { in: statuses }, ...(filters.objective ? { objective: filters.objective } : {}) } });
  const kase = await db.case.findUniqueOrThrow({ where: { id: caseId }, include: { assignments: { include: { user: true } } } });
  const supervisors = await db.user.findMany({ where: { stationId: kase.stationId, role: "SUPERVISOR", active: true } });
  const assignable = [...kase.assignments.map((a) => a.user), ...supervisors].filter((u, i, all) => all.findIndex((x) => x.id === u.id) === i);
  const requests = await db.request.findMany({ where: { caseId, status: { not: "DISCARDED" } }, select: { id: true, reference: true, status: true } });
  const evidence = await db.evidenceItem.findMany({ where: { caseId, derivation: "ORIGINAL" }, select: { id: true, title: true } });
  const order: Record<string, number> = { OPEN: 0, DRAFT_PREPARED: 1, WAITING: 2, DEFERRED: 3, COMPLETED: 4, SUPERSEDED: 5, DISMISSED: 6 };
  return {
    tasks: sortTasks(tasks)
      .sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9))
      .map((t) => ({
        id: t.id,
        version: t.version,
        kind: t.kind,
        objective: t.objective,
        title: t.title,
        question: t.question,
        purpose: t.purpose,
        relevance: t.relevance,
        recipientHint: t.recipientHint,
        requestCategory: t.requestCategory,
        scope: t.scope,
        periodFrom: t.periodFrom?.toISOString() ?? null,
        periodTo: t.periodTo?.toISOString() ?? null,
        prerequisites: JSON.parse(t.prerequisitesJson) as { label: string; met: boolean; basis: string }[],
        expectedClarification: t.expectedClarification,
        priority: t.priority,
        priorityReason: t.priorityReason,
        status: t.status,
        statusReason: t.statusReason,
        assignee: who(t.assigneeId),
        assigneeId: t.assigneeId,
        dueAt: t.dueAt?.toISOString() ?? null,
        deferredUntil: t.deferredUntil?.toISOString() ?? null,
        requestId: t.requestId,
        request: requests.find((r) => r.id === t.requestId) ?? null,
        responseId: t.responseId,
        ruleId: t.ruleId,
        generatedBy: t.generatedBy,
        completionNote: t.completionNote,
        createdAt: t.createdAt.toISOString(),
        sources: sourcesFor("TASK", t.id),
      })),
    assignable: assignable.map((u) => ({ id: u.id, label: `${shortRank(u.rank)} ${u.displayName}` })),
    evidence,
  };
}

export type TaskListData = Awaited<ReturnType<typeof listTasks>>;

export async function listPeopleAndIdentifiers(db: Db, user: SessionUser, caseId: string) {
  const { sourcesFor } = await context(db, user, caseId);
  const [entities, relationships, claims, requests, locations] = await Promise.all([
    db.entity.findMany({ where: { caseId }, include: { partyRoles: true }, orderBy: [{ discoveryPhase: "asc" }, { discoveredAt: "asc" }] }),
    db.relationship.findMany({ where: { caseId } }),
    db.victimClaim.findMany({ where: { caseId } }),
    db.request.findMany({ where: { caseId, status: { not: "DISCARDED" } }, include: { subjects: true }, orderBy: { reference: "asc" } }),
    db.locationObservation.findMany({ where: { caseId }, orderBy: [{ eventAt: "asc" }] }),
  ]);
  const label = new Map(entities.map((e) => [e.id, e.label]));
  const rels = (id: string) =>
    relationships
      .filter((r) => r.fromEntityId === id || r.toEntityId === id)
      .map((r) => ({ id: r.id, type: r.type, statement: r.statement, status: r.status, other: label.get(r.fromEntityId === id ? r.toEntityId : r.fromEntityId) ?? "Unknown", otherId: r.fromEntityId === id ? r.toEntityId : r.fromEntityId, sources: sourcesFor("RELATIONSHIP", r.id) }));
  const shape = (e: (typeof entities)[number]) => ({
    id: e.id,
    kind: e.kind,
    label: e.label,
    value: e.value,
    caseRole: e.caseRole,
    attributes: parseAttributes(e.attributesJson),
    verificationStatus: e.verificationStatus,
    verificationNote: e.verificationNote,
    isMasked: e.isMasked,
    discoveredAt: e.discoveredAt.toISOString(),
    discoveryPhase: e.discoveryPhase,
    roles: e.partyRoles.map((r) => ({ role: r.role, basis: r.basis })),
    lossMinor: claims.find((c) => c.victimEntityId === e.id)?.lossAmountMinor.toString() ?? null,
    relationships: rels(e.id),
    requests: requests.filter((r) => r.subjects.some((s) => s.entityId === e.id)).map((r) => ({ id: r.id, reference: r.reference, status: r.status, category: r.category })),
    sources: sourcesFor("ENTITY", e.id),
  });
  return {
    people: entities.filter((e) => e.kind === "PERSON" || e.kind === "ORGANISATION").map(shape),
    identifiers: entities.filter((e) => !["PERSON", "ORGANISATION"].includes(e.kind)).map(shape),
    locations: locations.map((l) => ({
      id: l.id,
      entityId: l.entityId,
      entityLabel: l.entityId ? (label.get(l.entityId) ?? null) : null,
      observationType: l.observationType,
      description: l.description,
      locationText: l.locationText,
      precision: l.precision,
      eventAt: l.eventAt?.toISOString() ?? null,
      eventAtNote: l.eventAtNote,
      receivedAt: l.receivedAt.toISOString(),
      corroboration: l.corroboration,
      corroborationNote: l.corroborationNote,
      limitations: l.limitations,
      sources: sourcesFor("LOCATION", l.id),
    })),
    entityOptions: entities.map((e) => ({ id: e.id, label: `${e.label}${e.kind === "PERSON" ? "" : ` (${e.value})`}`, kind: e.kind })),
  };
}

export type PeopleData = Awaited<ReturnType<typeof listPeopleAndIdentifiers>>;

export async function setEntityVerification(db: Db, user: SessionUser, entityId: string, input: { status: "UNVERIFIED" | "CORROBORATED" | "DISPUTED"; note: string }) {
  return db.$transaction(async (tx) => {
    const e = await tx.entity.findUnique({ where: { id: entityId } });
    if (!e) throw notFoundError("record");
    await loadCaseForUser(tx, user, e.caseId, "write");
    if (!["UNVERIFIED", "CORROBORATED", "DISPUTED"].includes(input.status)) throw new AppError("Choose a verification status.", "VALIDATION", { status: "Choose a status." });
    if (input.note.trim().length < 5) throw new AppError("Add a note explaining the basis for this decision.", "VALIDATION", { note: "Add a note explaining the basis (at least 5 characters)." });
    await tx.entity.update({ where: { id: entityId }, data: { verificationStatus: input.status, verificationNote: input.note.trim() } });
    await recordAudit(tx, { caseId: e.caseId, actorId: user.id, action: "entity.verification_changed", objectType: "Entity", objectId: entityId, summary: `${e.label}: verification changed from ${e.verificationStatus.toLowerCase()} to ${input.status.toLowerCase()}`, detail: { note: input.note } });
  });
}

export async function addRelationship(
  db: Db,
  user: SessionUser,
  caseId: string,
  input: { fromEntityId: string; toEntityId: string; type: string; statement: string; evidenceId?: string | null; locator?: string | null; excerpt?: string | null },
) {
  return db.$transaction(async (tx) => {
    await loadCaseForUser(tx, user, caseId, "write");
    if (!(RELATIONSHIP_TYPES as readonly string[]).includes(input.type)) throw new AppError("Choose a relationship type from the list.", "VALIDATION", { type: "Choose a relationship type." });
    if (input.fromEntityId === input.toEntityId) throw new AppError("A record cannot be related to itself.", "VALIDATION", { toEntityId: "Choose a different record." });
    const [from, to] = await Promise.all([tx.entity.findUnique({ where: { id: input.fromEntityId } }), tx.entity.findUnique({ where: { id: input.toEntityId } })]);
    if (!from || !to || from.caseId !== caseId || to.caseId !== caseId) throw new AppError("Choose records from this case.", "VALIDATION", { toEntityId: "Choose a record from this case." });
    if (input.statement.trim().length < 10) throw new AppError("Describe exactly what the source shows.", "VALIDATION", { statement: "Describe what the source shows (at least 10 characters)." });
    const at = now();
    const rel = await tx.relationship.create({
      data: { caseId, fromEntityId: from.id, toEntityId: to.id, type: input.type, statement: input.statement.trim(), discoveredAt: at, discoveryPhase: Math.max(from.discoveryPhase, to.discoveryPhase), dedupeKey: `${input.type}:${from.id}:${to.id}:${at.getTime()}`, createdAt: at },
    });
    if (input.evidenceId) {
      const ev = await tx.evidenceItem.findUnique({ where: { id: input.evidenceId } });
      if (!ev || ev.caseId !== caseId) throw new AppError("Choose evidence from this case.", "VALIDATION", { evidenceId: "Choose evidence from this case." });
      const locator = input.locator?.trim() || "document";
      await tx.sourceAssertion.create({ data: { caseId, evidenceId: ev.id, locator, excerpt: input.excerpt?.trim() || input.statement.trim(), subjectType: "RELATIONSHIP", subjectId: rel.id, stance: "SUPPORTS", dedupeKey: `RELATIONSHIP:${rel.id}:${ev.id}:${locator}:SUPPORTS`, createdById: user.id, createdAt: at } });
    }
    await recordAudit(tx, { caseId, actorId: user.id, action: "relationship.recorded", objectType: "Relationship", objectId: rel.id, summary: `Relationship recorded: ${input.statement.trim()}` });
    return rel;
  });
}

export async function setLocationCorroboration(db: Db, user: SessionUser, locationId: string, input: { corroboration: "UNCORROBORATED" | "CORROBORATED" | "CONTRADICTED"; note: string }) {
  return db.$transaction(async (tx) => {
    const l = await tx.locationObservation.findUnique({ where: { id: locationId } });
    if (!l) throw notFoundError("location observation");
    await loadCaseForUser(tx, user, l.caseId, "write");
    if (input.note.trim().length < 1) throw new AppError("Add a note explaining the basis.", "VALIDATION", { note: "Add a note." });
    await tx.locationObservation.update({ where: { id: locationId }, data: { corroboration: input.corroboration, corroborationNote: input.note.trim() } });
    await recordAudit(tx, { caseId: l.caseId, actorId: user.id, action: "location.corroboration_changed", objectType: "LocationObservation", objectId: locationId, summary: `Location observation "${l.description}" marked ${input.corroboration.toLowerCase()}`, detail: { note: input.note } });
  });
}
