import type { LibraryDocument } from "@/domain/guidance";
import type { Db } from "../db";

/** The approved-document library (published documents) as plain data for local retrieval. It never includes case records. */
export async function loadLibrary(db: Db): Promise<(LibraryDocument & { summary: string; isSynthetic: boolean; category: string; reviewNote: string | null })[]> {
  // Only published documents are answered from: drafts are still being checked and retired ones are withdrawn.
  const docs = await db.knowledgeDocument.findMany({ where: { status: { in: ["CURRENT", "SUPERSEDED"] } }, include: { sections: { orderBy: { sortOrder: "asc" } } }, orderBy: [{ title: "asc" }, { effectiveFrom: "desc" }] });
  return docs.map((d) => ({
    id: d.id,
    title: d.title,
    docNumber: d.docNumber,
    issuingBody: d.issuingBody,
    jurisdiction: d.jurisdiction,
    version: d.version,
    effectiveFrom: d.effectiveFrom.toISOString(),
    status: d.status,
    supersededById: d.supersededById,
    summary: d.summary,
    isSynthetic: d.isSynthetic,
    category: d.category,
    reviewNote: d.reviewNote,
    sections: d.sections.map((s) => ({ id: s.id, sectionRef: s.sectionRef, heading: s.heading, text: s.text, topics: JSON.parse(s.topicsJson) as string[] })),
  }));
}
