"use server";

import { getDb } from "@/server/db";
import { AppError } from "@/server/errors";
import { istInputToUtc } from "@/domain/time";
import { addRequestNote, approveRequest, handOverToIo, markDraftReviewed, recordForwarded, recordPortalSubmission, requestApproval, returnForChanges, submitRequest, updateDraft } from "@/server/services/requests";
import { applyResponse, confirmResponseMatch, decideFinding, type FindingPayload } from "@/server/services/responses";
import { withAutoDraft } from "@/server/services/auto-draft";
import { setMailDefaults } from "@/server/services/mail-defaults";
import { runAction } from "@/features/shared/run-action";
import { kickGmailSync } from "@/server/gmail/runner";
import type { ResponseType } from "@/domain/request-workflow";

function day(value: string, end: boolean, field: string): Date | null {
  if (!value) return null;
  const d = istInputToUtc(`${value}T${end ? "23:59:59" : "00:00"}`);
  if (!d) throw new AppError("Enter a valid date.", "VALIDATION", { [field]: "Enter a valid date." });
  return d;
}

export interface DraftForm {
  expectedVersion: number;
  recipientId: string;
  subject: string;
  body: string;
  scope: string;
  periodFrom: string;
  periodTo: string;
  items: { label: string; itemType: string }[];
  attachmentIds: string[];
  changeNote: string;
  /** The mailbox it is sent from. */
  fromAddress: string;
}

export async function updateDraftAction(requestId: string, form: DraftForm) {
  return runAction(async (user) => {
    const periodFrom = day(form.periodFrom, false, "periodFrom");
    const periodTo = day(form.periodTo, true, "periodTo");
    if (periodFrom && periodTo && periodTo < periodFrom) throw new AppError("The period must end after it starts.", "VALIDATION", { periodTo: "Choose an end date after the start date." });
    const items = form.items.map((i) => ({ label: i.label.trim(), itemType: i.itemType })).filter((i) => i.label);
    if (items.length === 0) throw new AppError("List at least one requested item.", "VALIDATION", { items: "List at least one requested item." });
    const r = await updateDraft(getDb(), user, requestId, { ...form, periodFrom, periodTo, items, changeNote: form.changeNote.trim() || null });
    // Gmail link: carry the edit to the Gmail draft now, not at the next pass.
    kickGmailSync(requestId);
    return { version: r.version, currentVersionNo: r.currentVersionNo, status: r.status };
  });
}

/** Makes a From address and/or closing the officer's default for new drafts (null returns to the station's). */
export async function setMailDefaultsAction(input: { fromAddress?: string | null; closing?: string | null }) {
  return runAction(async (user) => {
    const m = await setMailDefaults(getDb(), user, input);
    return { from: m.from, closing: m.closing };
  });
}

export async function requestApprovalAction(requestId: string, expectedVersion: number) {
  return runAction(async (user) => {
    await requestApproval(getDb(), user, requestId, expectedVersion);
    return null;
  });
}

export async function approveRequestAction(requestId: string, expectedVersion: number, note: string) {
  return runAction(async (user) => {
    await approveRequest(getDb(), user, requestId, expectedVersion, note.trim() || null);
    return null;
  });
}

export async function returnForChangesAction(requestId: string, expectedVersion: number, note: string) {
  return runAction(async (user) => {
    await returnForChanges(getDb(), user, requestId, expectedVersion, note);
    return null;
  });
}

export async function submitRequestAction(requestId: string, expectedVersion: number, idempotencyKey: string) {
  return runAction(async (user) => submitRequest(getDb(), user, requestId, { expectedVersion, confirmed: true, idempotencyKey }));
}

/** v1: mail the approved request to the PS IO's mailbox to forward. */
export async function mailToIoAction(requestId: string, expectedVersion: number, idempotencyKey: string) {
  return runAction(async (user) => handOverToIo(getDb(), user, requestId, { expectedVersion, idempotencyKey }));
}

/** The IO forwarded it from their own mailbox: record when (IST, "YYYY-MM-DDTHH:mm"; now when empty). */
export async function recordForwardedAction(requestId: string, expectedVersion: number, forwardedAt: string | null, note: string | null) {
  return runAction(async (user) => {
    await recordForwarded(getDb(), user, requestId, { expectedVersion, forwardedAt, note });
    return null;
  });
}

export async function recordPortalSubmissionAction(requestId: string, expectedVersion: number, portalReference: string) {
  return runAction(async (user) => {
    await recordPortalSubmission(getDb(), user, requestId, { expectedVersion, confirmed: true, portalReference });
    return null;
  });
}

export async function markDraftReviewedAction(requestId: string, expectedVersion: number, note: string) {
  return runAction(async (user) => {
    await markDraftReviewed(getDb(), user, requestId, expectedVersion, note);
    return null;
  });
}

export async function addRequestNoteAction(requestId: string, body: string) {
  return runAction(async (user) => {
    await addRequestNote(getDb(), user, requestId, body);
    return null;
  });
}

export async function decideFindingAction(findingId: string, decision: "ACCEPTED" | "EDITED" | "REJECTED" | "DEFERRED" | "PENDING", reason: string | null, editedPayload: FindingPayload | null) {
  return runAction(async (user) => {
    await decideFinding(getDb(), user, findingId, { decision, reason, editedPayload });
    return null;
  });
}

export async function applyResponseAction(responseId: string, responseType: ResponseType, expectedVersion: number) {
  return runAction(async (user) => {
    const db = getDb();
    const { result, autoDraft } = await withAutoDraft(
      db,
      user,
      // Applied responses are always matched to a case; an empty id simply finds nothing to draft.
      async () => (await db.response.findUniqueOrThrow({ where: { id: responseId }, select: { caseId: true } })).caseId ?? "",
      () => applyResponse(db, user, responseId, { responseType, expectedVersion }),
    );
    return { ...result, autoDraft };
  });
}

export async function confirmMatchAction(responseId: string, requestId: string) {
  return runAction(async (user) => {
    await confirmResponseMatch(getDb(), user, responseId, requestId);
    return null;
  });
}
