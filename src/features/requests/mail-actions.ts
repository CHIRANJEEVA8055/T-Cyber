"use server";

import { getDb } from "@/server/db";
import { runAction } from "@/features/shared/run-action";
import { commitMailDraft, createOfficerMail, discardOfficerMail, getMailView, getNewMailView, saveMailDraft, sendMailNow, type MailSaveInput } from "@/server/services/mail-window";

/** The mail window's contents, as they are now. */
export async function loadMailAction(requestId: string) {
  return runAction((user) => getMailView(getDb(), user, requestId), { refresh: false });
}

/** A new mail's window before anything is saved (nothing is stored until something is typed). */
export async function loadNewMailAction(caseId: string) {
  return runAction((user) => getNewMailView(getDb(), user, caseId), { refresh: false });
}

/** Saves the window as the officer types (no page refresh: the window keeps its own state). */
export async function saveMailAction(requestId: string, input: MailSaveInput) {
  return runAction((user) => saveMailDraft(getDb(), user, requestId, input), { refresh: false });
}

/** The first save of a new mail: it becomes one of the case's requests, with its own reference. */
export async function createMailAction(caseId: string, input: { to: string; subject: string; body: string; attachmentIds: string[] }) {
  return runAction((user) => createOfficerMail(getDb(), user, caseId, input), { refresh: false });
}

/** The window closed: what was typed becomes a version (and goes to the Gmail draft). */
export async function commitMailAction(requestId: string) {
  return runAction((user) => commitMailDraft(getDb(), requestId, { by: user }));
}

/** Send: every field is checked on the server; the fields to fix come back by name when any is not right. */
export async function sendMailAction(requestId: string, expectedVersion: number, baseKey: string, idempotencyKey: string) {
  return runAction((user) => sendMailNow(getDb(), user, requestId, { expectedVersion, baseKey, idempotencyKey }));
}

export async function discardMailAction(requestId: string) {
  return runAction((user) => discardOfficerMail(getDb(), user, requestId));
}
