import { shortRank } from "@/lib/cn";
import type { Db } from "../db";
import type { SessionUser } from "../auth/session";
import { loadCaseForUser } from "../auth/access";
import { notFoundError } from "../errors";
import { parseAttributes } from "./facts";

async function userNames(db: Db) {
  const users = await db.user.findMany({ select: { id: true, displayName: true, rank: true } });
  return (id: string | null) => {
    const u = users.find((x) => x.id === id);
    return u ? `${shortRank(u.rank)} ${u.displayName}` : "System";
  };
}

export async function listEvidence(db: Db, user: SessionUser, caseId: string, filters: { category?: string; derivation?: string; q?: string }) {
  await loadCaseForUser(db, user, caseId, "read");
  const q = filters.q?.trim();
  const items = await db.evidenceItem.findMany({
    where: {
      caseId,
      ...(filters.category ? { category: filters.category } : {}),
      ...(filters.derivation === "ORIGINAL" ? { derivation: "ORIGINAL" } : filters.derivation === "DERIVED" ? { derivation: { not: "ORIGINAL" } } : {}),
    },
    include: { parent: { select: { id: true, title: true } }, _count: { select: { assertions: true } } },
    orderBy: { receivedAt: "asc" },
  });
  const pending = await db.extractionCandidate.groupBy({ by: ["evidenceId"], where: { caseId, status: "PENDING" }, _count: true });
  const hits = q
    ? await db.evidenceSegment.findMany({ where: { caseId, text: { contains: q } }, include: { evidence: { select: { id: true, title: true } } }, take: 50, orderBy: [{ evidenceId: "asc" }, { page: "asc" }, { line: "asc" }, { row: "asc" }] })
    : [];
  return {
    items: items.map((e) => ({
      id: e.id,
      title: e.title,
      fileName: e.fileName,
      category: e.category,
      derivation: e.derivation,
      parentTitle: e.parent?.title ?? null,
      processingStatus: e.processingStatus,
      reviewStatus: e.reviewStatus,
      receivedAt: e.receivedAt.toISOString(),
      sizeBytes: e.sizeBytes,
      sha256: e.sha256,
      citedBy: e._count.assertions,
      pendingCandidates: pending.find((p) => p.evidenceId === e.id)?._count ?? 0,
      isSynthetic: e.isSynthetic,
    })),
    hits: hits.map((h) => ({ evidenceId: h.evidenceId, evidenceTitle: h.evidence.title, page: h.page, line: h.line, row: h.row, text: h.text })),
  };
}

export async function getEvidenceDetail(db: Db, user: SessionUser, evidenceId: string) {
  const ev = await db.evidenceItem.findUnique({
    where: { id: evidenceId },
    include: {
      parent: { select: { id: true, title: true, derivation: true } },
      derived: { select: { id: true, title: true, derivation: true, receivedAt: true } },
      events: { orderBy: { at: "asc" } },
      segments: { orderBy: [{ page: "asc" }, { line: "asc" }, { row: "asc" }] },
      runs: { orderBy: { createdAt: "desc" }, take: 1, include: { _count: { select: { candidates: true } } } },
      response: { select: { id: true, subject: true } },
    },
  });
  if (!ev) throw notFoundError("evidence item");
  await loadCaseForUser(db, user, ev.caseId, "read");
  const who = await userNames(db);
  const assertions = await db.sourceAssertion.findMany({ where: { evidenceId }, orderBy: [{ page: "asc" }, { line: "asc" }, { row: "asc" }] });
  const subjectLabels = await resolveSubjects(db, ev.caseId, assertions);
  const pending = await db.extractionCandidate.count({ where: { evidenceId, status: "PENDING" } });
  return {
    id: ev.id,
    caseId: ev.caseId,
    title: ev.title,
    fileName: ev.fileName,
    mimeType: ev.mimeType,
    category: ev.category,
    derivation: ev.derivation,
    parent: ev.parent,
    derived: ev.derived.map((d) => ({ ...d, receivedAt: d.receivedAt.toISOString() })),
    sizeBytes: ev.sizeBytes,
    sha256: ev.sha256,
    pageCount: ev.pageCount,
    sourceDescription: ev.sourceDescription,
    receivedAt: ev.receivedAt.toISOString(),
    uploadedAt: ev.uploadedAt.toISOString(),
    uploadedBy: who(ev.uploadedById),
    processingStatus: ev.processingStatus,
    processingNote: ev.processingNote,
    reviewStatus: ev.reviewStatus,
    isSynthetic: ev.isSynthetic,
    response: ev.response,
    events: ev.events.map((e) => ({ id: e.id, at: e.at.toISOString(), step: e.step, outcome: e.outcome, detail: e.detail, actor: e.actorId ? who(e.actorId) : null })),
    segments: ev.segments.map((s) => ({ page: s.page, line: s.line, row: s.row, text: s.text, method: s.method })),
    lastRun: ev.runs[0] ? { status: ev.runs[0].status, note: ev.runs[0].note, candidates: ev.runs[0]._count.candidates, at: ev.runs[0].createdAt.toISOString() } : null,
    pendingCandidates: pending,
    citations: assertions.map((a) => ({ id: a.id, locator: a.locator, excerpt: a.excerpt, stance: a.stance, subjectType: a.subjectType, subject: subjectLabels.get(`${a.subjectType}:${a.subjectId}`) ?? a.subjectType.toLowerCase() })),
  };
}

