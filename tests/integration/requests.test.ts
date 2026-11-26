import { describe, expect, it } from "vitest";
import { buildWorld } from "../support/fixtures";
import {
  createDraft,
  updateDraft,
  requestApproval,
  approveRequest,
  submitRequest,
  recordPortalSubmission,
  flagDraftsForReview,
  markDraftReviewed,
} from "@/server/services/requests";
import { getRequestDetail } from "@/server/services/correspondence";

async function draft(w: Awaited<ReturnType<typeof buildWorld>>, overrides: Partial<Parameters<typeof createDraft>[2]> = {}) {
  return createDraft(w.db, w.officer, {
    caseId: w.kase.id,
    category: "HOLD",
    recipientId: w.recipient.id,
    subject: "Debit freeze request: Account XXXXXXXX4821",
    body: "Please freeze the account and confirm the amount held.",
    scope: "Debit freeze on XXXXXXXX4821",
    periodFrom: null,
    periodTo: null,
    items: [{ label: "Confirmation of hold", itemType: "HOLD_CONFIRMATION" }],
    subjectEntityIds: [w.account.id],
    ...overrides,
  });
}

async function approved(w: Awaited<ReturnType<typeof buildWorld>>) {
  const r = await draft(w);
  const a = await requestApproval(w.db, w.officer, r.id, r.version);
  return approveRequest(w.db, w.supervisor, r.id, a.version, "Approved");
}

describe("sent requests keep their history", () => {
  it("keeps the address a request was sent to after the directory address changes", async () => {
    const w = await buildWorld();
    const a = await approved(w);
    const sentAddress = (await w.db.recipient.findUniqueOrThrow({ where: { id: w.recipient.id } })).address;
    const res = await submitRequest(w.db, w.officer, a.id, { expectedVersion: a.version, confirmed: true, idempotencyKey: "sent-address-1" });
    expect(res.outcome).toBe("SUCCEEDED");
    await w.db.recipient.update({ where: { id: w.recipient.id }, data: { address: "changed-desk@bank.example.invalid" } });
    const d = await getRequestDetail(w.db, w.officer, a.id);
    expect(d.sentTo).toMatchObject({ address: sentAddress });
    expect(d.recipient.address).toBe("changed-desk@bank.example.invalid");
  });
});

