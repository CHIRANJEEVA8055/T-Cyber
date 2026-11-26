"use server";

import { getDb } from "@/server/db";
import { prepareDraftFromTask } from "@/server/services/drafting";
import { assignTask, completeTask, createOfficerTask, deferTask, dismissTask, reopenTask } from "@/server/services/tasks";
import { istInputToUtc } from "@/domain/time";
import { runAction } from "@/features/shared/run-action";
import { AppError } from "@/server/errors";

export async function prepareDraftAction(taskId: string) {
  return runAction(async (user) => {
    const r = await prepareDraftFromTask(getDb(), user, taskId);
    return { requestId: r.id, caseId: r.caseId, reference: r.reference };
  });
}

export async function assignTaskAction(taskId: string, expectedVersion: number, assigneeId: string | null) {
  return runAction(async (user) => {
    await assignTask(getDb(), user, taskId, expectedVersion, assigneeId);
    return null;
  });
}

export async function deferTaskAction(taskId: string, expectedVersion: number, untilDate: string, reason: string) {
  return runAction(async (user) => {
    const until = untilDate ? istInputToUtc(untilDate) : null;
    if (untilDate && !until) throw new AppError("Enter a valid date.", "VALIDATION", { until: "Enter a valid date." });
    await deferTask(getDb(), user, taskId, expectedVersion, until, reason);
    return null;
  });
}

export async function dismissTaskAction(taskId: string, expectedVersion: number, reason: string) {
  return runAction(async (user) => {
    await dismissTask(getDb(), user, taskId, expectedVersion, reason);
    return null;
  });
}

export async function reopenTaskAction(taskId: string, expectedVersion: number) {
  return runAction(async (user) => {
    await reopenTask(getDb(), user, taskId, expectedVersion);
    return null;
  });
}

export async function completeTaskAction(taskId: string, expectedVersion: number, note: string, evidenceId: string | null) {
  return runAction(async (user) => {
    await completeTask(getDb(), user, taskId, expectedVersion, note, evidenceId);
    return null;
  });
}

export async function createOfficerTaskAction(caseId: string, input: { title: string; objective: string; question: string; purpose: string; dueDate: string; assigneeId: string | null }) {
  return runAction(async (user) => {
    const dueAt = input.dueDate ? istInputToUtc(input.dueDate) : null;
    if (input.dueDate && !dueAt) throw new AppError("Enter a valid date.", "VALIDATION", { dueDate: "Enter a valid date." });
    const t = await createOfficerTask(getDb(), user, caseId, { title: input.title, objective: input.objective, question: input.question, purpose: input.purpose, dueAt, assigneeId: input.assigneeId });
    return { taskId: t.id };
  });
}