export type EvidenceDetail = Awaited<ReturnType<typeof getEvidenceDetail>>;

async function resolveSubjects(db: Db, caseId: string, assertions: { subjectType: string; subjectId: string }[]) {
  const map = new Map<string, string>();
  const ids = (t: string) => [...new Set(assertions.filter((a) => a.subjectType === t).map((a) => a.subjectId))];
  const [entities, txns, rels, holds, locs, tasks] = await Promise.all([
    db.entity.findMany({ where: { caseId, id: { in: ids("ENTITY") } }, select: { id: true, label: true } }),
    db.transaction.findMany({ where: { caseId, id: { in: ids("TRANSACTION") } }, include: { fromEntity: true, toEntity: true } }),
    db.relationship.findMany({ where: { caseId, id: { in: ids("RELATIONSHIP") } }, select: { id: true, statement: true } }),
    db.hold.findMany({ where: { caseId, id: { in: ids("HOLD") } }, include: { account: true } }),
    db.locationObservation.findMany({ where: { caseId, id: { in: ids("LOCATION") } }, select: { id: true, description: true } }),
    db.task.findMany({ where: { caseId, id: { in: ids("TASK") } }, select: { id: true, title: true } }),
  ]);
  entities.forEach((e) => map.set(`ENTITY:${e.id}`, e.label));
  txns.forEach((t) => map.set(`TRANSACTION:${t.id}`, `Transfer ${t.fromEntity.label} to ${t.toEntity.label}`));
  rels.forEach((r) => map.set(`RELATIONSHIP:${r.id}`, r.statement));
  holds.forEach((h) => map.set(`HOLD:${h.id}`, `Hold on ${h.account.label}`));
  locs.forEach((l) => map.set(`LOCATION:${l.id}`, l.description));
  tasks.forEach((t) => map.set(`TASK:${t.id}`, `Next action: ${t.title}`));
  return map;
}

export async function getExtractionReview(db: Db, user: SessionUser, evidenceId: string) {
  const detail = await getEvidenceDetail(db, user, evidenceId);
  const candidates = await db.extractionCandidate.findMany({ where: { evidenceId }, orderBy: [{ page: "asc" }, { line: "asc" }, { row: "asc" }, { charStart: "asc" }] });
  const entities = await db.entity.findMany({ where: { caseId: detail.caseId }, select: { id: true, kind: true, label: true, value: true, normalizedValue: true, attributesJson: true } });
  const claims = await db.victimClaim.findMany({ where: { caseId: detail.caseId }, include: { victim: true } });
  const who = await userNames(db);
  const kindFor: Record<string, string> = { PHONE: "PHONE", EMAIL: "EMAIL", UPI_ID: "UPI_ID", WEBSITE: "WEBSITE", IP_ADDRESS: "IP_ADDRESS", BANK_ACCOUNT: "BANK_ACCOUNT", PLATFORM_PROFILE: "PLATFORM_PROFILE", PERSON_NAME: "PERSON" };
  return {
    ...detail,
    candidates: candidates.map((c) => {
      const kind = kindFor[c.field];
      const structured = c.structuredJson ? (JSON.parse(c.structuredJson) as Record<string, unknown>) : null;
      return {
        id: c.id,
        field: c.field,
        originalValue: c.originalValue,
        correctedValue: c.correctedValue,
        structured,
        officerLabel: typeof structured?.officerLabel === "string" ? structured.officerLabel : null,
        roleHint: c.roleHint,
        roleHintBasis: c.roleHintBasis,
        uncertainty: c.uncertainty,
        uncertaintyNote: c.uncertaintyNote,
        page: c.page,
        line: c.line,
        row: c.row,
        charStart: c.charStart,
        charEnd: c.charEnd,
        excerpt: c.excerpt,
        status: c.status,
        rejectReason: c.rejectReason,
        linkedEntityId: c.linkedEntityId,
        applied: !!c.appliedAt,
        reviewedBy: c.reviewedById ? who(c.reviewedById) : null,
        // Cautious linking: exact normalised identifier matches only; people are listed but never suggested.
        exactMatches: kind && kind !== "PERSON" ? entities.filter((e) => e.kind === kind && e.normalizedValue === c.normalizedValue).map((e) => ({ id: e.id, label: e.label })) : [],
        linkOptions: kind ? entities.filter((e) => e.kind === kind).map((e) => ({ id: e.id, label: e.kind === "PERSON" ? e.label : `${e.label} (${e.value})` })) : [],
      };
    }),
    accounts: entities.filter((e) => e.kind === "BANK_ACCOUNT").map((e) => ({ id: e.id, label: `${e.label} (${e.value})`, bank: (parseAttributes(e.attributesJson).bank as string | undefined) ?? null })),
    claims: claims.map((c) => ({ id: c.id, label: c.victim.label })),
  };
}

export type ExtractionReviewData = Awaited<ReturnType<typeof getExtractionReview>>;
