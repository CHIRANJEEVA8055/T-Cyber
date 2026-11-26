import { IDENTIFIER_KIND_LABELS } from "@/contracts/case";
import { evidenceHref } from "@/lib/evidence-href";
import type { Db } from "../db";
import type { SessionUser } from "../auth/session";
import { accessibleCaseIds, assertCaseWorker } from "../auth/access";
import { caseReference } from "./cases";

/** Text around the first match, with the match itself kept separate so the page can mark it. */
function excerpt(text: string, query: string) {
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return { before: text.slice(0, 140), match: "", after: "" };
  const start = Math.max(0, at - 70);
  const end = Math.min(text.length, at + query.length + 70);
  return { before: `${start > 0 ? "…" : ""}${text.slice(start, at)}`, match: text.slice(at, at + query.length), after: `${text.slice(at + query.length, end)}${end < text.length ? "…" : ""}` };
}

/**
 * Search across the cases this officer may open, and nothing else: case details, recorded identifiers and
 * people, the text of stored documents, and requests.
 */
export async function searchRecords(db: Db, user: SessionUser, raw: string) {
  assertCaseWorker(user);
  const q = raw.trim().slice(0, 100);
  if (q.length < 2) return { query: q, tooShort: true, cases: [], records: [], evidence: [], requests: [] };
  const ids = await accessibleCaseIds(db, user);
  const fir = /^fir\s*(?:no\.?\s*)?(\d+)\s*\/\s*(\d{4})$/i.exec(q);
  const [cases, entities, segments, requests] = await Promise.all([
    db.case.findMany({
      where: { id: { in: ids }, OR: [...(fir ? [{ firNumber: Number(fir[1]), firYear: Number(fir[2]) }] : []), { title: { contains: q } }, { complaintRef: { contains: q } }, { narrative: { contains: q } }] },
      orderBy: { createdAt: "desc" },
      take: 10,
    }),
    db.entity.findMany({ where: { caseId: { in: ids }, OR: [{ label: { contains: q } }, { value: { contains: q } }, { normalizedValue: { contains: q.toLowerCase() } }] }, include: { case: true }, take: 25 }),
    db.evidenceSegment.findMany({ where: { caseId: { in: ids }, text: { contains: q } }, include: { evidence: { select: { id: true, title: true } }, case: true }, take: 25 }),
    db.request.findMany({ where: { caseId: { in: ids }, status: { not: "DISCARDED" }, OR: [{ reference: { contains: q } }, { legacyReference: { contains: q } }, { versions: { some: { subject: { contains: q } } } }] }, include: { case: true, recipient: true, versions: { orderBy: { versionNo: "desc" }, take: 1 } }, take: 25 }),
  ]);
  return {
    query: q,
    tooShort: false,
    cases: cases.map((c) => ({ id: c.id, reference: caseReference(c), title: c.title, status: c.status, href: `/cases/${c.id}` })),
    records: entities.map((e) => ({
      id: e.id,
      label: e.label,
      value: e.value,
      kind: IDENTIFIER_KIND_LABELS[e.kind] ?? e.kind,
      caseReference: caseReference(e.case),
      href: `/cases/${e.caseId}/people`,
      graphHref: `/cases/${e.caseId}/graph?focus=${e.id}`,
    })),
    evidence: segments.map((s) => {
      const locator = [s.page ? `p. ${s.page}` : null, s.line ? `line ${s.line}` : null, s.row ? `row ${s.row}` : null].filter(Boolean).join(", ");
      return { id: s.id, evidenceTitle: s.evidence.title, locator, caseReference: caseReference(s.case), href: evidenceHref(s.caseId, s.evidenceId, locator), excerpt: excerpt(s.text, q) };
    }),
    requests: requests
      .sort((a, b) => Number(b.reference.toLowerCase() === q.toLowerCase()) - Number(a.reference.toLowerCase() === q.toLowerCase()) || a.reference.localeCompare(b.reference))
      .map((r) => ({ id: r.id, reference: r.reference, subject: r.versions[0]?.subject ?? "", status: r.status, recipient: r.recipient.organisation, caseReference: caseReference(r.case), href: `/cases/${r.caseId}/requests/${r.id}` })),
  };
}

export type SearchResults = Awaited<ReturnType<typeof searchRecords>>;
