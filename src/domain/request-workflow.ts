/**
 * Request lifecycle rules. Pure functions: safe to import from client and server code.
 *
 * Draft → Awaiting approval → Approved → Submitted → Acknowledged → Partial response → Complete response
 * Side branches: Returned for changes (→ Draft), Submission failed (retryable), Rejected (by recipient).
 * Editing approved content invalidates the approval. Nothing is ever sent automatically.
 */

export const REQUEST_STATUSES = [
  "DRAFT",
  "AWAITING_APPROVAL",
  "APPROVED",
  "SUBMITTED",
  "ACKNOWLEDGED",
  "PARTIAL_RESPONSE",
  "COMPLETE_RESPONSE",
  "REJECTED",
  "SUBMISSION_FAILED",
] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const RESPONSE_TYPES = ["ACKNOWLEDGEMENT", "PARTIAL", "COMPLETE", "REJECTION"] as const;
export type ResponseType = (typeof RESPONSE_TYPES)[number];

export type RequestEvent =
  | { type: "REQUEST_APPROVAL" }
  | { type: "APPROVE" }
  | { type: "RETURN_FOR_CHANGES" }
  | { type: "EDIT" }
  | { type: "SUBMIT_SUCCEEDED" }
  | { type: "SUBMIT_FAILED" }
  | { type: "RESPONSE_REVIEWED"; responseType: ResponseType };

export type TransitionResult =
  | { ok: true; status: RequestStatus; invalidatesApproval?: true }
  | { ok: false; error: string };

const EDITABLE: readonly string[] = ["DRAFT", "AWAITING_APPROVAL", "APPROVED", "SUBMISSION_FAILED"];
const SENT: readonly string[] = ["SUBMITTED", "ACKNOWLEDGED", "PARTIAL_RESPONSE", "COMPLETE_RESPONSE", "REJECTED"];

export function isEditableStatus(status: string): boolean {
  return EDITABLE.includes(status);
}

export function isSentStatus(status: string): boolean {
  return SENT.includes(status);
}

/** Requests still waiting on the recipient (used for "awaiting response" views and follow-ups). */
export function isAwaitingResponse(status: string): boolean {
  return status === "SUBMITTED" || status === "ACKNOWLEDGED" || status === "PARTIAL_RESPONSE";
}

const fail = (error: string): TransitionResult => ({ ok: false, error });

export function nextRequestStatus(current: string, event: RequestEvent): TransitionResult {
  switch (event.type) {
    case "REQUEST_APPROVAL":
      return current === "DRAFT"
        ? { ok: true, status: "AWAITING_APPROVAL" }
        : fail("Only a draft can be sent for approval.");

    case "APPROVE":
      return current === "AWAITING_APPROVAL"
        ? { ok: true, status: "APPROVED" }
        : fail("Only a request awaiting approval can be approved.");

    case "RETURN_FOR_CHANGES":
      return current === "AWAITING_APPROVAL"
        ? { ok: true, status: "DRAFT" }
        : fail("Only a request awaiting approval can be returned for changes.");

    case "EDIT":
      if (!isEditableStatus(current)) return fail("This request has been submitted. Its content can no longer be edited.");
      if (current === "APPROVED" || current === "SUBMISSION_FAILED") {
        return { ok: true, status: "DRAFT", invalidatesApproval: true };
      }
      return { ok: true, status: "DRAFT" };

    case "SUBMIT_SUCCEEDED":
      return current === "APPROVED" || current === "SUBMISSION_FAILED"
        ? { ok: true, status: "SUBMITTED" }
        : fail("Only an approved request can be submitted.");

    case "SUBMIT_FAILED":
      return current === "APPROVED" || current === "SUBMISSION_FAILED"
        ? { ok: true, status: "SUBMISSION_FAILED" }
        : fail("Only an approved request can be submitted.");

    case "RESPONSE_REVIEWED": {
      if (!isSentStatus(current)) return fail("Responses can only be recorded against a submitted request.");
      if (current === "COMPLETE_RESPONSE" || current === "REJECTED") return { ok: true, status: current };
      switch (event.responseType) {
        case "ACKNOWLEDGEMENT":
          // An acknowledgement never moves a request backwards and never completes it.
          return { ok: true, status: current === "SUBMITTED" ? "ACKNOWLEDGED" : (current as RequestStatus) };
        case "PARTIAL":
          return { ok: true, status: "PARTIAL_RESPONSE" };
        case "COMPLETE":
          return { ok: true, status: "COMPLETE_RESPONSE" };
        case "REJECTION":
          return { ok: true, status: "REJECTED" };
      }
    }
  }
}

export interface SubmissionReadinessInput {
  status: string;
  currentVersionNo: number;
  approvedVersionNo: number | null;
  approvedHash: string | null;
  currentHash: string;
  recipientVerification: string;
  needsReview: boolean;
  confirmed: boolean;
}

export function checkSubmissionReadiness(input: SubmissionReadinessInput): { ok: true } | { ok: false; reasons: string[] } {
  const reasons: string[] = [];
  if (input.status !== "APPROVED" && input.status !== "SUBMISSION_FAILED") {
    reasons.push("The request must be approved before it can be submitted.");
  } else {
    if (input.approvedVersionNo !== input.currentVersionNo) {
      reasons.push("The approved version is not the current version. Request approval for the current version.");
    }
    if (input.approvedHash !== input.currentHash) {
      reasons.push("The content changed after approval. Request approval again.");
    }
  }
  if (input.recipientVerification !== "VERIFIED") {
    reasons.push("The recipient route is not verified in the directory. Verify it in Settings before submitting.");
  }
  if (input.needsReview) {
    reasons.push("Source information changed after this draft was prepared. Review the draft and mark it as reviewed.");
  }
  if (!input.confirmed) {
    reasons.push("Confirm the final submission check before sending.");
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

export interface ApprovalPermissionInput {
  status: string;
  actorId: string;
  actorRole: string;
  versionAuthorId: string;
  requiredRole: string;
}

export function checkApprovalPermission(input: ApprovalPermissionInput): { ok: true } | { ok: false; reason: string } {
  if (input.status !== "AWAITING_APPROVAL") {
    return { ok: false, reason: "Only a request awaiting approval can be approved." };
  }
  if (input.requiredRole === "SUPERVISOR" && input.actorRole !== "SUPERVISOR") {
    return { ok: false, reason: "This route requires approval by a supervisor." };
  }
  if (input.actorId === input.versionAuthorId) {
    return { ok: false, reason: "You prepared this version. Another officer must approve it." };
  }
  return { ok: true };
}

export function suggestResponseTypeFromItems(itemStatuses: readonly string[]): ResponseType {
  const resolved = itemStatuses.filter((s) => s === "RECEIVED" || s === "NOT_PROVIDED").length;
  const anyReceived = itemStatuses.some((s) => s === "RECEIVED" || s === "PARTIAL");
  if (itemStatuses.length > 0 && resolved === itemStatuses.length) return "COMPLETE";
  return anyReceived ? "PARTIAL" : "ACKNOWLEDGEMENT";
}
