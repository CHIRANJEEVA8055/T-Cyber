import { deriveRecommendations, explainResolution, type Recommendation } from "@/domain/recommendations";
import { now } from "../clock";
import type { Db, Tx } from "../db";
import type { SessionUser } from "../auth/session";
import { loadCaseForUser } from "../auth/access";
import { recordAudit } from "../audit";
import { AppError, conflictError, notFoundError } from "../errors";
import { loadRecoFacts } from "./facts";

export const ACTIVE_TASK_STATUSES = ["OPEN", "DRAFT_PREPARED", "WAITING", "BLOCKED", "DEFERRED"];

function taskData(rec: Recommendation) {
  return {
    kind: rec.kind,
    objective: rec.objective,
    title: rec.title,
    question: rec.question,
    purpose: rec.purpose,
    relevance: rec.relevance,
    recipientHint: rec.recipientHint,
    requestCategory: rec.requestCategory,
    scope: rec.scope,
    periodFrom: rec.periodFrom,
    periodTo: rec.periodTo,
    prerequisitesJson: JSON.stringify(rec.prerequisites),
    expectedClarification: rec.expectedClarification,
    priority: rec.priority,
    priorityReason: rec.priorityReason,
    subjectEntityIdsJson: JSON.stringify(rec.subjectEntityIds),
    ruleId: rec.ruleId,
    responseId: rec.responseId,
  };
}

async function linkSources(tx: Tx, caseId: string, taskId: string, rec: Recommendation) {
  for (const s of rec.supportingSources) {
    const dedupeKey = `TASK:${taskId}:${s.evidenceId}:${s.locator}:SUPPORTS`;
    await tx.sourceAssertion.upsert({
      where: { caseId_dedupeKey: { caseId, dedupeKey } },
      create: { caseId, evidenceId: s.evidenceId, locator: s.locator, excerpt: s.excerpt, subjectType: "TASK", subjectId: taskId, stance: "SUPPORTS", dedupeKey },
      update: {},
    });
  }
}

/**
 * Reconciles the engine's recommendations with stored tasks. Idempotent: running it twice
 * changes nothing. Officer decisions (dismissed, deferred, assigned) are respected.
 */
export async function refreshRecommendationsTx(tx: Tx, caseId: string, _actorId: string | null, at = now()) {
  const facts = await loadRecoFacts(tx, caseId, at);
  const recs = deriveRecommendations(facts);
  const existing = await tx.task.findMany({ where: { caseId, generatedBy: "RULE" } });
  const byKey = new Map(existing.map((t) => [t.dedupeKey, t]));
  const wanted = new Set(recs.map((r) => r.dedupeKey));
  const summary = { created: 0, updated: 0, resolved: 0 };

  for (const rec of recs) {
    const t = byKey.get(rec.dedupeKey);
    if (!t) {
      const created = await tx.task.create({
        data: { caseId, ...taskData(rec), status: rec.status, requestId: rec.requestId, dedupeKey: rec.dedupeKey, generatedBy: "RULE", createdAt: at },
      });
      await linkSources(tx, caseId, created.id, rec);
      await recordAudit(tx, { caseId, actorId: null, action: "task.recommended", objectType: "Task", objectId: created.id, summary: `Next action proposed: ${rec.title}`, at });
      summary.created++;
      continue;
    }
    if (t.status === "DISMISSED") continue; // officer decision stands
    const reopened = t.status === "COMPLETED" || t.status === "SUPERSEDED";
    const keepDeferred = t.status === "DEFERRED" && rec.status === "OPEN";
    const status = keepDeferred ? "DEFERRED" : rec.status;
    const changed =
      reopened ||
      t.status !== status ||
      t.requestId !== rec.requestId ||
      t.title !== rec.title ||
      t.question !== rec.question ||
      t.relevance !== rec.relevance ||
      t.prerequisitesJson !== JSON.stringify(rec.prerequisites);
    if (!changed) {
      await linkSources(tx, caseId, t.id, rec);
      continue;
    }
    await tx.task.update({
      where: { id: t.id },
      data: {
        ...taskData(rec),
        status,
        requestId: rec.requestId,
        statusReason: reopened ? "Reopened: the condition applies again based on current case facts." : t.statusReason,
        version: { increment: 1 },
      },
    });
    await linkSources(tx, caseId, t.id, rec);
    if (reopened) {
      await recordAudit(tx, { caseId, actorId: null, action: "task.reopened", objectType: "Task", objectId: t.id, summary: `Next action reopened: ${rec.title}`, at });
    } else if (t.status === "BLOCKED" && status === "OPEN") {
      // What it waited for is now known (a bank, a provider, an ATM ID): it can be drafted.
      await recordAudit(tx, { caseId, actorId: null, action: "task.unblocked", objectType: "Task", objectId: t.id, summary: `Next action ready: ${rec.title}`, at });
    }
    summary.updated++;
  }

  for (const t of existing) {
    if (wanted.has(t.dedupeKey) || !ACTIVE_TASK_STATUSES.includes(t.status)) continue;
    const res = explainResolution(t.dedupeKey, facts);
    await tx.task.update({
      where: { id: t.id },
      data: {
        status: res.outcome,
        statusReason: res.reason,
        ...(res.outcome === "SUPERSEDED" && res.requestId ? { requestId: res.requestId } : {}),
        version: { increment: 1 },
      },
    });
    await recordAudit(tx, {
      caseId,
      actorId: null,
      action: res.outcome === "COMPLETED" ? "task.completed_by_facts" : "task.superseded",
      objectType: "Task",
      objectId: t.id,
      summary: `${res.outcome === "COMPLETED" ? "Completed" : "Superseded"}: ${t.title}. ${res.reason}`,
      at,
    });
    summary.resolved++;
  }
  return summary;
}

