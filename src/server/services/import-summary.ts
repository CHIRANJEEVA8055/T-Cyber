import type { Db } from "../db";

/** What the "Import a reply" window shows once a reply is read in: the match, and the first facts found in it. */
export async function describeImportedReply(db: Db, responseId: string) {
  const r = await db.response.findUniqueOrThrow({ where: { id: responseId }, include: { findings: { orderBy: { sortOrder: "asc" } }, request: { select: { caseSeq: true, reference: true } } } });
  return {
    responseId: r.id,
    matched: r.matchStatus === "MATCHED",
    to: r.request ? r.request.reference : null,
    score: r.matchScore,
    basis: r.matchBasis,
    findings: r.findings.slice(0, 4).map((f) => f.summary),
    more: Math.max(0, r.findings.length - 4),
  };
}
export type ImportedReply = Awaited<ReturnType<typeof describeImportedReply>>;
