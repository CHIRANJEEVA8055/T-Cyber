"use server";

import { getDb } from "@/server/db";
import { resetDemoData, setFailureSimulation, setRecipientVerification, updateRoute, updateTemplate } from "@/server/services/settings";
import { runAction } from "@/features/shared/run-action";

export async function setRecipientVerificationAction(recipientId: string, verified: boolean, note: string) {
  return runAction(async (user) => {
    await setRecipientVerification(getDb(), user, recipientId, { verified, note });
    return null;
  });
}

export async function updateRouteAction(routeId: string, input: { approvalRole: string; followUpDays: number; procedureNote: string; expectedUpdatedAt: string }) {
  return runAction(async (user) => {
    await updateRoute(getDb(), user, routeId, input);
    return null;
  });
}

export async function updateTemplateAction(templateId: string, input: { subjectTemplate: string; bodyTemplate: string; expectedVersion: number }) {
  return runAction(async (user) => {
    await updateTemplate(getDb(), user, templateId, input);
    return null;
  });
}

export async function setFailureSimulationAction(key: string, enabled: boolean) {
  return runAction(async (user) => {
    await setFailureSimulation(getDb(), user, key, enabled);
    return null;
  });
}

// The reset signs everyone out (sessions are part of the demonstration data), so the page is not refreshed here;
// the client goes to the sign-in page, which explains what happened.
export async function resetDemoAction(confirmation: string) {
  return runAction(
    async (user) => {
      await resetDemoData(getDb(), user, { confirmation });
      return null;
    },
    { refresh: false },
  );
}
