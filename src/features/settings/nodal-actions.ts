"use server";

import { getDb } from "@/server/db";
import { addRecipientFromNodal } from "@/server/services/nodal";
import { runAction } from "@/features/shared/run-action";

export async function addNodalRecipientAction(contactId: string, email: string) {
  return runAction(async (user) => addRecipientFromNodal(getDb(), user, { contactId, email }));
}
