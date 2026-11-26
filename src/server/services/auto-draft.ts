import type { Db } from "../db";
import type { SessionUser } from "../auth/session";
import { AppError } from "../errors";
import { recordAudit } from "../audit";
import { prepareDraftFromTask } from "./drafting";
import { getAppConfig } from "../config";
import { now } from "../clock";
import { assistantAuthorId } from "../assistant-identity";

/** What the officer's screen needs to know about drafting that followed an action. */
export interface AutoDraftSummary {
  drafted: number;
  references: string[];
  skipped: number;
}

export interface AutoDraftResult {
  drafted: { taskId: string; requestId: string; reference: string; title: string }[];
  skipped: { taskId: string; title: string; reason: string }[];
}

/**
 * Drafts the requests that newly proposed next actions call for (bank nodal / LEA mails, UNICROSS
 * CDR and CAF requests, NPCI, provider portals), as soon as the facts behind them are recorded, so the
 * officer only reviews, edits and sends. Only drafts: approval and sending stay with officers.
 *
 * Covers next actions created at or after `since` (the officer action that recorded the facts), and actions that
 * became ready then because what they waited for (a bank, a provider) was recorded;
 * earlier proposals the officer left undrafted, and follow-up reminders, are left for the officer.
 * A proposal without a configured route stays open with the reason.
 */
export async function autoDraftRequests(db: Db, user: SessionUser, caseId: string, opts: { since: Date }): Promise<AutoDraftResult> {
  // Actions that became ready since: what they waited for (a bank, a provider) was recorded in this step.
  const unblocked = await db.auditEvent.findMany({ where: { caseId, action: "task.unblocked", at: { gte: opts.since } }, select: { objectId: true } });
  const tasks = await db.task.findMany({
    where: {
      caseId,
      generatedBy: "RULE",
      status: "OPEN",
      requestId: null,
      requestCategory: { not: null },
      // Low-priority proposals wait for the officer; the assistant drafts what is urgent or next.
      priority: { not: "LOW" },
      OR: [{ createdAt: { gte: opts.since } }, { id: { in: unblocked.map((u) => u.objectId).filter((x): x is string => !!x) } }],
      NOT: { dedupeKey: { startsWith: "FOLLOWUP:" } },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const result: AutoDraftResult = { drafted: [], skipped: [] };
  for (const t of tasks) {
    try {
      // One transaction per draft, so one proposal that cannot be drafted never undoes the others.
      const r = await prepareDraftFromTask(db, user, t.id, { asAssistant: true });
      result.drafted.push({ taskId: t.id, requestId: r.id, reference: r.reference, title: t.title });
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      result.skipped.push({ taskId: t.id, title: t.title, reason: err.message });
    }
  }
  // Drafts written before their addressee was known are addressed as soon as the missing detail is recorded.
  const unaddressed = await db.request.findMany({ where: { caseId, taskId: { not: null }, status: { in: ["DRAFT", "AWAITING_APPROVAL", "APPROVED", "SUBMISSION_FAILED"] }, recipient: { organisationType: "UNADDRESSED" } }, select: { id: true, taskId: true } });
  for (const u of unaddressed) {
    try {
      const r = await prepareDraftFromTask(db, user, u.taskId!, { asAssistant: true });
      const to = await db.recipient.findUnique({ where: { id: r.recipientId }, select: { organisationType: true } });
      const title = (await db.task.findUnique({ where: { id: u.taskId! }, select: { title: true } }))?.title ?? r.reference;
      if (to && to.organisationType !== "UNADDRESSED") result.drafted.push({ taskId: u.taskId!, requestId: r.id, reference: r.reference, title });
    } catch (err) {
      // Still missing: it stays as it is, and Next actions keeps saying what to record.
      if (!(err instanceof AppError)) throw err;
    }
  }
  if (result.drafted.length) {
    const n = result.drafted.length;
    const kase = await db.case.findUniqueOrThrow({ where: { id: caseId }, select: { stationId: true } });
    const author = (await assistantAuthorId(db, kase.stationId)) ?? user.id;
    await db.$transaction((tx) =>
      recordAudit(tx, {
        caseId,
        actorId: author,
        action: "request.auto_drafted",
        objectType: "Case",
        objectId: caseId,
        summary: `${n === 1 ? "1 request draft" : `${n} request drafts`} prepared automatically for new details (${result.drafted.map((d) => d.reference).join(", ")}); nothing was sent`,
        detail: { drafted: result.drafted, skipped: result.skipped },
      }),
    );
  }
  return result;
}

/**
 * Runs an officer action that records facts, then drafts the requests those facts call for (when
 * `requests.autoDraft` is on in the configuration file). The action's own result is returned unchanged.
 */
export async function withAutoDraft<T>(db: Db, user: SessionUser, caseId: (result: T) => Promise<string>, action: () => Promise<T>): Promise<{ result: T; autoDraft: AutoDraftSummary | null }> {
  const since = now();
  const result = await action();
  if (getAppConfig().requests.autoDraft === false) return { result, autoDraft: null };
  const a = await autoDraftRequests(db, user, await caseId(result), { since });
  return { result, autoDraft: { drafted: a.drafted.length, references: a.drafted.map((d) => d.reference), skipped: a.skipped.length } };
}
