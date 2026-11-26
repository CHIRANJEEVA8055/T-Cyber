import type { Db } from "../db";
import type { SessionUser } from "../auth/session";
import { loadCaseForUser } from "../auth/access";
import { recordAudit } from "../audit";
import { decideMo, type MoDecision } from "../ai/mo-classify";
import { verticalByKey } from "@/domain/mo-verticals";

/**
 * A case's investigation vertical (data/MO.docx), decided when its FIR is read: as the FIR states it, or else by the
 * local model from the brief and facts. Kept on the case with the basis and the reason, and logged.
 */
export async function storeMo(db: Db, user: Pick<SessionUser, "id">, caseId: string, d: MoDecision) {
  const v = verticalByKey(d.key)!;
  await db.$transaction(async (tx) => {
    await tx.case.update({ where: { id: caseId }, data: { moVertical: d.key, moSubtype: d.subtype, moBasis: d.basis, moReason: d.reason } });
    await recordAudit(tx, {
      caseId,
      actorId: user.id,
      action: "case.mo_classified",
      objectType: "Case",
      objectId: caseId,
      summary: `Placed in ${v.label}${d.subtype ? ` · ${d.subtype}` : ""} (${d.basis === "FIR" ? "as the FIR states it" : d.basis === "MODEL" ? `by the local model ${d.model}` : "by the rules"}): ${d.reason}`,
      detail: { ...d },
    });
  });
}

/** Reads the case's FIR again (its own text, the brief and the stated sections) and places it in a vertical. */
export async function classifyCase(db: Db, user: SessionUser, caseId: string): Promise<MoDecision> {
  const kase = await loadCaseForUser(db, user, caseId, "write");
  const fir = await db.evidenceItem.findFirst({ where: { caseId, category: "FIR_COPY" }, orderBy: [{ derivation: "asc" }, { receivedAt: "asc" }], include: { segments: { orderBy: [{ page: "asc" }, { line: "asc" }], take: 1500 }, derived: { include: { segments: { orderBy: [{ page: "asc" }, { line: "asc" }], take: 1500 } } } } });
  // A translated copy is read in English.
  const english = fir?.derived.find((x) => x.derivation === "TRANSLATION")?.segments ?? fir?.segments ?? [];
  const firText = english.map((x) => x.text).join("\n");
  const d = await decideMo({ firText, facts: [kase.title, kase.moSummary, kase.narrative].filter(Boolean).join("\n"), sections: kase.legalSections });
  await storeMo(db, user, caseId, d);
  return d;
}
