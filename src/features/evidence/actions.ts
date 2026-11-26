"use server";

import { getDb } from "@/server/db";
import { addManualCandidate, applyReviewedCandidates, confirmClearCandidates, reviewCandidate, type CandidateReviewInput } from "@/server/services/extraction";
import { withAutoDraft } from "@/server/services/auto-draft";
import { runAction } from "@/features/shared/run-action";

export async function reviewCandidateAction(candidateId: string, input: CandidateReviewInput) {
  return runAction(async (user) => {
    await reviewCandidate(getDb(), user, candidateId, input);
    return null;
  });
}

export async function addManualCandidateAction(evidenceId: string, input: { field: string; value: string; page: number | null; line: number | null; row: number | null; roleHint: string | null }) {
  return runAction(async (user) => {
    await addManualCandidate(getDb(), user, evidenceId, input);
    return null;
  });
}

export async function applyCandidatesAction(evidenceId: string, opts: { payerAccountEntityId: string | null; claimId: string | null }) {
  return runAction(async (user) => {
    const db = getDb();
    const { result, autoDraft } = await withAutoDraft(
      db,
      user,
      async () => (await db.evidenceItem.findUniqueOrThrow({ where: { id: evidenceId }, select: { caseId: true } })).caseId,
      () => applyReviewedCandidates(db, user, evidenceId, opts),
    );
    return { ...result, autoDraft };
  });
}

export async function confirmClearCandidatesAction(evidenceId: string) {
  return runAction(async (user) => confirmClearCandidates(getDb(), user, evidenceId));
}
