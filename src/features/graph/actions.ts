"use server";

import { getDb } from "@/server/db";
import { markGraphReviewed } from "@/server/services/graph";
import { runAction } from "@/features/shared/run-action";

export async function markGraphReviewedAction(caseId: string) {
  return runAction(async (user) => {
    await markGraphReviewed(getDb(), user, caseId);
    return null;
  });
}
