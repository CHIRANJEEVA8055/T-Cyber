import crypto from "node:crypto";
import { normalizeIdentifier, isMaskedValue } from "@/domain/identifiers";
import { bankFromIfsc } from "@/domain/providers";
import type { Db, Tx } from "../db";
import type { SessionUser } from "../auth/session";
import { loadCaseForUser } from "../auth/access";
import { recordAudit } from "../audit";
import { now } from "../clock";
import { AppError, notFoundError } from "../errors";
import { refreshRecommendationsTx } from "./tasks";
import { parseAttributes } from "./facts";
import { caseReference } from "./cases";

/**
 * Extraction review answers one question: "was this read correctly from the document?"
 * Applying reviewed candidates records facts as UNVERIFIED with their exact source location.
 * Substantive verification is a separate, later decision.
 */

const IDENTIFIER_FIELDS: Record<string, string> = {
  PHONE: "PHONE",
  EMAIL: "EMAIL",
  UPI_ID: "UPI_ID",
  WEBSITE: "WEBSITE",
  IP_ADDRESS: "IP_ADDRESS",
  BANK_ACCOUNT: "BANK_ACCOUNT",
  PLATFORM_PROFILE: "PLATFORM_PROFILE",
};

export const MANUAL_FIELDS = ["PERSON_NAME", "PHONE", "EMAIL", "UPI_ID", "WEBSITE", "IP_ADDRESS", "BANK_ACCOUNT", "PLATFORM_PROFILE"] as const;

export function locatorFor(c: { page: number | null; line: number | null; row: number | null }): string {
  if (c.row !== null && c.row !== undefined) return `row ${c.row}`;
  if (c.page !== null && c.page !== undefined) return `p. ${c.page}${c.line ? `, line ${c.line}` : ""}`;
  if (c.line !== null && c.line !== undefined) return `line ${c.line}`;
  return "document";
}

function partyRoleFrom(hint: string | null): string {
  const h = (hint ?? "").toLowerCase();
  if (h.startsWith("complainant")) return "COMPLAINANT";
  if (h.startsWith("victim")) return "VICTIM";
  if (h.startsWith("account holder")) return "ACCOUNT_HOLDER_ON_RECORD";
  if (h.startsWith("witness")) return "WITNESS";
  if (h.startsWith("person of interest")) return "PERSON_OF_INTEREST";
  return "OTHER";
}

async function loadCandidate(tx: Tx, user: SessionUser, candidateId: string) {
  const c = await tx.extractionCandidate.findUnique({ where: { id: candidateId } });
  if (!c) throw notFoundError("extraction candidate");
  await loadCaseForUser(tx, user, c.caseId, "write");
  return c;
}

export interface CandidateReviewInput {
  action: "ACCEPT" | "CORRECT" | "REJECT" | "RESET";
  correctedValue?: string | null;
  rejectReason?: string | null;
  roleHint?: string | null;
  label?: string | null;
  linkEntityId?: string | null;
}

