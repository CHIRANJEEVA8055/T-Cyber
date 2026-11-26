"use server";

import { getDb } from "@/server/db";
import { describeImportedReply } from "@/server/services/import-summary";
import { applyCaseFileReading, type AppliedSummary } from "@/server/services/case-files";
import { withAutoDraft } from "@/server/services/auto-draft";
import { AppError } from "@/server/errors";
import { markOverviewSeen } from "@/server/services/case-home";
import { approveAndSend, parseToList, rescopeDraft, resyncGmailDraft, sendViaGmail } from "@/server/services/requests";
import { prepareDraftFromTask } from "@/server/services/drafting";
import { recordSplitDecision, type SplitMethod } from "@/server/services/allocation-decision";
import { addOfficerEntry, updateIdentifierNotes, updatePersonDetails, type BELONGS_TO } from "@/server/services/people";
import { logContact } from "@/server/services/contacts";
import { importInboxMessage } from "@/server/services/inbox";
import { applyReviewedCandidates, confirmClearCandidates } from "@/server/services/extraction";
import { runAction } from "@/features/shared/run-action";

export async function markOverviewSeenAction(caseId: string) {
  return runAction(async (user) => {
    await markOverviewSeen(getDb(), user, caseId);
    return null;
  });
}

/**
 * Approves and sends a draft from Next actions. When the officer narrowed what it asks for, the assistant's
 * version is re-rendered first, so the approval covers exactly what is sent.
 */
export async function approveAndSendAction(requestId: string, expectedVersion: number, keepItemIds: string[] | null, idempotencyKey: string) {
  return runAction(async (user) => {
    const db = getDb();
    let version = expectedVersion;
    if (keepItemIds) version = (await rescopeDraft(db, user, requestId, { expectedVersion, keepItemIds })).version;
    return approveAndSend(db, user, requestId, { expectedVersion: version, idempotencyKey });
  });
}

/**
 * Gmail delivery: approves the draft if it is not approved yet (never auto-sends), then sends the approved version
 * from the linked Gmail account to the address the officer typed.
 */
export async function sendFromGmailAction(requestId: string, expectedVersion: number, keepItemIds: string[] | null, to: string, idempotencyKey: string) {
  return runAction(async (user) => {
    const db = getDb();
    parseToList(to);
    let version = expectedVersion;
    if (keepItemIds) version = (await rescopeDraft(db, user, requestId, { expectedVersion, keepItemIds })).version;
    const before = await db.request.findUniqueOrThrow({ where: { id: requestId }, select: { status: true } });
    if (before.status === "DRAFT" || before.status === "AWAITING_APPROVAL") {
      await approveAndSend(db, user, requestId, { expectedVersion: version, idempotencyKey: `${idempotencyKey}:approve` });
      version = (await db.request.findUniqueOrThrow({ where: { id: requestId }, select: { version: true } })).version;
    }
    return sendViaGmail(db, user, requestId, { expectedVersion: version, to, idempotencyKey });
  });
}

export async function resyncGmailAction(requestId: string) {
  return runAction(async (user) => ({ outcome: await resyncGmailDraft(getDb(), user, requestId) }));
}

export async function rescopeDraftAction(requestId: string, expectedVersion: number, keepItemIds: string[]) {
  return runAction(async (user) => {
    const r = await rescopeDraft(getDb(), user, requestId, { expectedVersion, keepItemIds });
    return { version: r.version };
  });
}

/** The rules prepare the draft for a proposed request; the officer then approves the wording. */
export async function prepareAssistantDraftAction(taskId: string) {
  return runAction(async (user) => {
    const r = await prepareDraftFromTask(getDb(), user, taskId, { asAssistant: true });
    return { requestId: r.id, reference: r.reference };
  });
}

/** Drafts a proposed request in full with the addressee left blank, when the addressee cannot be found yet. */
export async function prepareDraftWithoutAddresseeAction(taskId: string) {
  return runAction(async (user) => {
    const r = await prepareDraftFromTask(getDb(), user, taskId, { asAssistant: true, withoutAddressee: true });
    return { requestId: r.id, reference: r.reference };
  });
}

export async function recordSplitAction(caseId: string, method: SplitMethod, note: string) {
  return runAction(async (user) => {
    if (!["PROPORTIONAL", "FIRST_IN_FIRST_OUT", "COURT"].includes(method)) throw new AppError("Choose one of the three routes.", "VALIDATION", { method: "Choose a route." });
    return recordSplitDecision(getDb(), user, caseId, { method, note });
  });
}

export async function addPeopleEntryAction(caseId: string, input: Parameters<typeof addOfficerEntry>[3]) {
  return runAction(async (user) => {
    const { result: e, autoDraft } = await withAutoDraft(getDb(), user, async () => caseId, () => addOfficerEntry(getDb(), user, caseId, input));
    return { id: e.id, autoDraft };
  });
}

export async function updateIdentifierNotesAction(entityId: string, input: { nickname?: string | null; belongsTo?: (typeof BELONGS_TO)[number] | null; bank?: string | null; ifsc?: string | null; provider?: string | null }) {
  return runAction(async (user) => {
    const { autoDraft } = await withAutoDraft(getDb(), user, async (e: { caseId: string }) => e.caseId, () => updateIdentifierNotes(getDb(), user, entityId, input));
    return { autoDraft };
  });
}