describe("request drafts and approval", () => {
  it("creates a draft with a reference, version 1 and a content hash", async () => {
    const w = await buildWorld();
    const r = await draft(w);
    expect(r.reference).toMatch(/^[PRHU]\.REQ-\d+\/\d{4}-001$/);
    expect(r.status).toBe("DRAFT");
    const versions = await w.db.requestVersion.findMany({ where: { requestId: r.id } });
    expect(versions).toHaveLength(1);
    expect(versions[0]?.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("detects a duplicate active request for the same subject and category", async () => {
    const w = await buildWorld();
    await draft(w);
    await expect(draft(w)).rejects.toThrow(/already active/i);
    const second = await draft(w, { allowDuplicateReason: "Different period requested by supervisor" });
    expect(second.status).toBe("DRAFT");
  });

  it("refuses access to officers not assigned to the case", async () => {
    const w = await buildWorld();
    await expect(createDraft(w.db, w.outsider, { caseId: w.kase.id, category: "HOLD", recipientId: w.recipient.id, subject: "x", body: "y", scope: "z", periodFrom: null, periodTo: null, items: [], subjectEntityIds: [] })).rejects.toThrow(/does not exist or you do not have access/);
  });

  it("binds approval to the exact version and invalidates it when the content is edited", async () => {
    const w = await buildWorld();
    const ok = await approved(w);
    expect(ok.status).toBe("APPROVED");
    expect(ok.approvedVersionNo).toBe(1);

    const edited = await updateDraft(w.db, w.officer, ok.id, {
      expectedVersion: ok.version,
      recipientId: w.recipient.id,
      subject: ok.subject,
      body: "Please freeze the account and confirm the amount held. Also confirm the time of the balance.",
      scope: "Debit freeze on XXXXXXXX4821",
      periodFrom: null,
      periodTo: null,
      items: [{ label: "Confirmation of hold", itemType: "HOLD_CONFIRMATION" }],
      attachmentIds: [],
    });
    expect(edited.status).toBe("DRAFT");
    expect(edited.approvedVersionNo).toBeNull();
    expect(edited.currentVersionNo).toBe(2);
    const approvals = await w.db.approval.findMany({ where: { requestId: ok.id } });
    expect(approvals[0]?.invalidatedAt).not.toBeNull();
  });

  it("rejects stale edits made against an older version", async () => {
    const w = await buildWorld();
    const r = await draft(w);
    await requestApproval(w.db, w.officer, r.id, r.version);
    await expect(
      updateDraft(w.db, w.officer, r.id, { expectedVersion: r.version, recipientId: w.recipient.id, subject: "changed", body: "b", scope: "s", periodFrom: null, periodTo: null, items: [], attachmentIds: [] }),
    ).rejects.toThrow(/changed by someone else/i);
  });

  it("does not let the author approve their own version", async () => {
    const w = await buildWorld();
    const r = await draft(w);
    const a = await requestApproval(w.db, w.officer, r.id, r.version);
    await expect(approveRequest(w.db, w.officer, r.id, a.version, "self")).rejects.toThrow(/supervisor|another officer/i);
  });
});

describe("simulated submission", () => {
  it("requires final confirmation and records the simulated reference", async () => {
    const w = await buildWorld();
    const r = await approved(w);
    await expect(submitRequest(w.db, w.officer, r.id, { expectedVersion: r.version, confirmed: false, idempotencyKey: "k0" })).rejects.toThrow(/confirm/i);
    const res = await submitRequest(w.db, w.officer, r.id, { expectedVersion: r.version, confirmed: true, idempotencyKey: "k1" });
    expect(res.outcome).toBe("SUCCEEDED");
    const after = await w.db.request.findUniqueOrThrow({ where: { id: r.id } });
    expect(after.status).toBe("SUBMITTED");
    expect(after.externalReference).toMatch(/^SIM-EMAIL-/);
    expect(after.followUpAt).not.toBeNull();
  });

  it("is idempotent for a repeated submission key", async () => {
    const w = await buildWorld();
    const r = await approved(w);
    const first = await submitRequest(w.db, w.officer, r.id, { expectedVersion: r.version, confirmed: true, idempotencyKey: "same" });
    const again = await submitRequest(w.db, w.officer, r.id, { expectedVersion: r.version, confirmed: true, idempotencyKey: "same" });
    expect(again.submissionId).toBe(first.submissionId);
    expect(await w.db.submission.count({ where: { requestId: r.id } })).toBe(1);
  });

  it("records a failed simulated submission and allows a retry", async () => {
    const w = await buildWorld();
    await w.db.integrationSetting.update({ where: { key: "EMAIL_GATEWAY" }, data: { failNextSubmission: true } });
    const r = await approved(w);
    const failed = await submitRequest(w.db, w.officer, r.id, { expectedVersion: r.version, confirmed: true, idempotencyKey: "f1" });
    expect(failed.outcome).toBe("FAILED");
    const mid = await w.db.request.findUniqueOrThrow({ where: { id: r.id } });
    expect(mid.status).toBe("SUBMISSION_FAILED");
    const retry = await submitRequest(w.db, w.officer, r.id, { expectedVersion: mid.version, confirmed: true, idempotencyKey: "f2" });
    expect(retry.outcome).toBe("SUCCEEDED");
  });

  it("blocks submission to an unverified recipient", async () => {
    const w = await buildWorld();
    const r = await draft(w, { recipientId: w.unverified.id });
    const a = await requestApproval(w.db, w.officer, r.id, r.version);
    const ap = await approveRequest(w.db, w.supervisor, r.id, a.version, "ok");
    await expect(submitRequest(w.db, w.officer, r.id, { expectedVersion: ap.version, confirmed: true, idempotencyKey: "u1" })).rejects.toThrow(/not verified/i);
  });

  it("blocks submission while the draft is flagged for renewed review", async () => {
    const w = await buildWorld();
    const r = await approved(w);
    await flagDraftsForReview(w.db, w.kase.id, [w.account.id], "Bank response changed the account facts");
    const flagged = await w.db.request.findUniqueOrThrow({ where: { id: r.id } });
    expect(flagged.needsReview).toBe(true);
    await expect(submitRequest(w.db, w.officer, r.id, { expectedVersion: flagged.version, confirmed: true, idempotencyKey: "n1" })).rejects.toThrow(/review/i);
    const cleared = await markDraftReviewed(w.db, w.officer, r.id, flagged.version, "Checked; still accurate");
    const ok = await submitRequest(w.db, w.officer, r.id, { expectedVersion: cleared.version, confirmed: true, idempotencyKey: "n2" });
    expect(ok.outcome).toBe("SUCCEEDED");
  });

  it("records portal work as an external submission with the officer's reference", async () => {
    const w = await buildWorld();
    const r = await draft(w, { category: "PRESERVATION", recipientId: w.portal.id, items: [{ label: "Preservation", itemType: "PRESERVATION_CONFIRMATION" }] });
    const a = await requestApproval(w.db, w.officer, r.id, r.version);
    const ap = await approveRequest(w.db, w.supervisor, r.id, a.version, "ok");
    await expect(submitRequest(w.db, w.officer, r.id, { expectedVersion: ap.version, confirmed: true, idempotencyKey: "p0" })).rejects.toThrow(/portal/i);
    await recordPortalSubmission(w.db, w.officer, r.id, { expectedVersion: ap.version, confirmed: true, portalReference: "LEPORTAL-123" });
    const after = await w.db.request.findUniqueOrThrow({ where: { id: r.id } });
    expect(after.status).toBe("SUBMITTED");
    expect(after.externalReference).toBe("LEPORTAL-123");
  });
});

describe("per-case request numbers", () => {
  it("numbers each case's requests from 1, in the order they are created", async () => {
    const w = await buildWorld();
    const first = await draft(w);
    const second = await draft(w, { category: "INFORMATION", subject: "Statement request", items: [{ label: "Statement", itemType: "STATEMENT" }] });
    const other = await buildWorld();
    const elsewhere = await draft(other);
    const seq = async (id: string) => (await w.db.request.findUniqueOrThrow({ where: { id } })).caseSeq;
    expect(await seq(first.id)).toBe(1);
    expect(await seq(second.id)).toBe(2);
    expect(await seq(elsewhere.id)).toBe(1);
  });

  it("gives a reminder no number of its own: it is shown as its parent's reminder", async () => {
    const w = await buildWorld();
    const first = await draft(w);
    const reminder = await draft(w, { parentRequestId: first.id, subject: "Reminder: outstanding items" });
    const next = await draft(w, { category: "INFORMATION", subject: "Statement request", items: [{ label: "Statement", itemType: "STATEMENT" }] });
    const seq = async (id: string) => (await w.db.request.findUniqueOrThrow({ where: { id } })).caseSeq;
    expect(await seq(reminder.id)).toBeNull();
    expect(await seq(next.id)).toBe(2);
  });
});