export function reviewCandidate(db: Db, user: SessionUser, candidateId: string, input: CandidateReviewInput) {
  return db.$transaction(async (tx) => {
    const c = await loadCandidate(tx, user, candidateId);
    if (c.appliedAt) throw new AppError("This candidate has already been applied to the case. Correct the case record instead; history is kept.", "PRECONDITION");
    const structured = c.structuredJson ? (JSON.parse(c.structuredJson) as Record<string, unknown>) : {};
    if (input.label !== undefined) structured.officerLabel = input.label?.trim() || undefined;
    let linkedEntityId = c.linkedEntityId;
    if (input.linkEntityId !== undefined) {
      linkedEntityId = input.linkEntityId;
      if (linkedEntityId) {
        const target = await tx.entity.findUnique({ where: { id: linkedEntityId } });
        const expectedKind = c.field === "PERSON_NAME" ? "PERSON" : IDENTIFIER_FIELDS[c.field];
        if (!target || target.caseId !== c.caseId || target.kind !== expectedKind) {
          throw new AppError("Link only to a record of the same type in this case.", "VALIDATION", { linkEntityId: "Choose a matching record." });
        }
      }
    }
    const base = { reviewedById: user.id, reviewedAt: now(), structuredJson: Object.keys(structured).length ? JSON.stringify(structured) : null, linkedEntityId, roleHint: input.roleHint !== undefined ? input.roleHint?.trim() || null : c.roleHint };
    switch (input.action) {
      case "ACCEPT":
        return tx.extractionCandidate.update({ where: { id: c.id }, data: { ...base, status: c.status === "ADDED" ? "ADDED" : c.correctedValue ? "CORRECTED" : "ACCEPTED", rejectReason: null } });
      case "CORRECT": {
        const value = input.correctedValue?.trim() ?? "";
        if (!value) throw new AppError("Enter the corrected value.", "VALIDATION", { correctedValue: "Enter the corrected value." });
        if (value === c.originalValue) throw new AppError("The corrected value is the same as the original. Accept it instead.", "VALIDATION", { correctedValue: "Same as the original." });
        const kind = IDENTIFIER_FIELDS[c.field];
        return tx.extractionCandidate.update({
          where: { id: c.id },
          data: { ...base, status: "CORRECTED", correctedValue: value, normalizedValue: kind ? normalizeIdentifier(kind, value) : value, rejectReason: null },
        });
      }
      case "REJECT": {
        const reason = input.rejectReason?.trim() ?? "";
        if (reason.length < 3) throw new AppError("Give a reason for rejecting.", "VALIDATION", { rejectReason: "Give a reason for rejecting." });
        return tx.extractionCandidate.update({ where: { id: c.id }, data: { ...base, status: "REJECTED", rejectReason: reason } });
      }
      case "RESET":
        return tx.extractionCandidate.update({ where: { id: c.id }, data: { status: "PENDING", correctedValue: null, rejectReason: null, linkedEntityId: null, reviewedById: null, reviewedAt: null, normalizedValue: c.originalValue } });
    }
  });
}

/**
 * Confirms, in one step, every pending item the reader found clear: not flagged as uncertain,
 * incomplete or ambiguous, and not a person (people need a role and may need linking to a record the
 * officer already entered; names never merge). Those stay for individual review. Confirming records
 * that the value was read correctly from its cited line; it does not verify the fact.
 */
export function confirmClearCandidates(db: Db, user: SessionUser, evidenceId: string) {
  return db.$transaction(async (tx) => {
    const ev = await tx.evidenceItem.findUnique({ where: { id: evidenceId } });
    if (!ev) throw notFoundError("evidence item");
    await loadCaseForUser(tx, user, ev.caseId, "write");
    const clear = await tx.extractionCandidate.findMany({
      where: { evidenceId, status: "PENDING", appliedAt: null, uncertainty: { in: ["NONE", "MASKED"] }, field: { not: "PERSON_NAME" } },
      select: { id: true },
    });
    if (clear.length) {
      await tx.extractionCandidate.updateMany({ where: { id: { in: clear.map((c) => c.id) } }, data: { status: "ACCEPTED", reviewedById: user.id, reviewedAt: now(), rejectReason: null } });
    }
    const remaining = await tx.extractionCandidate.count({ where: { evidenceId, status: "PENDING" } });
    if (clear.length) {
      await recordAudit(tx, {
        caseId: ev.caseId,
        actorId: user.id,
        action: "extraction.bulk_confirmed",
        objectType: "EvidenceItem",
        objectId: evidenceId,
        summary: `${clear.length} items read clearly from ${ev.title} confirmed in one step; ${remaining} left for individual review`,
      });
    }
    return { confirmed: clear.length, remaining };
  });
}

