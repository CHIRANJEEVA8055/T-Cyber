"use server";

import { getDb } from "@/server/db";
import { recordCorrection } from "@/server/services/activity";
import { createReport, markReportReviewed, regenerateReport, saveReportEdit, type ReportKind } from "@/server/services/reports";
import { runAction } from "@/features/shared/run-action";

export async function recordCorrectionAction(caseId: string, eventId: string, text: string) {
  return runAction(async (user) => {
    await recordCorrection(getDb(), user, caseId, eventId, { text });
    return null;
  });
}

export async function createReportAction(caseId: string, kind: ReportKind) {
  return runAction(async (user) => createReport(getDb(), user, caseId, kind));
}

export async function regenerateReportAction(reportId: string, expectedVersion: number) {
  return runAction(async (user) => regenerateReport(getDb(), user, reportId, { expectedVersion }));
}

export async function saveReportEditAction(reportId: string, input: { body: string; changeNote: string; expectedVersion: number }) {
  return runAction(async (user) => saveReportEdit(getDb(), user, reportId, input));
}

export async function markReportReviewedAction(reportId: string, versionNo: number) {
  return runAction(async (user) => {
    await markReportReviewed(getDb(), user, reportId, { versionNo });
    return null;
  });
}
