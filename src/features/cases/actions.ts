"use server";

import { getDb } from "@/server/db";
import { updateCaseDetails, setCaseStatus, createCase } from "@/server/services/cases";
import { refreshRecommendations } from "@/server/services/tasks";
import { classifyCase } from "@/server/services/case-mo";
import { withAutoDraft } from "@/server/services/auto-draft";
import { runAction } from "@/features/shared/run-action";
import type { CreateCaseInput } from "@/contracts/case";

export async function updateCaseDetailsAction(caseId: string, input: { expectedVersion: number; title: string; narrative: string; legalSections: string | null; fraudCategory: string | null; moVertical?: string | null; moSubtype?: string | null }) {
  return runAction(async (user) => {
    await updateCaseDetails(getDb(), user, caseId, input);
    // "Classify again from the FIR": as the FIR states it, or by the local model from its brief and facts.
    if (input.moVertical === null) await classifyCase(getDb(), user, caseId);
    return { caseId };
  });
}

export async function setCaseStatusAction(caseId: string, input: { expectedVersion: number; status: "OPEN" | "CLOSED"; reason: string }) {
  return runAction(async (user) => {
    await setCaseStatus(getDb(), user, caseId, input);
    return { caseId };
  });
}

export async function refreshRecommendationsAction(caseId: string) {
  return runAction(async (user) => refreshRecommendations(getDb(), user, caseId));
}

export async function createCaseAction(input: CreateCaseInput) {
  return runAction(async (user) => {
    const { result: c, autoDraft } = await withAutoDraft(getDb(), user, async (created) => created.id, () => createCase(getDb(), user, input));
    return { caseId: c.id, autoDraft };
  });
}