export function addManualCandidate(
  db: Db,
  user: SessionUser,
  evidenceId: string,
  input: { field: string; value: string; page?: number | null; line?: number | null; row?: number | null; roleHint?: string | null },
) {
  return db.$transaction(async (tx) => {
    const ev = await tx.evidenceItem.findUnique({ where: { id: evidenceId } });
    if (!ev) throw notFoundError("evidence item");
    await loadCaseForUser(tx, user, ev.caseId, "write");
    if (!(MANUAL_FIELDS as readonly string[]).includes(input.field)) throw new AppError("Choose what kind of item this is.", "VALIDATION", { field: "Choose a type." });
    const value = input.value.trim();
    if (value.length < 2) throw new AppError("Enter the value exactly as it appears in the document.", "VALIDATION", { value: "Enter the value." });
    const segment = await tx.evidenceSegment.findFirst({
      where: { evidenceId, ...(input.page ? { page: input.page } : {}), ...(input.line ? { line: input.line } : {}), ...(input.row ? { row: input.row } : {}) },
    });
    if ((input.page || input.line || input.row) && !segment) {
      throw new AppError("That page/line does not exist in the extracted text. Check the location.", "VALIDATION", { line: "No text at this location." });
    }
    let run = await tx.extractionRun.findFirst({ where: { evidenceId }, orderBy: { createdAt: "desc" } });
    if (!run) run = await tx.extractionRun.create({ data: { caseId: ev.caseId, evidenceId, method: "MANUAL", status: "COMPLETED", note: "Manual additions only", createdById: user.id, createdAt: now() } });
    const kind = IDENTIFIER_FIELDS[input.field];
    return tx.extractionCandidate.create({
      data: {
        caseId: ev.caseId,
        runId: run.id,
        evidenceId,
        field: input.field,
        originalValue: value,
        normalizedValue: kind ? normalizeIdentifier(kind, value) : value,
        roleHint: input.roleHint?.trim() || null,
        roleHintBasis: input.roleHint ? "Entered by officer" : null,
        uncertainty: kind && isMaskedValue(value) ? "MASKED" : "NONE",
        page: segment?.page ?? input.page ?? null,
        line: segment?.line ?? input.line ?? null,
        row: segment?.row ?? input.row ?? null,
        excerpt: segment?.text ?? "Added manually by the officer (no text location given)",
        status: "ADDED",
        reviewedById: user.id,
        reviewedAt: now(),
        createdAt: now(),
      },
    });
  });
}

/** Cautious linking: only exact normalised identifier matches. People are never suggested by name. */
export async function suggestLinks(db: Db, user: SessionUser, candidateId: string) {
  const c = await db.extractionCandidate.findUnique({ where: { id: candidateId } });
  if (!c) throw notFoundError("extraction candidate");
  await loadCaseForUser(db, user, c.caseId, "read");
  const kind = IDENTIFIER_FIELDS[c.field];
  if (!kind) return [];
  const matches = await db.entity.findMany({ where: { caseId: c.caseId, kind, normalizedValue: c.normalizedValue } });
  return matches.map((m) => ({ id: m.id, label: m.label, value: m.value, kind: m.kind }));
}

async function bankForIfsc(tx: Tx, ifsc: string | null | undefined): Promise<string | null> {
  if (!ifsc || ifsc.length < 4) return null;
  const r = await tx.recipient.findFirst({ where: { ifscPrefix: ifsc.slice(0, 4).toUpperCase(), organisationType: "BANK" } });
  // The directory's own banks first (demonstration banks have their own codes); otherwise RBI's bank code.
  return r?.organisation ?? bankFromIfsc(ifsc);
}

export interface ApplyOptions {
  payerAccountEntityId?: string | null;
  claimId?: string | null;
}

