import { describe, expect, it } from "vitest";
import {
  nextRequestStatus,
  isEditableStatus,
  checkSubmissionReadiness,
  checkApprovalPermission,
  suggestResponseTypeFromItems,
} from "@/domain/request-workflow";

describe("nextRequestStatus", () => {
  it("moves a draft to awaiting approval and then approved", () => {
    expect(nextRequestStatus("DRAFT", { type: "REQUEST_APPROVAL" })).toEqual({ ok: true, status: "AWAITING_APPROVAL" });
    expect(nextRequestStatus("AWAITING_APPROVAL", { type: "APPROVE" })).toEqual({ ok: true, status: "APPROVED" });
  });

  it("returns a request to draft when the approver sends it back", () => {
    expect(nextRequestStatus("AWAITING_APPROVAL", { type: "RETURN_FOR_CHANGES" })).toEqual({ ok: true, status: "DRAFT" });
  });

  it("invalidates approval when approved content is edited", () => {
    const result = nextRequestStatus("APPROVED", { type: "EDIT" });
    expect(result).toEqual({ ok: true, status: "DRAFT", invalidatesApproval: true });
  });

  it("refuses to submit anything that has not been approved", () => {
    expect(nextRequestStatus("DRAFT", { type: "SUBMIT_SUCCEEDED" }).ok).toBe(false);
    expect(nextRequestStatus("AWAITING_APPROVAL", { type: "SUBMIT_SUCCEEDED" }).ok).toBe(false);
  });

  it("records failed simulated submissions and allows a retry", () => {
    expect(nextRequestStatus("APPROVED", { type: "SUBMIT_FAILED" })).toEqual({ ok: true, status: "SUBMISSION_FAILED" });
    expect(nextRequestStatus("SUBMISSION_FAILED", { type: "SUBMIT_SUCCEEDED" })).toEqual({ ok: true, status: "SUBMITTED" });
  });

  it("does not allow edits once a request has been submitted", () => {
    expect(nextRequestStatus("SUBMITTED", { type: "EDIT" }).ok).toBe(false);
    expect(isEditableStatus("SUBMITTED")).toBe(false);
    expect(isEditableStatus("SUBMISSION_FAILED")).toBe(true);
  });

  it("treats an acknowledgement as distinct from a completed response", () => {
    expect(nextRequestStatus("SUBMITTED", { type: "RESPONSE_REVIEWED", responseType: "ACKNOWLEDGEMENT" })).toEqual({
      ok: true,
      status: "ACKNOWLEDGED",
    });
    expect(nextRequestStatus("ACKNOWLEDGED", { type: "RESPONSE_REVIEWED", responseType: "PARTIAL" })).toEqual({
      ok: true,
      status: "PARTIAL_RESPONSE",
    });
  });

  it("keeps a partial response open until a complete response arrives", () => {
    expect(nextRequestStatus("PARTIAL_RESPONSE", { type: "RESPONSE_REVIEWED", responseType: "PARTIAL" })).toEqual({
      ok: true,
      status: "PARTIAL_RESPONSE",
    });
    expect(nextRequestStatus("PARTIAL_RESPONSE", { type: "RESPONSE_REVIEWED", responseType: "ACKNOWLEDGEMENT" })).toEqual({
      ok: true,
      status: "PARTIAL_RESPONSE",
    });
    expect(nextRequestStatus("PARTIAL_RESPONSE", { type: "RESPONSE_REVIEWED", responseType: "COMPLETE" })).toEqual({
      ok: true,
      status: "COMPLETE_RESPONSE",
    });
  });

  it("records a rejection from the recipient", () => {
    expect(nextRequestStatus("SUBMITTED", { type: "RESPONSE_REVIEWED", responseType: "REJECTION" })).toEqual({
      ok: true,
      status: "REJECTED",
    });
  });

  it("does not accept responses for requests that were never submitted", () => {
    expect(nextRequestStatus("DRAFT", { type: "RESPONSE_REVIEWED", responseType: "COMPLETE" }).ok).toBe(false);
  });
});

describe("checkSubmissionReadiness", () => {
  const ready = {
    status: "APPROVED",
    currentVersionNo: 2,
    approvedVersionNo: 2,
    approvedHash: "abc",
    currentHash: "abc",
    recipientVerification: "VERIFIED",
    needsReview: false,
    confirmed: true,
  } as const;

  it("allows submission of the exact approved version to a verified recipient after confirmation", () => {
    expect(checkSubmissionReadiness(ready)).toEqual({ ok: true });
  });

  it("blocks submission when the content changed after approval", () => {
    const result = checkSubmissionReadiness({ ...ready, currentHash: "changed" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons.join(" ")).toMatch(/changed after approval/i);
  });

  it("blocks submission when the approved version is not the current version", () => {
    expect(checkSubmissionReadiness({ ...ready, currentVersionNo: 3 }).ok).toBe(false);
  });

  it("blocks submission to an unverified recipient route", () => {
    const result = checkSubmissionReadiness({ ...ready, recipientVerification: "UNVERIFIED" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons.join(" ")).toMatch(/not verified/i);
  });

  it("blocks submission while the draft is flagged for renewed review", () => {
    expect(checkSubmissionReadiness({ ...ready, needsReview: true }).ok).toBe(false);
  });

  it("requires the officer's final confirmation", () => {
    expect(checkSubmissionReadiness({ ...ready, confirmed: false }).ok).toBe(false);
  });

  it("blocks submission from draft status", () => {
    expect(checkSubmissionReadiness({ ...ready, status: "DRAFT" }).ok).toBe(false);
  });
});

describe("checkApprovalPermission", () => {
  const base = { status: "AWAITING_APPROVAL", actorId: "sup", actorRole: "SUPERVISOR", versionAuthorId: "io", requiredRole: "SUPERVISOR" } as const;

  it("lets a supervisor approve another officer's version", () => {
    expect(checkApprovalPermission(base)).toEqual({ ok: true });
  });

  it("does not let an officer approve where supervisor approval is required", () => {
    expect(checkApprovalPermission({ ...base, actorId: "io2", actorRole: "OFFICER" }).ok).toBe(false);
  });

  it("does not let anyone approve their own version", () => {
    expect(checkApprovalPermission({ ...base, versionAuthorId: "sup" }).ok).toBe(false);
  });

  it("only approves requests that are awaiting approval", () => {
    expect(checkApprovalPermission({ ...base, status: "DRAFT" }).ok).toBe(false);
  });
});

describe("suggestResponseTypeFromItems", () => {
  it("suggests complete only when every requested item is resolved", () => {
    expect(suggestResponseTypeFromItems(["RECEIVED", "RECEIVED", "NOT_PROVIDED"])).toBe("COMPLETE");
  });

  it("suggests partial when any requested item is still outstanding", () => {
    expect(suggestResponseTypeFromItems(["RECEIVED", "PENDING"])).toBe("PARTIAL");
    expect(suggestResponseTypeFromItems(["PARTIAL", "RECEIVED"])).toBe("PARTIAL");
  });

  it("suggests acknowledgement when nothing has been received", () => {
    expect(suggestResponseTypeFromItems(["PENDING", "PENDING"])).toBe("ACKNOWLEDGEMENT");
  });
});
