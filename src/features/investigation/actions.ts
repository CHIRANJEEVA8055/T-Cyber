"use server";

import { getDb } from "@/server/db";
import { addRelationship, setEntityVerification, setLocationCorroboration } from "@/server/services/investigation";
import { runAction } from "@/features/shared/run-action";

export async function setEntityVerificationAction(entityId: string, status: "UNVERIFIED" | "CORROBORATED" | "DISPUTED", note: string) {
  return runAction(async (user) => {
    await setEntityVerification(getDb(), user, entityId, { status, note });
    return null;
  });
}

export async function addRelationshipAction(caseId: string, input: { fromEntityId: string; toEntityId: string; type: string; statement: string; evidenceId: string | null; locator: string | null }) {
  return runAction(async (user) => {
    await addRelationship(getDb(), user, caseId, input);
    return null;
  });
}

export async function setLocationCorroborationAction(locationId: string, corroboration: "UNCORROBORATED" | "CORROBORATED" | "CONTRADICTED", note: string) {
  return runAction(async (user) => {
    await setLocationCorroboration(getDb(), user, locationId, { corroboration, note });
    return null;
  });
}
