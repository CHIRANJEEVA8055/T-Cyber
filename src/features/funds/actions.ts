"use server";

import { getDb } from "@/server/db";
import {
  addManualTransaction,
  advanceRefund,
  confirmAllocation,
  proposeAllocation,
  recordHoldChange,
  recordHoldConfirmation,
  recordRefund,
  upsertClaim,
  withdrawAllocation,
  type ManualTransactionInput,
} from "@/server/services/funds";
import { withAutoDraft } from "@/server/services/auto-draft";
import { runAction } from "@/features/shared/run-action";

const ok = <T,>(p: Promise<T>) => p.then(() => null);

export async function addTransactionAction(caseId: string, input: ManualTransactionInput) {
  return runAction(async (user) => {
    const { autoDraft } = await withAutoDraft(getDb(), user, async () => caseId, () => addManualTransaction(getDb(), user, caseId, input));
    return { autoDraft };
  });
}
export async function upsertClaimAction(caseId: string, input: { victimEntityId: string; lossRupees: string; basis: string }) {
  return runAction((user) => ok(upsertClaim(getDb(), user, caseId, input)));
}
export async function recordHoldConfirmationAction(caseId: string, input: { accountEntityId: string; amountRupees: string | null; asOf: string; bankReference: string | null; note: string; evidenceId: string | null; locator: string | null }) {
  return runAction((user) => ok(recordHoldConfirmation(getDb(), user, caseId, input)));
}
export async function recordHoldChangeAction(holdId: string, input: { type: "AMOUNT_CHANGED" | "RELEASED"; amountRupees: string | null; at: string; note: string }) {
  return runAction((user) => ok(recordHoldChange(getDb(), user, holdId, input)));
}
export async function proposeAllocationAction(caseId: string, input: { holdId: string; claimId: string; amountRupees: string; basis: string }) {
  return runAction((user) => ok(proposeAllocation(getDb(), user, caseId, input)));
}
export async function confirmAllocationAction(allocationId: string, acknowledgeOverAllocation: boolean) {
  return runAction((user) => ok(confirmAllocation(getDb(), user, allocationId, { acknowledgeOverAllocation })));
}
export async function withdrawAllocationAction(allocationId: string, reason: string) {
  return runAction((user) => ok(withdrawAllocation(getDb(), user, allocationId, reason)));
}
export async function recordRefundAction(caseId: string, input: { claimId: string; holdId: string | null; amountRupees: string; authorityReference: string; authorisedAt: string }) {
  return runAction((user) => ok(recordRefund(getDb(), user, caseId, input)));
}
export async function advanceRefundAction(refundId: string, input: { to: "INITIATED" | "CREDIT_CONFIRMED" | "FAILED" | "CANCELLED"; at: string; note: string }) {
  return runAction((user) => ok(advanceRefund(getDb(), user, refundId, input)));
}