export async function updatePersonDetailsAction(entityId: string, input: Parameters<typeof updatePersonDetails>[3]) {
  return runAction(async (user) => {
    const r = await updatePersonDetails(getDb(), user, entityId, input);
    return { changed: r.changed, version: r.entity.updatedAt.toISOString() };
  });
}

export async function logContactAction(caseId: string, input: { victimEntityId: string; summary: string; nextDueAt: string | null; followUp: string | null }) {
  return runAction(async (user) => {
    const l = await logContact(getDb(), user, caseId, { ...input, channel: "CALL" });
    return { id: l.id };
  });
}

export async function importInboxReplyAction(caseId: string, messageId: string, requestId: string | null) {
  return runAction(async (user) => {
    const db = getDb();
    const res = await importInboxMessage(db, user, caseId, messageId, { requestId });
    return describeImportedReply(db, res.responseId);
  });
}

/**
 * "Confirm and open the case": confirms every detail that was read cleanly and applies all confirmed details of
 * the intake documents to the case. Uncertain details and names whose role is unchecked stay for the officer.
 */
export async function finishIntakeAction(caseId: string, evidenceIds: string[]) {
  return runAction(async (user) => {
    const db = getDb();
    let applied = 0;
    for (const id of evidenceIds) {
      await confirmClearCandidates(db, user, id);
      const ready = await db.extractionCandidate.count({ where: { evidenceId: id, caseId, status: { in: ["ACCEPTED", "CORRECTED", "ADDED"] }, appliedAt: null } });
      if (!ready) continue;
      // Payment rows need the account they were paid from. When the FIR does not state the complainant's own
      // account, it is recorded as "not stated" until a bank record names it (as when a case is typed in).
      const rows = await db.extractionCandidate.count({ where: { evidenceId: id, field: "TRANSACTION_ROW", status: { in: ["ACCEPTED", "CORRECTED"] }, appliedAt: null } });
      const statedPayer = await db.extractionCandidate.count({ where: { evidenceId: id, field: "BANK_ACCOUNT", status: { in: ["ACCEPTED", "CORRECTED", "ADDED"] }, roleHint: { contains: "own account" } } });
      let payerAccountEntityId: string | null = null;
      if (rows && !statedPayer) {
        const victim = await db.entity.findFirst({ where: { caseId, kind: "PERSON", partyRoles: { some: { role: "COMPLAINANT" } } }, orderBy: { createdAt: "asc" } }) ?? (await db.entity.findFirst({ where: { caseId, kind: "PERSON" }, orderBy: { createdAt: "asc" } }));
        if (victim) {
          const existing = await db.entity.findFirst({ where: { caseId, normalizedValue: `NOTSTATED:${victim.id}` } });
          payerAccountEntityId = (existing ?? (await db.entity.create({ data: { caseId, kind: "BANK_ACCOUNT", label: `${victim.label}'s account (not stated)`, value: `NOT STATED ${victim.label}`, normalizedValue: `NOTSTATED:${victim.id}`, caseRole: "Complainant's own account; the number is not in the FIR", attributesJson: JSON.stringify({ isVictimAccount: true, numberNotStated: true }), belongsTo: "VICTIM", discoveredAt: new Date() } }))).id;
        }
      }
      const claim = payerAccountEntityId ? await db.victimClaim.findFirst({ where: { caseId, status: "ACTIVE" }, orderBy: { createdAt: "asc" } }) : null;
      await applyReviewedCandidates(db, user, id, { payerAccountEntityId, claimId: claim?.id ?? null });
      applied += ready;
    }
    const left = await db.extractionCandidate.count({ where: { caseId, evidenceId: { in: evidenceIds }, status: "PENDING" } });
    return { applied, left };
  });
}

/**
 * "Add to the case" for files read in the case window: each reading's chosen items are added, one file at a time, so
 * a problem with one file does not hold back the others. Returns what was added from each.
 */
export async function applyCaseFilesAction(items: { readingId: string; keys: string[] }[]) {
  return runAction(async (user) => {
    if (!Array.isArray(items) || items.length === 0 || items.length > 10) throw new AppError("Choose between 1 and 10 files to add.", "VALIDATION");
    const db = getDb();
    const out: { readingId: string; ok: boolean; summary?: AppliedSummary; error?: string }[] = [];
    for (const i of items) {
      if (typeof i?.readingId !== "string" || !Array.isArray(i.keys) || i.keys.some((k) => typeof k !== "string")) throw new AppError("The list of items to add is not valid.", "VALIDATION");
      try {
        out.push({ readingId: i.readingId, ok: true, summary: await applyCaseFileReading(db, user, i.readingId, i.keys.slice(0, 2000)) });
      } catch (err) {
        out.push({ readingId: i.readingId, ok: false, error: err instanceof AppError ? err.message : "This file could not be added; nothing from it was changed." });
      }
    }
    return out;
  });
}

/** The case's whole context (facts, money trail, mails and replies, pending, files), built fresh when it is opened. */
export async function loadCaseContextAction(caseId: string) {
  return runAction(async (user) => {
    const { getCaseContext } = await import("@/server/services/case-context");
    return getCaseContext(getDb(), user, caseId);
  }, { refresh: false });
}