export function refreshRecommendations(db: Db, user: SessionUser, caseId: string) {
  return db.$transaction(async (tx) => {
    await loadCaseForUser(tx, user, caseId, "write");
    return refreshRecommendationsTx(tx, caseId, user.id);
  });
}

async function loadTaskForUser(tx: Tx, user: SessionUser, taskId: string, expectedVersion: number) {
  const task = await tx.task.findUnique({ where: { id: taskId } });
  if (!task) throw notFoundError("task");
  await loadCaseForUser(tx, user, task.caseId, "write");
  if (task.version !== expectedVersion) throw conflictError("This task was updated by someone else. Reload to see the latest state.");
  return task;
}

export function assignTask(db: Db, user: SessionUser, taskId: string, expectedVersion: number, assigneeId: string | null) {
  return db.$transaction(async (tx) => {
    const task = await loadTaskForUser(tx, user, taskId, expectedVersion);
    if (assigneeId) {
      const assignee = await tx.user.findUnique({ where: { id: assigneeId } });
      const kase = await tx.case.findUniqueOrThrow({ where: { id: task.caseId }, include: { assignments: true } });
      const eligible = assignee && (kase.assignments.some((a) => a.userId === assigneeId) || (assignee.role === "SUPERVISOR" && assignee.stationId === kase.stationId));
      if (!eligible) throw new AppError("Assign the task to an officer working on this case.", "VALIDATION", { assigneeId: "Choose an officer assigned to this case." });
    }
    const updated = await tx.task.update({ where: { id: taskId }, data: { assigneeId, version: { increment: 1 } } });
    await recordAudit(tx, { caseId: task.caseId, actorId: user.id, action: "task.assigned", objectType: "Task", objectId: taskId, summary: assigneeId ? `Task assigned: ${task.title}` : `Task unassigned: ${task.title}`, detail: { assigneeId } });
    return updated;
  });
}

export function deferTask(db: Db, user: SessionUser, taskId: string, expectedVersion: number, until: Date | null, reason: string) {
  return db.$transaction(async (tx) => {
    const task = await loadTaskForUser(tx, user, taskId, expectedVersion);
    if (reason.trim().length < 3) throw new AppError("Give a reason for deferring.", "VALIDATION", { reason: "Give a reason for deferring." });
    if (!ACTIVE_TASK_STATUSES.includes(task.status)) throw new AppError("Only open tasks can be deferred.", "PRECONDITION");
    const updated = await tx.task.update({ where: { id: taskId }, data: { status: "DEFERRED", deferredUntil: until, statusReason: reason.trim(), version: { increment: 1 } } });
    await recordAudit(tx, { caseId: task.caseId, actorId: user.id, action: "task.deferred", objectType: "Task", objectId: taskId, summary: `Deferred: ${task.title}`, detail: { reason, until } });
    return updated;
  });
}