export function applyReviewedCandidates(db: Db, user: SessionUser, evidenceId: string, opts: ApplyOptions) {
  return db.$transaction(async (tx) => {
    const ev = await tx.evidenceItem.findUnique({ where: { id: evidenceId } });
    if (!ev) throw notFoundError("evidence item");
    const kase = await loadCaseForUser(tx, user, ev.caseId, "write");
    const all = await tx.extractionCandidate.findMany({ where: { evidenceId }, orderBy: [{ page: "asc" }, { line: "asc" }, { row: "asc" }] });
    // Payment rows are applied last, after the accounts they refer to.
    const ready = all.filter((c) => ["ACCEPTED", "CORRECTED", "ADDED"].includes(c.status) && !c.appliedAt).sort((a, b) => Number(a.field === "TRANSACTION_ROW") - Number(b.field === "TRANSACTION_ROW"));
    const at = now();
    // Without a chosen payer, payments stated in the document are taken as made from the complainant's own
    // account stated in the same document (an FIR names it), once that account is applied.
    let payerId: string | null = opts.payerAccountEntityId ?? null;
    const documentPayer = payerId ? undefined : ready.find((c) => c.field === "BANK_ACCOUNT" && /complainant'?s own account|victim'?s (?:own )?account/i.test(c.roleHint ?? ""));
    const phase = ["FIR_COPY", "COMPLAINT", "TRANSACTION_RECORD"].includes(ev.category) ? 0 : ((await tx.entity.aggregate({ where: { caseId: ev.caseId }, _max: { discoveryPhase: true } }))._max.discoveryPhase ?? 0) + 1;

    if (ready.some((c) => c.field === "TRANSACTION_ROW")) {
      if (!payerId && !documentPayer) throw new AppError("Choose the account these payments were made from before applying the payment rows.", "VALIDATION", { payerAccountEntityId: "Choose the payer account." });
      if (payerId) {
        const payer = await tx.entity.findUnique({ where: { id: payerId } });
        if (!payer || payer.caseId !== ev.caseId) throw new AppError("Choose an account recorded in this case.", "VALIDATION", { payerAccountEntityId: "Choose an account from this case." });
      }
      if (opts.claimId) {
        const claim = await tx.victimClaim.findUnique({ where: { id: opts.claimId } });
        if (!claim || claim.caseId !== ev.caseId) throw new AppError("Choose a victim claim from this case.", "VALIDATION", { claimId: "Choose a claim from this case." });
      }
    }

    const sourceFor = async (c: (typeof all)[number], subjectType: string, subjectId: string, stance = "MENTIONS") => {
      const locator = locatorFor(c);
      const dedupeKey = `${subjectType}:${subjectId}:${evidenceId}:${locator}:${stance}`;
      await tx.sourceAssertion.upsert({
        where: { caseId_dedupeKey: { caseId: ev.caseId, dedupeKey } },
        create: { caseId: ev.caseId, evidenceId, page: c.page, row: c.row, line: c.line, locator, excerpt: c.excerpt, subjectType, subjectId, stance, dedupeKey, createdById: user.id, createdAt: at },
        update: {},
      });
    };

    let applied = 0;
    for (const c of ready) {
      const value = c.correctedValue ?? c.originalValue;
      const structured = c.structuredJson ? (JSON.parse(c.structuredJson) as Record<string, unknown>) : {};
      const refs: Record<string, string> = {};
      const kind = IDENTIFIER_FIELDS[c.field];
      if (kind) {
        let entityId = c.linkedEntityId;
        if (entityId) {
          const linked = await tx.entity.findUniqueOrThrow({ where: { id: entityId } });
          if (!linked.caseRole && c.roleHint) await tx.entity.update({ where: { id: entityId }, data: { caseRole: c.roleHint } });
        } else {
          const attributes: Record<string, unknown> = {};
          // A name the document gives for it, kept as stated (checked later against what a bank or provider records).
          if (typeof structured.statedName === "string") {
            attributes.statedName = structured.statedName;
            attributes.statedNameBasis = typeof structured.statedNameBasis === "string" ? structured.statedNameBasis : `As stated in ${ev.title}; not verified`;
          }
          if (kind === "BANK_ACCOUNT") {
            const sameLineIfsc = all.find((o) => o.field === "IFSC" && o.page === c.page && o.line === c.line && o.row === c.row);
            const ifsc = sameLineIfsc ? (sameLineIfsc.correctedValue ?? sameLineIfsc.originalValue) : null;
            // The IFSC decides the bank; without one, a bank the document names beside the account.
            const bank = (await bankForIfsc(tx, ifsc)) ?? (typeof structured.bank === "string" ? structured.bank : null);
            if (ifsc) attributes.ifsc = ifsc;
            if (bank) attributes.bank = bank;
            if (bank && !ifsc && typeof structured.bankBasis === "string") attributes.bankBasis = structured.bankBasis;
          }
          const normalizedValue = normalizeIdentifier(kind, value);
          const existing = await tx.entity.findUnique({ where: { caseId_kind_normalizedValue: { caseId: ev.caseId, kind, normalizedValue } } });
          if (existing) {
            entityId = existing.id;
            const merged = { ...attributes, ...parseAttributes(existing.attributesJson) };
            await tx.entity.update({ where: { id: existing.id }, data: { attributesJson: JSON.stringify(merged), caseRole: existing.caseRole ?? c.roleHint } });
          } else {
            const created = await tx.entity.create({
              data: {
                caseId: ev.caseId,
                kind,
                label: typeof structured.officerLabel === "string" ? structured.officerLabel : value,
                value,
                normalizedValue,
                attributesJson: JSON.stringify(attributes),
                caseRole: c.roleHint,
                isMasked: isMaskedValue(value),
                discoveredAt: at,
                discoveryPhase: phase,
                createdAt: at,
              },
            });
            entityId = created.id;
          }
        }
        await sourceFor(c, "ENTITY", entityId!);
        refs.entityId = entityId!;
        if (documentPayer && c.id === documentPayer.id) payerId = entityId;
      } else if (c.field === "PERSON_NAME") {
        let personId = c.linkedEntityId;
        if (!personId) {
          const person = await tx.entity.create({
            data: { caseId: ev.caseId, kind: "PERSON", label: typeof structured.officerLabel === "string" ? structured.officerLabel : value, value, normalizedValue: `person:${crypto.randomUUID()}`, discoveredAt: at, discoveryPhase: phase, createdAt: at },
          });
          personId = person.id;
        }
        const role = partyRoleFrom(c.roleHint);
        await tx.partyRole.upsert({
          where: { caseId_entityId_role: { caseId: ev.caseId, entityId: personId, role } },
          create: { caseId: ev.caseId, entityId: personId, role, basis: `${ev.title}, ${locatorFor(c)}`, createdAt: at },
          update: {},
        });
        await sourceFor(c, "ENTITY", personId);
        refs.entityId = personId;
      } else if (c.field === "TRANSACTION_ROW") {
        const s = structured;
        if (!s.amountMinor || !s.occurredAt || !s.counterpartyAccount) {
          throw new AppError(`Row ${c.row} cannot be applied: the amount, date or beneficiary account is missing. Correct or reject it first.`, "VALIDATION");
        }
        const beneficiaryValue = String(s.counterpartyAccount);
        const normalizedValue = normalizeIdentifier("BANK_ACCOUNT", beneficiaryValue);
        let beneficiary = await tx.entity.findUnique({ where: { caseId_kind_normalizedValue: { caseId: ev.caseId, kind: "BANK_ACCOUNT", normalizedValue } } });
        if (beneficiary) {
          const attrs = parseAttributes(beneficiary.attributesJson);
          const rowBank = (typeof s.counterpartyBank === "string" ? s.counterpartyBank : null) ?? (await bankForIfsc(tx, s.counterpartyIfsc as string | null));
          if ((!attrs.bank && rowBank) || (!attrs.ifsc && s.counterpartyIfsc)) {
            beneficiary = await tx.entity.update({
              where: { id: beneficiary.id },
              data: { attributesJson: JSON.stringify({ ...attrs, ...(attrs.bank || !rowBank ? {} : { bank: rowBank }), ...(attrs.ifsc || !s.counterpartyIfsc ? {} : { ifsc: s.counterpartyIfsc }) }) },
            });
          }
        }
        if (!beneficiary) {
          const bank = (typeof s.counterpartyBank === "string" ? s.counterpartyBank : null) ?? (await bankForIfsc(tx, s.counterpartyIfsc as string | null));
          beneficiary = await tx.entity.create({
            data: {
              caseId: ev.caseId,
              kind: "BANK_ACCOUNT",
              label: beneficiaryValue,
              value: beneficiaryValue,
              normalizedValue,
              attributesJson: JSON.stringify({ ...(bank ? { bank } : {}), ...(s.counterpartyIfsc ? { ifsc: s.counterpartyIfsc } : {}) }),
              caseRole: "Reported beneficiary account",
              isMasked: isMaskedValue(beneficiaryValue),
              discoveredAt: at,
              discoveryPhase: phase,
              createdAt: at,
            },
          });
        }
        const reference = typeof s.reference === "string" && s.reference ? s.reference : null;
        if (!payerId) throw new AppError("Choose the account these payments were made from before applying the payment rows.", "VALIDATION", { payerAccountEntityId: "Choose the payer account." });
        const dedupeKey = reference ? `REF:${reference.toUpperCase()}` : `ROW:${crypto.createHash("sha256").update(`${payerId}|${beneficiary.id}|${s.amountMinor}|${s.occurredAt}`).digest("hex")}`;
        const txn = await tx.transaction.upsert({
          where: { caseId_dedupeKey: { caseId: ev.caseId, dedupeKey } },
          create: {
            caseId: ev.caseId,
            fromEntityId: payerId,
            toEntityId: beneficiary.id,
            amountMinor: BigInt(String(s.amountMinor)),
            occurredAt: new Date(String(s.occurredAt)),
            channel: typeof s.channel === "string" && s.channel ? s.channel.toUpperCase() : "OTHER",
            reference,
            kind: "VICTIM_PAYMENT",
            layer: 1,
            claimId: opts.claimId ?? null,
            status: "REPORTED_BY_VICTIM",
            discoveredAt: at,
            discoveryPhase: phase,
            dedupeKey,
            createdAt: at,
          },
          update: {},
        });
        await sourceFor(c, "TRANSACTION", txn.id, "SUPPORTS");
        await sourceFor(c, "ENTITY", beneficiary.id);
        refs.transactionId = txn.id;
      } else if (c.field === "FIR_REFERENCE") {
        const s = structured as { number?: number; year?: number };
        if (kase.referenceType === "COMPLAINT" && !kase.firNumber && s.number && s.year) {
          const clash = await tx.case.findFirst({ where: { stationId: kase.stationId, firYear: s.year, firNumber: s.number } });
          if (clash) throw new AppError(`FIR ${s.number}/${s.year} already exists at this station. The complaint workspace was not converted.`, "CONFLICT");
          await tx.case.update({ where: { id: kase.id }, data: { referenceType: "FIR", firNumber: s.number, firYear: s.year, registeredAt: at, version: { increment: 1 } } });
          await recordAudit(tx, { caseId: kase.id, actorId: user.id, action: "case.fir_linked", objectType: "Case", objectId: kase.id, summary: `Complaint workspace linked to FIR ${s.number}/${s.year} from ${ev.title}` });
          refs.note = "Case reference updated from the document";
        } else if (s.number !== kase.firNumber || s.year !== kase.firYear) {
          await recordAudit(tx, { caseId: kase.id, actorId: user.id, action: "case.reference_discrepancy", objectType: "Case", objectId: kase.id, summary: `${ev.title} shows FIR ${value}, which differs from the case reference ${caseReference(kase)}. The case was not changed.` });
          refs.note = "Differs from the case reference; recorded as a discrepancy";
        } else refs.note = "Matches the case reference";
      } else {
        refs.note = "Reviewed as read correctly; no case record is created for this field";
      }
      await tx.extractionCandidate.update({ where: { id: c.id }, data: { appliedAt: at, appliedRefJson: JSON.stringify(refs) } });
      applied++;
    }

    const pending = await tx.extractionCandidate.count({ where: { evidenceId, status: "PENDING" } });
    await tx.evidenceItem.update({ where: { id: evidenceId }, data: { reviewStatus: pending === 0 ? "REVIEWED" : "IN_REVIEW" } });
    if (applied > 0) {
      await tx.processingEvent.create({ data: { at, evidenceId, step: "REVIEW_UPDATED", outcome: "OK", detail: `${applied} reviewed candidate(s) applied to the case by ${user.displayName}; ${pending} still pending review.`, actorId: user.id } });
      await recordAudit(tx, { caseId: ev.caseId, actorId: user.id, action: "extraction.applied", objectType: "EvidenceItem", objectId: evidenceId, summary: `${applied} reviewed item(s) from ${ev.title} added to the case`, detail: { applied, pending } });
      await refreshRecommendationsTx(tx, ev.caseId, user.id);
    }
    return { applied, pending };
  });
}
