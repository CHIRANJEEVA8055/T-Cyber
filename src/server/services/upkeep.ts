import type { Db } from "../db";
import type { SessionUser } from "../auth/session";
import { AppError } from "../errors";
import { recordAudit } from "../audit";
import { getAppConfig } from "../config";
import { now } from "../clock";
import { assistantAuthorId } from "../assistant-identity";
import { deriveRecommendations } from "@/domain/recommendations";
import { loadRecoFacts } from "./facts";
import { refreshRecommendationsTx } from "./tasks";
import { prepareDraftFromTask } from "./drafting";

export interface UpkeepResult {
  cases: number;
  /** Reminders drafted (or, in a dry run, that would be drafted): the reminders' references, or their requests'. */
  drafted: { caseId: string; reference: string; isDemo: boolean }[];
  failed: number;
}

/**
 * What changes with time alone, kept current for every open case. A follow-up date passing is not something an
 * officer does, so without this a case's Next actions would not show it until something else happened in the case,
 * while the dashboard already says "not answered for N days".
 *  - each open case's next actions are worked out again (the same rules as after any change);
 *  - a reminder that has come due is drafted, as the assistant, for the investigating officer to check and send
 *    (when requests.autoDraft is on). Nothing is ever sent: approval and sending stay with officers.
 * Safe to run at any time and as often as wanted: a case with nothing new is left as it is. With dryRun nothing is
 * written; the result lists the reminders that would be drafted.
 */
export async function upkeepOpenCases(db: Db, opts: { at?: Date; dryRun?: boolean } = {}): Promise<UpkeepResult> {
  const at = opts.at ?? now();
  const cases = await db.case.findMany({
    where: { status: "OPEN" },
    select: { id: true, stationId: true, isDemo: true, assignments: { select: { role: true, user: { include: { station: true } } } } },
    orderBy: { createdAt: "asc" },
  });
  const out: UpkeepResult = { cases: cases.length, drafted: [], failed: 0 };
  const autoDraft = getAppConfig().requests.autoDraft !== false;
  for (const c of cases) {
    const io = c.assignments.find((a) => a.role === "INVESTIGATING_OFFICER")?.user;
    if (opts.dryRun) {
      if (!autoDraft || !io?.active) continue;
      const recs = deriveRecommendations(await loadRecoFacts(db, c.id, at)).filter((r) => r.dedupeKey.startsWith("FOLLOWUP:"));
      const taken = await db.task.findMany({ where: { caseId: c.id, dedupeKey: { in: recs.map((r) => r.dedupeKey) } }, select: { dedupeKey: true, status: true } });
      for (const r of recs) {
        const t = taken.find((x) => x.dedupeKey === r.dedupeKey);
        // A follow-up action names the request it follows up (requestId); it is open until its reminder is drafted.
        if (t && t.status !== "OPEN") continue;
        const parent = await db.request.findUnique({ where: { id: r.dedupeKey.slice("FOLLOWUP:".length) }, select: { reference: true } });
        out.drafted.push({ caseId: c.id, reference: `${parent?.reference ?? "?"} (reminder)`, isDemo: c.isDemo });
      }
      continue;
    }
    try {
      await db.$transaction((tx) => refreshRecommendationsTx(tx, c.id, null, at));
    } catch {
      out.failed++;
      continue;
    }
    if (!autoDraft || !io?.active) continue;
    // Open follow-up actions: their reminder is not drafted yet (drafting it moves the action on).
    const due = await db.task.findMany({ where: { caseId: c.id, generatedBy: "RULE", status: "OPEN", dedupeKey: { startsWith: "FOLLOWUP:" } }, orderBy: { createdAt: "asc" } });
    if (!due.length) continue;
    const user: SessionUser = { id: io.id, username: io.username, displayName: io.displayName, rank: io.rank, role: io.role === "SUPERVISOR" ? "SUPERVISOR" : "OFFICER", stationId: io.stationId, stationCode: io.station.code, stationName: io.station.name };
    const drafted: { reference: string; taskId: string }[] = [];
    for (const t of due) {
      try {
        const r = await prepareDraftFromTask(db, user, t.id, { asAssistant: true });
        drafted.push({ reference: r.reference, taskId: t.id });
      } catch (err) {
        // Not draftable yet (no route, no addressee): the action stays open in Next actions and says why.
        if (!(err instanceof AppError)) out.failed++;
      }
    }
    if (!drafted.length) continue;
    out.drafted.push(...drafted.map((d) => ({ caseId: c.id, reference: d.reference, isDemo: c.isDemo })));
    const author = (await assistantAuthorId(db, c.stationId)) ?? io.id;
    await db.$transaction((tx) =>
      recordAudit(tx, {
        caseId: c.id,
        actorId: author,
        action: "request.auto_drafted",
        objectType: "Case",
        objectId: c.id,
        summary: `${drafted.length === 1 ? "A reminder was" : `${drafted.length} reminders were`} drafted because the follow-up date passed with no full reply (${drafted.map((d) => d.reference).join(", ")}); nothing was sent`,
        detail: { drafted },
      }),
    );
  }
  return out;
}
