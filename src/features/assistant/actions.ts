"use server";

import { getDb } from "@/server/db";
import { askCaseAssistant, askGuidance } from "@/server/services/assistant";
import { runAction } from "@/features/shared/run-action";

// Asking does not change any record (each question is only logged), so the page is not refreshed.
export async function askCaseAssistantAction(caseId: string, question: string) {
  return runAction((user) => askCaseAssistant(getDb(), user, caseId, question), { refresh: false });
}

export async function askGuidanceAction(question: string) {
  return runAction((user) => askGuidance(getDb(), user, question), { refresh: false });
}