export function dismissTask(db: Db, user: SessionUser, taskId: string, expectedVersion: number, reason: string) {
  return db.$transaction(async (tx) => {
    const task = await loadTaskForUser(tx, user, taskId, expectedVersion);
    if (reason.trim().length < 3) throw new AppError("Give a reason for dismissing.", "VALIDATION", { reason: "Give a reason for dismissing." });
    const updated = await tx.task.update({ where: { id: taskId }, data: { status: "DISMISSED", statusReason: reason.trim(), version: { increment: 1 } } });
    await recordAudit(tx, { caseId: task.caseId, actorId: user.id, action: "task.dismissed", objectType: "Task", objectId: taskId, summary: `Dismissed: ${task.title}`, detail: { reason } });
    return updated;
  });
}

export function reopenTask(db: Db, user: SessionUser, taskId: string, expectedVersion: number) {
  return db.$transaction(async (tx) => {
    const task = await loadTaskForUser(tx, user, taskId, expectedVersion);
    const updated = await tx.task.update({ where: { id: taskId }, data: { status: "OPEN", statusReason: null, deferredUntil: null, version: { increment: 1 } } });
    await recordAudit(tx, { caseId: task.caseId, actorId: user.id, action: "task.reopened", objectType: "Task", objectId: taskId, summary: `Reopened: ${task.title}` });
    return updated;
  });
}

export function completeTask(db: Db, user: SessionUser, taskId: string, expectedVersion: number, note: string, evidenceId: string | null) {
  return db.$transaction(async (tx) => {
    const task = await loadTaskForUser(tx, user, taskId, expectedVersion);
    if (note.trim().length < 3) throw new AppError("Describe how the task was completed.", "VALIDATION", { note: "Describe what was done." });
    if (evidenceId) {
      const ev = await tx.evidenceItem.findUnique({ where: { id: evidenceId } });
      if (!ev || ev.caseId !== task.caseId) throw new AppError("Choose evidence from this case.", "VALIDATION", { evidenceId: "Choose evidence from this case." });
    }
    const updated = await tx.task.update({
      where: { id: taskId },
      data: { status: "COMPLETED", completionNote: note.trim(), completionEvidenceId: evidenceId, statusReason: "Completed by officer", version: { increment: 1 } },
    });
    await recordAudit(tx, { caseId: task.caseId, actorId: user.id, action: "task.completed", objectType: "Task", objectId: taskId, summary: `Completed: ${task.title}`, detail: { note, evidenceId } });
    return updated;
  });
}

export function createOfficerTask(
  db: Db,
  user: SessionUser,
  caseId: string,
  input: { title: string; objective: string; question: string; purpose: string; dueAt: Date | null; assigneeId: string | null },
) {
  return db.$transaction(async (tx) => {
    await loadCaseForUser(tx, user, caseId, "write");
    const fieldErrors: Record<string, string> = {};
    if (input.title.trim().length < 5) fieldErrors.title = "Enter a task title of at least 5 characters.";
    if (input.question.trim().length < 5) fieldErrors.question = "State the question this task answers.";
    if (!["FINANCIAL", "IDENTITY", "EVIDENCE"].includes(input.objective)) fieldErrors.objective = "Choose an objective.";
    if (Object.keys(fieldErrors).length) throw new AppError("Some fields need attention.", "VALIDATION", fieldErrors);
    const task = await tx.task.create({
      data: {
        caseId,
        kind: "OFFICER_TASK",
        objective: input.objective,
        title: input.title.trim(),
        question: input.question.trim(),
        purpose: input.purpose.trim() || "Officer-defined task.",
        relevance: "Added by an officer.",
        expectedClarification: "Recorded on completion.",
        priority: "NORMAL",
        priorityReason: "Set by officer.",
        status: "OPEN",
        dueAt: input.dueAt,
        assigneeId: input.assigneeId,
        dedupeKey: `OFFICER:${crypto.randomUUID()}`,
        generatedBy: "OFFICER",
        createdAt: now(),
      },
    });
    await recordAudit(tx, { caseId, actorId: user.id, action: "task.created", objectType: "Task", objectId: task.id, summary: `Task added: ${task.title}` });
    return task;
  });
}
