import { recordNameCheck, statedNameCheck } from "./stated-names";
import type { Generate } from "../ai/grounded";
import { readReplyWithModel } from "./reply-reader";
import { bankFromIfsc, isVictimOwned } from "@/domain/providers";
import crypto from "node:crypto";
import { now } from "../clock";
import { extractFromTable, parseCsv, type ExtractedCandidate } from "@/domain/extraction";
import { normalizeIdentifier, isMaskedValue, shownId } from "@/domain/identifiers";
import { formatInr, parseRupeesToMinor } from "@/domain/money";
import { nextRequestStatus, suggestResponseTypeFromItems, type ResponseType } from "@/domain/request-workflow";
import { formatDateIST, formatDateTimeIST, istInputToUtc, utcToIstDateInput } from "@/domain/time";
import type { Db, Tx } from "../db";
import type { SessionUser } from "../auth/session";
import { loadCaseForUser } from "../auth/access";
import { recordAudit } from "../audit";
import { AppError, conflictError, notFoundError } from "../errors";
import { insertEvidenceTx, prepareEvidence, type PreparedEvidence } from "./evidence";
import { createDraftTx, flagDraftsForReviewTx } from "./requests";
import { mailDefaultsFor } from "./mail-defaults";
import { withClosing } from "@/domain/closing";
import { refreshRecommendationsTx } from "./tasks";
import { parseAttributes } from "./facts";
import { renderTemplate } from "./templates";
import { getAppConfig } from "../config";
import type { Prisma } from "@/generated/prisma/client";
import { assistantAuthorId } from "../assistant-identity";
import { rankRequestsFor } from "./inbox";
import { recomputeLayersTx } from "./layers";
import { quotedRequestRefs, refVariants } from "@/domain/request-ref";

/**
 * Incoming responses are untrusted data. Their text is only pattern-matched for facts that the
 * officer then reviews; no instruction contained in a message or attachment is ever executed.
 */

export interface IncomingMessage {
  fromAddress: string;
  toAddress: string;
  subject: string;
  receivedAt: Date;
  bodyText: string;
  channel: "EMAIL" | "PORTAL_DOWNLOAD" | "MANUAL_IMPORT";
  attachments: { fileName: string; buffer: Buffer }[];
}

export type FindingPayload = Record<string, unknown>;

const sha = (s: string | Buffer) => crypto.createHash("sha256").update(s).digest("hex");
const domainOf = (address: string) => (address.split("@")[1] ?? "").trim().toLowerCase();

export function fingerprintMessage(msg: IncomingMessage): string {
  return sha(
    JSON.stringify({
      from: msg.fromAddress.trim().toLowerCase(),
      subject: msg.subject.trim(),
      receivedAt: msg.receivedAt.toISOString(),
      body: sha(msg.bodyText.replace(/\r\n/g, "\n").trim()),
      attachments: msg.attachments.map((a) => sha(a.buffer)).sort(),
    }),
  );
}

function buildEml(msg: IncomingMessage): Buffer {
  const headers = [
    `From: ${msg.fromAddress}`,
    `To: ${msg.toAddress}`,
    `Subject: ${msg.subject}`,
    `Date: ${msg.receivedAt.toUTCString()}`,
    `X-T-CYBER-Channel: ${msg.channel}`,
    msg.attachments.length ? `X-T-CYBER-Attachments: ${msg.attachments.map((a) => a.fileName).join(", ")}` : null,
  ].filter(Boolean);
  return Buffer.from(`${headers.join("\r\n")}\r\n\r\n${msg.bodyText.replace(/\r?\n/g, "\r\n")}\r\n`, "utf8");
}

interface MatchResult {
  matchStatus: "MATCHED" | "NEEDS_MATCH_REVIEW" | "UNMATCHED";
  requestId: string | null;
  caseId: string | null;
  basis: string;
}

async function matchMessage(tx: Tx, msg: IncomingMessage, caseHint: string | null): Promise<MatchResult> {
  // The first quoted reference that names a request: its own (R.REQ-412/2026-002, with or without the letter), the
  // reply form (R.RES-…), or the reference it had before references named their case (REQ-2026-0275).
  let found: { ref: string; req: Prisma.RequestGetPayload<{ include: { recipient: true } }> } | null = null;
  for (const q of quotedRequestRefs(`${msg.subject}\n${msg.bodyText}`, getAppConfig().requests.referencePrefix)) {
    // q is the request's core (REQ-412/2026-002): stored with its kind's letter (R.REQ-…), or as a legacy reference.
    const r = await tx.request.findFirst({ where: { OR: [{ reference: { in: refVariants(q) } }, { legacyReference: q }] }, include: { recipient: true } });
    if (r && (!caseHint || caseHint === r.caseId)) {
      found = { ref: r.legacyReference === q ? q : r.reference, req: r };
      break;
    }
  }
  const senderDomain = domainOf(msg.fromAddress);
  if (found) {
    const { ref, req } = found;
    const recipientDomain = domainOf(req.recipient.address);
    if (recipientDomain && senderDomain === recipientDomain) {
      return { matchStatus: "MATCHED", requestId: req.id, caseId: req.caseId, basis: `The message quotes ${ref} and the sender domain (${senderDomain}) matches the recipient on record.` };
    }
    return {
      matchStatus: "NEEDS_MATCH_REVIEW",
      requestId: req.id,
      caseId: req.caseId,
      basis: `The message quotes ${ref}, but the sender domain (${senderDomain || "unknown"}) does not match the recipient on record (${recipientDomain || "portal"}). Confirm before reviewing.`,
    };
  }
  if (senderDomain) {
    // Answered requests stay candidates: banks send updates (a restriction added, a hold changed) after replying.
    const candidates = await tx.request.findMany({
      where: { status: { in: ["SUBMITTED", "ACKNOWLEDGED", "PARTIAL_RESPONSE", "COMPLETE_RESPONSE"] }, ...(caseHint ? { caseId: caseHint } : {}) },
      include: { recipient: true },
    });
    const sameSender = candidates.filter((c) => domainOf(c.recipient.address) === senderDomain);
    if (sameSender.length > 0) {
      const caseIds = [...new Set(sameSender.map((c) => c.caseId))];
      const only = sameSender.length === 1 ? sameSender[0]! : null;
      return {
        matchStatus: "NEEDS_MATCH_REVIEW",
        requestId: only?.id ?? null,
        caseId: caseIds.length === 1 ? caseIds[0]! : caseHint,
        basis: only
          ? `No request reference was quoted. The sender domain (${senderDomain}) matches the recipient of ${only.reference}, which is awaiting a response. Suggested match only.`
          : `No request reference was quoted. ${sameSender.length} requests awaiting a response were sent to ${senderDomain}: ${sameSender.map((c) => c.reference).join(", ")}.`,
      };
    }
  }
  return { matchStatus: "UNMATCHED", requestId: null, caseId: caseHint, basis: "No request reference or matching sender was found." };
}

// ───────────────────────── Finding generation ─────────────────────────

interface DraftFinding {
  findingType: string;
  classification: "NEW" | "ALREADY_KNOWN" | "CONFLICTING" | "INCOMPLETE" | "UNCERTAIN";
  classificationNote: string;
  summary: string;
  payload: FindingPayload;
  evidenceId: string | null;
  locator: string | null;
  excerpt: string | null;
  page?: number | null;
  row?: number | null;
  line?: number | null;
  requestItemId: string | null;
  predictedItemStatus?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const HOLD_RE = /(debit freeze|lien|hold|freez\w*)[^.]{0,220}?(?:Rs\.?|INR|₹)\s?(\d[\d,]*(?:\.\d{1,2})?)/i;
const HOLD_AFTER_RE = /(?:Rs\.?|INR|₹)\s?(\d[\d,]*(?:\.\d{1,2})?)[^.]{0,160}?\b(on hold|under lien|lien|frozen|freeze|held)\b/i;
const AS_ON_RE = /as on\s+(\d{2})[-/.](\d{2})[-/.](\d{4})(?:\s*(?:at\s*)?(\d{2}):(\d{2}))?/i;
const BANK_REF_RE = /(?:lien|hold|freeze)\s*(?:ref(?:erence)?|no\.?)\s*(?:no\.?)?\s*[:.-]?\s*([A-Z0-9][A-Z0-9/-]{5,}[A-Z0-9])/i;
const HOLD_UNTIL_RE = /(?:lien|hold|freeze)\b[^.]*?\b(?:valid|in force|in place|lapses?|expires?)\s*(?:until|till|up to|on)\s*(\d{2})[-/.](\d{2})[-/.](\d{4})/i;
const CASH_RE = /cash withdrawal of\s*(?:Rs\.?|INR|₹)\s?(\d[\d,]*(?:\.\d{1,2})?)[^.]*?\bATM\b(?:\s+(?:in|at)\s+([A-Z][A-Za-z ]*?[A-Za-z]))?\s+on\s+(\d{2})[-/.](\d{2})[-/.](\d{4})(?:\s*(?:at\s*)?(\d{2}):(\d{2}))?/i;
const ATM_ID_RE = /\bATM ID\s*(?:is|:|-)?\s*([A-Z0-9][A-Z0-9-]{3,})\b/i;
const PRESERVED_UNTIL_RE = /preserved\s+(?:until|till|up to)\s+(\d{2})[-/.](\d{2})[-/.](\d{4})/i;
const PRESERVED_DAYS_RE = /preserved\s+for\s+(\d{1,3})\s+days/i;
const PORTAL_REF_RE = /portal reference\s*(?:no\.?)?\s*[:-]?\s*([A-Z0-9][A-Z0-9/-]{3,}[A-Z0-9])/i;
const LOGIN_IP_RE = /\b(?:last )?login IP(?: address)?\s*[:-]\s*((?:\d{1,3}\.){3}\d{1,3})\b/i;
const PERIOD_RE = /for\s+(?:the\s+period\s+)?(\d{2})[-/.](\d{2})[-/.](\d{4})\s+to\s+(\d{2})[-/.](\d{2})[-/.](\d{4})/i;
const BALANCE_RE = /(closing|available|current)\s+balance[^.]{0,80}?(?:Rs\.?|INR|₹)\s?(\d[\d,]*(?:\.\d{1,2})?)/i;
const SEPARATELY_RE = /(furnished|provided|shared|sent)\s+separately|will be (furnished|provided|shared)/i;
const ACK_RE = /\b(acknowledge|acknowledged|received your|under process|being processed|is under examination)\b/i;
const REJECT_RE = /\b(unable to (provide|process|comply)|cannot be (provided|processed)|declined|not maintained|rejected)\b/i;

function istDate(dd: string, mm: string, yyyy: string, hh?: string, mi?: string): Date | null {
  return istInputToUtc(`${yyyy}-${mm}-${dd}${hh ? `T${hh}:${mi}` : ""}`);
}

interface GenContext {
  tx: Tx;
  caseId: string;
  request: Awaited<ReturnType<typeof loadRequestBundle>>;
  messageEvidenceId: string | null;
  bodyText: string;
  receivedAt: Date;
  attachments: { evidenceId: string; fileName: string; prepared: PreparedEvidence }[];
}

async function loadRequestBundle(tx: Tx, requestId: string) {
  return tx.request.findUniqueOrThrow({
    where: { id: requestId },
    include: { recipient: true, items: { orderBy: { sortOrder: "asc" } }, subjects: { include: { entity: true } } },
  });
}

async function classifyTransactionRow(ctx: GenContext, subject: { id: string; label: string }, c: ExtractedCandidate, ev: { evidenceId: string; fileName: string }, statementItemId: string | null): Promise<DraftFinding | null> {
  const s = c.structured ?? {};
  const direction = String(s.direction ?? "UNKNOWN");
  const counterValue = s.counterpartyAccount ? String(s.counterpartyAccount) : null;
  const amountMinor = s.amountMinor ? String(s.amountMinor) : null;
  const reference = s.reference ? String(s.reference) : null;
  const occurredAt = s.occurredAt ? String(s.occurredAt) : null;
  const channel = s.channel ? String(s.channel) : null;
  const counterparty = counterValue
    ? await ctx.tx.entity.findFirst({ where: { caseId: ctx.caseId, kind: "BANK_ACCOUNT", normalizedValue: normalizeIdentifier("BANK_ACCOUNT", counterValue) } })
    : null;
  const payload: FindingPayload = {
    direction,
    subjectEntityId: subject.id,
    counterparty: { entityId: counterparty?.id ?? null, value: counterValue, bank: s.counterpartyBank ?? null, ifsc: s.counterpartyIfsc ?? null },
    amountMinor,
    occurredAt,
    reference,
    channel,
    description: s.description ?? null,
    existingTransactionId: null,
  };
  const base = { evidenceId: ev.evidenceId, locator: `${ev.fileName}, row ${c.row}`, excerpt: c.excerpt, row: c.row, requestItemId: statementItemId, findingType: "TRANSACTION" };
  const amountText = amountMinor ? formatInr(BigInt(amountMinor)) : "an unreadable amount";
  const counterText = counterparty ? counterparty.label : counterValue ?? "an account not shown";
  const verb = direction === "CREDIT" ? `credit of ${amountText} into ${subject.label} from ${counterText}` : `transfer of ${amountText} from ${subject.label} to ${counterText}`;

  if (c.uncertainty === "UNCERTAIN_CHARACTERS" || c.uncertainty === "AMBIGUOUS_FORMAT" || c.uncertainty === "INCOMPLETE" || direction === "UNKNOWN") {
    return { ...base, classification: "UNCERTAIN", classificationNote: c.uncertaintyNote ?? "The row could not be read completely.", summary: `Statement row: ${verb}`, payload };
  }

  const fromId = direction === "CREDIT" ? counterparty?.id : subject.id;
  const toId = direction === "CREDIT" ? subject.id : counterparty?.id;
  let existing = reference ? await ctx.tx.transaction.findFirst({ where: { caseId: ctx.caseId, reference: { equals: reference } } }) : null;
  if (!existing && fromId && toId) {
    existing = await ctx.tx.transaction.findFirst({ where: { caseId: ctx.caseId, fromEntityId: fromId, toEntityId: toId, amountMinor: amountMinor ? BigInt(amountMinor) : undefined } });
  }
  // A credit the statement shows without the payer's account or a matching reference: if a recorded payment of the
  // same amount reached the same account within a few days, it is that payment (the record differs only in detail).
  if (!existing && direction === "CREDIT" && amountMinor && !counterparty) {
    const when = occurredAt ? new Date(occurredAt) : null;
    const near = await ctx.tx.transaction.findMany({ where: { caseId: ctx.caseId, toEntityId: subject.id, amountMinor: BigInt(amountMinor) }, orderBy: { occurredAt: "asc" } });
    existing = near.find((t) => !when || Math.abs(t.occurredAt.getTime() - when.getTime()) <= 3 * DAY_MS) ?? null;
  }
  if (existing) {
    payload.existingTransactionId = existing.id;
    const sameAmount = amountMinor !== null && existing.amountMinor === BigInt(amountMinor);
    // A side the statement does not show (no counterparty account) is compatible with the recorded one.
    const sameEnds = (!fromId || existing.fromEntityId === fromId) && (!toId || existing.toEntityId === toId);
    const when = occurredAt ? new Date(occurredAt) : null;
    if (sameAmount && sameEnds && when && utcToIstDateInput(when) !== utcToIstDateInput(existing.occurredAt)) {
      payload.conflict = "DATE";
      return {
        ...base,
        classification: "CONFLICTING",
        classificationNote: `The bank dates this ${direction === "CREDIT" ? "credit" : "transfer"} ${formatDateIST(when)} here but ${formatDateIST(existing.occurredAt)} in the recorded payment. Accepting records the difference as a flag against both; neither date is corrected.`,
        summary: `Date differs: ${verb}`,
        payload,
      };
    }
    if (sameAmount && sameEnds) {
      return {
        ...base,
        classification: "ALREADY_KNOWN",
        classificationNote: existing.status === "REPORTED_BY_VICTIM" ? "Matches a payment reported by the complainant. Accepting records the bank statement as corroboration." : "Already recorded from another source.",
        summary: `Statement confirms the ${verb}${reference ? ` (ref ${reference})` : ""}`,
        payload,
        predictedItemStatus: "RECEIVED",
      };
    }
    return {
      ...base,
      classification: "CONFLICTING",
      classificationNote: `A transaction with this reference is recorded as ${formatInr(existing.amountMinor)}. The bank shows ${amountText}${sameEnds ? "" : " between different accounts"}. Accepting records the bank figure as contradicting evidence; it does not overwrite the existing record.`,
      summary: `Statement differs from the recorded transaction${reference ? ` ${reference}` : ""}`,
      payload,
    };
  }
  if (direction === "CREDIT" && !counterparty) {
    return {
      ...base,
      classification: "UNCERTAIN",
      classificationNote: "Credit from an account that is not linked to this complaint. It may be unrelated money (mixed funds). Accept only if it is relevant.",
      summary: `Statement shows a ${verb}`,
      payload,
    };
  }
  // The complainant's own statement also holds everyday spending: a debit is taken as a payment to the fraudsters only
  // when it matches an amount the FIR reports or falls in the period of the offence; any other waits for the officer.
  const subjectEntity = await ctx.tx.entity.findUnique({ where: { id: subject.id } });
  if (direction === "DEBIT" && subjectEntity && isVictimOwned({ caseRole: subjectEntity.caseRole, attributes: parseAttributes(subjectEntity.attributesJson), belongsTo: subjectEntity.belongsTo })) {
    payload.victimPayment = true;
    const reported = await reportedPayments(ctx);
    const when = occurredAt ? new Date(occurredAt) : null;
    const matchesAmount = amountMinor !== null && reported.amounts.has(amountMinor);
    const inWindow = !!when && !!reported.from && when.getTime() >= reported.from.getTime() - 2 * DAY_MS && when.getTime() <= (reported.to ?? reported.from).getTime() + DAY_MS;
    const summary = `Complainant's payment of ${amountText} from ${subject.label} to ${counterText}${reference ? ` (ref ${reference})` : ""}`;
    if (!counterValue) {
      return { ...base, classification: "UNCERTAIN", classificationNote: "The row does not show the receiving account. Ask the bank for the beneficiary of this debit.", summary, payload };
    }
    if (matchesAmount || inWindow) {
      return {
        ...base,
        classification: "NEW",
        classificationNote: matchesAmount ? `Matches a payment of ${amountText} the FIR reports. Accepting records it as the complainant's payment and adds the receiving account.` : "Made during the period of the offence. Accepting records it as the complainant's payment and adds the receiving account.",
        summary,
        payload,
        predictedItemStatus: "RECEIVED",
      };
    }
    return {
      ...base,
      classification: "UNCERTAIN",
      classificationNote: "A debit from the complainant's own account that the FIR does not mention and that falls outside the period of the offence. Accept it only if it is one of the payments to the fraudsters.",
      summary,
      payload,
    };
  }
  return {
    ...base,
    classification: "NEW",
    classificationNote: counterparty ? "Not previously recorded." : `New account${counterValue && isMaskedValue(counterValue) ? " (masked in the source)" : ""}. Accepting adds the account and the transaction.`,
    summary: `New: ${verb}${reference ? ` (ref ${reference})` : ""}`,
    payload,
    predictedItemStatus: "RECEIVED",
  };
}

/** The payments the FIR reports (amounts read from it and confirmed) and the period of the offence. */
async function reportedPayments(ctx: GenContext): Promise<{ amounts: Set<string>; from: Date | null; to: Date | null }> {
  const kase = await ctx.tx.case.findUnique({ where: { id: ctx.caseId }, select: { incidentStart: true, incidentEnd: true, reportedAt: true } });
  const amounts = await ctx.tx.extractionCandidate.findMany({ where: { caseId: ctx.caseId, field: "AMOUNT", status: { in: ["ACCEPTED", "CORRECTED", "ADDED"] } }, select: { originalValue: true, correctedValue: true, roleHint: true } });
  const set = new Set<string>();
  for (const a of amounts) {
    if (!/paid|transferred|deposit|debited|sent|lost/i.test(a.roleHint ?? "")) continue;
    const v = parseRupeesToMinor((a.correctedValue ?? a.originalValue).replace(/^(?:INR|Rs\.?|₹)\s*/i, ""));
    if (v.ok) set.add(v.value.toString());
  }
  return { amounts: set, from: kase?.incidentStart ?? null, to: kase?.incidentEnd ?? kase?.reportedAt ?? null };
}

function textSources(ctx: GenContext): { evidenceId: string | null; fileName: string; lines: { line: number; text: string }[] }[] {
  const out: { evidenceId: string | null; fileName: string; lines: { line: number; text: string }[] }[] = [];
  out.push({ evidenceId: ctx.messageEvidenceId, fileName: "Message body", lines: ctx.bodyText.split(/\r?\n/).map((text, i) => ({ line: i + 1, text })) });
  for (const a of ctx.attachments) {
    if (a.prepared.parsed.status !== "TEXT_EXTRACTED") continue;
    out.push({ evidenceId: a.evidenceId, fileName: a.fileName, lines: a.prepared.parsed.segments.map((s) => ({ line: s.line ?? 0, text: s.text })) });
  }
  return out;
}

function bodyLine(body: string, needle: string | null | undefined): number | null {
  if (!needle) return null;
  const idx = body.split(/\r?\n/).findIndex((l) => l.includes(needle));
  return idx >= 0 ? idx + 1 : null;
}

// A bank's hold confirmation table covering several FIRs (often several stations): one row per FIR.
const col = (header: string[], re: RegExp) => header.findIndex((h) => re.test(h.trim()));
function isMultiFirHoldTable(header: string[]): boolean {
  return col(header, /^fir\b/i) >= 0 && col(header, /hold amount|amount held|lien amount/i) >= 0;
}

async function readMultiFirHoldTable(ctx: GenContext, subject: { id: string; label: string; normalizedValue: string }, rows: string[][], a: { evidenceId: string; fileName: string }, holdItemId: string | null): Promise<DraftFinding[]> {
  const header = rows[0]!;
  const ix = { fir: col(header, /^fir\b/i), account: col(header, /account/i), amount: col(header, /hold amount|amount held|lien amount/i), ref: col(header, /reference|ref\b/i), freeze: col(header, /freeze|restrict/i) };
  const kase = await ctx.tx.case.findUniqueOrThrow({ where: { id: ctx.caseId } });
  const own = kase.firNumber ? `${kase.firNumber}/${kase.firYear}` : null;
  const out: DraftFinding[] = [];
  let skipped = 0;
  const existingHold = await ctx.tx.hold.findFirst({ where: { caseId: ctx.caseId, accountEntityId: subject.id } });
  for (const [i, r] of rows.slice(1).entries()) {
    const rowNo = i + 2;
    const cell = (k: keyof typeof ix) => (ix[k] >= 0 ? (r[ix[k]] ?? "").trim() : "");
    const fir = cell("fir").replace(/\s+/g, "");
    const sameAccount = normalizeIdentifier("BANK_ACCOUNT", cell("account")) === subject.normalizedValue;
    if (!own || fir !== own || (ix.account >= 0 && !sameAccount)) {
      skipped++;
      continue;
    }
    const excerpt = r.join(", ");
    const parsed = parseRupeesToMinor(cell("amount"));
    const amount = parsed.ok ? parsed.value : null;
    const known = existingHold?.confirmedAmountMinor ?? null;
    out.push({
      findingType: "HOLD_STATUS",
      classification: amount === null ? "UNCERTAIN" : known === null ? "NEW" : known === amount ? "ALREADY_KNOWN" : "CONFLICTING",
      classificationNote: amount === null ? "The held amount could not be read." : known === null ? "The bank states an amount held." : known === amount ? "Same as the hold already recorded; nothing new." : `The recorded held amount is ${formatInr(known)}. Accepting records a change in the held amount.`,
      summary: `Hold on ${subject.label}: ${amount !== null ? formatInr(amount) : "amount unreadable"}${cell("ref") ? `, reference ${cell("ref")}` : ""}`,
      payload: { accountEntityId: subject.id, amountMinor: amount?.toString() ?? null, asOf: existingHold?.confirmedAsOf?.toISOString() ?? null, bankReference: cell("ref") || existingHold?.bankReference || null, restrictionOnly: false },
      evidenceId: a.evidenceId,
      locator: `${a.fileName}, row ${rowNo}`,
      excerpt,
      row: rowNo,
      requestItemId: holdItemId,
    });
    const freeze = /^(\d{2})[-/.](\d{2})[-/.](\d{4})$/.exec(cell("freeze"));
    if (freeze) {
      const at = istDate(freeze[1]!, freeze[2]!, freeze[3]!);
      const already = existingHold ? await ctx.tx.holdEvent.findFirst({ where: { holdId: existingHold.id, type: "RESTRICTION_ADDED" } }) : null;
      out.push({
        findingType: "RESTRICTION_CONFIRMED",
        classification: already ? "ALREADY_KNOWN" : "NEW",
        classificationNote: "A debit freeze stops all debits on the account. It is recorded beside the hold; the held amount does not change.",
        summary: `Debit freeze on ${subject.label}${at ? ` from ${formatDateIST(at)}` : ""}`,
        payload: { accountEntityId: subject.id, at: at?.toISOString() ?? null },
        evidenceId: a.evidenceId,
        locator: `${a.fileName}, row ${rowNo}`,
        excerpt,
        row: rowNo,
        requestItemId: null,
      });
    }
  }
  if (skipped) {
    out.push({
      findingType: "NOTE",
      classification: "ALREADY_KNOWN",
      classificationNote: "Rows about other FIRs are not read into this case. They stay in the original attachment.",
      summary: `${skipped} ${skipped === 1 ? "row" : "rows"} for other FIRs ${skipped === 1 ? "is" : "are"} skipped`,
      payload: { skipped },
      evidenceId: a.evidenceId,
      locator: a.fileName,
      excerpt: null,
      requestItemId: null,
    });
  }
  return out;
}

const shortPhone = (v: string) => shownId(v);
const dmy = (v: string) => /^(\d{2})[-/.](\d{2})[-/.](\d{4})$/.exec(v.trim());

/**
 * Telecom replies: the CAF names the subscriber on record; the CDR shows which numbers were in touch with the
 * subject every day, any contact with a victim's own number, the handset (IMEI) and the cells used. A cell ID is
 * reported as a cell ID: where the tower stands needs the operator's cell-site list, so no place is inferred.
 */
async function readTelecom(ctx: GenContext, phone: { id: string; label: string; value: string; normalizedValue: string }): Promise<DraftFinding[]> {
  const out: DraftFinding[] = [];
  const req = ctx.request;
  const item = (type: string) => req.items.find((i) => i.itemType === type) ?? null;
  const org = req.recipient.organisation.split(",")[0]!.trim();
  const known = await ctx.tx.entity.findMany({ where: { caseId: ctx.caseId, kind: "PHONE" } });
  const knownBy = new Map(known.map((e) => [e.normalizedValue, e]));
  for (const a of ctx.attachments) {
    // Call detail records.
    if (a.prepared.parsed.status === "TABLE_PARSED") {
      const rows = a.prepared.parsed.table ?? parseCsv(a.prepared.upload.buffer.toString("utf8"));
      const h = rows[0] ?? [];
      const ci = col(h, /calling/i);
      const di = col(h, /called/i);
      if (ci < 0 || di < 0) continue;
      const dateI = col(h, /date/i);
      const timeI = col(h, /time/i);
      const cellI = col(h, /cell/i);
      const imeiI = col(h, /imei/i);
      const calls = rows
        .slice(1)
        .map((r, i) => {
          const calling = normalizeIdentifier("PHONE", r[ci] ?? "");
          const called = normalizeIdentifier("PHONE", r[di] ?? "");
          const mine = calling === phone.normalizedValue ? "OUT" : called === phone.normalizedValue ? "IN" : null;
          const d = dmy(r[dateI] ?? "");
          const t = /^(\d{2}):(\d{2})/.exec((r[timeI] ?? "").trim());
          return { row: i + 2, other: mine === "OUT" ? (r[di] ?? "").trim() : (r[ci] ?? "").trim(), otherNorm: mine === "OUT" ? called : calling, mine, day: d ? `${d[1]}-${d[2]}-${d[3]}` : null, at: d ? istDate(d[1]!, d[2]!, d[3]!, t?.[1], t?.[2]) : null, cell: cellI >= 0 ? (r[cellI] ?? "").trim() : "", imei: imeiI >= 0 ? (r[imeiI] ?? "").trim() : "" };
        })
        .filter((c) => c.mine && c.day);
      if (!calls.length) continue;
      const days = [...new Set(calls.map((c) => c.day!))];
      const dates = calls.map((c) => c.at).filter((d): d is Date => !!d).sort((x, y) => x.getTime() - y.getTime());
      const span = dates.length ? `${formatDateIST(dates[0]!).slice(0, 6)} to ${formatDateIST(dates.at(-1)!).slice(0, 6)}` : `${days.length} days`;
      const cdrItem = item("CDR");
      out.push({
        findingType: "NOTE",
        classification: "NEW",
        classificationNote: `${calls.length.toLocaleString("en-IN")} records over ${days.length} days, ${span}.`,
        summary: `Call records of ${phone.label}: ${calls.length.toLocaleString("en-IN")} calls and messages, ${span}`,
        payload: cdrItem ? { requestItemId: cdrItem.id, itemStatus: "RECEIVED", note: `CDR for ${span}` } : {},
        evidenceId: a.evidenceId,
        locator: a.fileName,
        excerpt: null,
        requestItemId: cdrItem?.id ?? null,
        predictedItemStatus: cdrItem ? "RECEIVED" : undefined,
      });
      // Numbers in touch on (nearly) every day.
      const byOther = new Map<string, { value: string; days: Set<string>; n: number; firstRow: number }>();
      for (const c of calls) {
        const o = byOther.get(c.otherNorm) ?? { value: c.other, days: new Set<string>(), n: 0, firstRow: c.row };
        o.days.add(c.day!);
        o.n++;
        byOther.set(c.otherNorm, o);
      }
      const threshold = Math.max(3, Math.ceil(days.length * 0.8));
      const daily = [...byOther.entries()].filter(([, o]) => o.days.size >= threshold).sort((x, y) => y[1].days.size - x[1].days.size || y[1].n - x[1].n).slice(0, 5);
      for (const [norm, o] of daily) {
        const k = knownBy.get(norm);
        out.push({
          findingType: "RELATIONSHIP",
          classification: "NEW",
          classificationNote: k ? `Already in the case: ${k.caseRole ?? k.label}.` : "A number not yet in the case.",
          summary: `${shortPhone(o.value)} was in touch with ${phone.label} on ${o.days.size} of ${days.length} days${k ? ` (already in the case: ${(k.caseRole ?? k.label).replace(/\.$/, "")})` : ""}`,
          payload: { relType: "CONTACTED", from: { kind: "PHONE", value: o.value }, toEntityId: phone.id, statement: `The CDR of ${phone.label} from ${org} shows contact with ${shortPhone(o.value)} on ${o.days.size} of ${days.length} days (${span}).`, caseRole: "In daily contact with the suspect number (from the CDR)" },
          evidenceId: a.evidenceId,
          locator: `${a.fileName}, row ${o.firstRow}`,
          excerpt: null,
          row: o.firstRow,
          requestItemId: cdrItem?.id ?? null,
        });
      }
      // Contact with a victim's own number: corroborates the complaint, and the cell used then is a sighting.
      for (const v of known.filter((e) => e.belongsTo === "VICTIM" || /(complainant|victim(?: \d+)?)'?s own/i.test(e.caseRole ?? ""))) {
        const withV = calls.filter((c) => c.otherNorm === v.normalizedValue);
        if (!withV.length) continue;
        const times = withV.map((c) => (c.at ? formatDateTimeIST(c.at, { label: false }).split(", ")[1] : "")).filter(Boolean);
        const first = withV[0]!;
        const whose = (v.caseRole ?? "").replace(/:.*$/, "").replace(/'s own number/i, "’s number") || `${v.label}`;
        out.push({
          findingType: "RELATIONSHIP",
          classification: "NEW",
          classificationNote: "Corroborates the complaint: the suspect number called the victim.",
          summary: `${phone.label} called ${whose} ${withV.length} ${withV.length === 1 ? "time" : "times"}${first.at ? ` on ${formatDateIST(first.at).slice(0, 6)} at ${times.join(" and ")}` : ""}`,
          payload: { relType: "CONTACTED", from: { kind: "PHONE", value: v.value }, toEntityId: phone.id, statement: `The CDR of ${phone.label} shows ${withV.length} ${withV.length === 1 ? "call" : "calls"} with ${whose}${first.at ? ` on ${formatDateIST(first.at)}` : ""}.`, caseRole: v.caseRole ?? undefined },
          evidenceId: a.evidenceId,
          locator: `${a.fileName}, row ${first.row}`,
          excerpt: null,
          row: first.row,
          requestItemId: cdrItem?.id ?? null,
        });
        if (first.cell && first.at) {
          out.push({
            findingType: "LOCATION_OBSERVATION",
            classification: "INCOMPLETE",
            classificationNote: "A cell ID only. Where the tower stands, and the area it covers, needs the operator's cell-site list.",
            summary: `${phone.label} used cell ${first.cell} when it called ${whose}`,
            payload: { entityId: phone.id, observationType: "CELL_SITE", description: `${phone.label} called ${whose}`, locationText: `Cell ${first.cell}`, precision: "Cell ID only; tower location not given in the CDR", eventAt: first.at.toISOString(), limitations: "A cell covers an area, not a place. The cell-site list from the operator gives the tower's location." },
            evidenceId: a.evidenceId,
            locator: `${a.fileName}, row ${first.row}`,
            excerpt: null,
            row: first.row,
            requestItemId: null,
          });
        }
      }
      // The handset.
      const imeis = [...new Set(calls.map((c) => c.imei).filter(Boolean))];
      if (imeis.length && imeis.length <= 3) {
        out.push({
          findingType: "RELATIONSHIP",
          classification: "NEW",
          classificationNote: imeis.length === 1 ? "One handset throughout the period." : `${imeis.length} handsets in the period.`,
          summary: `${phone.label} was used in ${imeis.length === 1 ? `one handset, IMEI ${imeis[0]}` : `${imeis.length} handsets: ${imeis.join(", ")}`}`,
          payload: { relType: "LINKED_IDENTIFIER", from: { kind: "DEVICE", value: imeis[0]! }, toEntityId: phone.id, statement: `The CDR of ${phone.label} shows the handset with IMEI ${imeis[0]}${imeis.length > 1 ? ` (and ${imeis.length - 1} more)` : ""} throughout ${span}.`, caseRole: `Handset used with ${phone.label} (from the CDR)` },
          evidenceId: a.evidenceId,
          locator: a.fileName,
          excerpt: null,
          requestItemId: item("IMEI")?.id ?? null,
          predictedItemStatus: item("IMEI") ? "RECEIVED" : undefined,
        });
      }
      continue;
    }
    // Customer acquisition form.
    const text = a.prepared.upload.buffer.toString("utf8");
    const name = /Subscriber name\s*:\s*(.+)/i.exec(text)?.[1]?.trim();
    if (!name) continue;
    const address = /Address[^:\n]*:\s*(.+)/i.exec(text)?.[1]?.trim() ?? null;
    const idProof = /ID proof[^:\n]*:\s*(.+)/i.exec(text)?.[1]?.trim() ?? null;
    const act = /Activation date\s*:\s*(\d{2})[-/.](\d{2})[-/.](\d{4})/i.exec(text);
    const activatedAt = act ? istDate(act[1]!, act[2]!, act[3]!) : null;
    const lineOf = (re: RegExp) => text.split(/\r?\n/).findIndex((l) => re.test(l)) + 1 || null;
    const others = await ctx.tx.relationship.findMany({ where: { caseId: ctx.caseId, fromEntityId: phone.id, type: { in: ["REGISTERED_TO", "USED_BY"] } }, include: { toEntity: true } });
    const differs = others.find((r) => r.toEntity.kind === "PERSON" && r.toEntity.label.replace(/\s*\(synthetic\)$/, "").toLowerCase() !== name.replace(/\s*\(synthetic\)$/, "").toLowerCase());
    const cafItem = item("SUBSCRIBER_DETAILS");
    const phoneEntity = await ctx.tx.entity.findUnique({ where: { id: phone.id } });
    const named = phoneEntity ? statedNameCheck(phoneEntity, name, `the CAF from ${org}`) : null;
    out.push({
      findingType: "SUBSCRIBER_RECORD",
      classification: differs ? "CONFLICTING" : "NEW",
      classificationNote: `${differs ? `The case records ${differs.toEntity.label} for this number; the CAF names ${name}. Accepting keeps both and flags the difference.` : "The subscriber on record. A name on a CAF is not proof of who used the number."}${named?.note ?? ""}`,
      summary: `CAF: ${phone.label} is registered to ${name}${activatedAt ? `, activated ${formatDateIST(activatedAt)}` : ""}`,
      payload: { phoneEntityId: phone.id, holderName: name, address, idProof, activatedAt: activatedAt?.toISOString() ?? null, source: `the CAF from ${org}`, conflictWithRelationshipId: differs?.id ?? null },
      evidenceId: a.evidenceId,
      locator: `${a.fileName}, line ${lineOf(/Subscriber name/i) ?? 1}`,
      excerpt: `Subscriber name: ${name}`,
      line: lineOf(/Subscriber name/i),
      requestItemId: cafItem?.id ?? null,
      predictedItemStatus: cafItem ? "RECEIVED" : undefined,
    });
  }
  return out;
}

async function generateFindings(ctx: GenContext): Promise<{ findings: DraftFinding[]; suggestedType: ResponseType }> {
  const findings: DraftFinding[] = [];
  const req = ctx.request;
  const subjects = req.subjects.map((s) => s.entity).filter((e) => e.kind === "BANK_ACCOUNT" || e.kind === "UPI_ID" || e.kind === "WALLET");
  const subject = subjects[0] ?? null;
  const item = (type: string) => req.items.find((i) => i.itemType === type) ?? null;
  const statementItem = item("STATEMENT");

  // Statement tables.
  let statementRows = 0;
  const rowDates: Date[] = [];
  if (subject) {
    for (const a of ctx.attachments) {
      if (a.prepared.parsed.status !== "TABLE_PARSED") continue;
      const rows = a.prepared.parsed.table ?? parseCsv(a.prepared.upload.buffer.toString("utf8"));
      if (isMultiFirHoldTable(rows[0] ?? [])) {
        findings.push(...(await readMultiFirHoldTable(ctx, subject, rows, a, item("HOLD_CONFIRMATION")?.id ?? null)));
        continue;
      }
      const table = extractFromTable(rows);
      if (!table.recognised) {
        findings.push({
          findingType: "NOTE",
          classification: "UNCERTAIN",
          classificationNote: table.note ?? "Table not recognised.",
          summary: `${a.fileName}: table columns not recognised`,
          payload: {},
          evidenceId: a.evidenceId,
          locator: a.fileName,
          excerpt: null,
          requestItemId: null,
        });
        continue;
      }
      // Rows before the first money the case records reaching this account, and the bank's own small charges, are
      // not part of the trail: each group is summarised once instead of producing a result per row.
      const into = await ctx.tx.transaction.findMany({ where: { caseId: ctx.caseId, toEntityId: subject.id }, select: { occurredAt: true } });
      const firstIn = into.length ? new Date(Math.min(...into.map((t) => t.occurredAt.getTime()))) : null;
      const trailStart = firstIn ? istInputToUtc(`${utcToIstDateInput(firstIn)}T00:00`) : null;
      const before: number[] = [];
      const charges: { row: number; amount: bigint }[] = [];
      for (const c of table.candidates) {
        const st = c.structured ?? {};
        const when = st.occurredAt ? new Date(String(st.occurredAt)) : null;
        if (when) rowDates.push(when);
        statementRows++;
        if (trailStart && when && when < trailStart) {
          before.push(c.row ?? 0);
          continue;
        }
        const amount = st.amountMinor ? BigInt(String(st.amountMinor)) : null;
        if (st.direction === "DEBIT" && !st.counterpartyAccount && amount !== null && amount <= 100000n && /\b(charges?|fees?|gst|sms alert|amc)\b/i.test(String(st.description ?? ""))) {
          charges.push({ row: c.row ?? 0, amount });
          continue;
        }
        const f = await classifyTransactionRow(ctx, subject, c, a, statementItem?.id ?? null);
        if (!f) continue;
        findings.push(f);
      }
      if (before.length && trailStart) {
        findings.push({
          findingType: "NOTE",
          classification: "ALREADY_KNOWN",
          classificationNote: "They stay in the original statement, which is kept with its hash.",
          summary: `${before.length} ${before.length === 1 ? "row" : "rows"} before ${formatDateIST(trailStart)} ${before.length === 1 ? "is" : "are"} outside the money trail`,
          payload: { rows: before },
          evidenceId: a.evidenceId,
          locator: `${a.fileName}, rows ${before[0]}–${before.at(-1)}`,
          excerpt: null,
          requestItemId: statementItem?.id ?? null,
        });
      }
      if (charges.length) {
        const total = charges.reduce((sum, c) => sum + c.amount, 0n);
        findings.push({
          findingType: "NOTE",
          classification: "ALREADY_KNOWN",
          classificationNote: "Small debits the bank made itself (charges, fees, tax). Not money moved by the account holder.",
          summary: `${charges.length} ${charges.length === 1 ? "row is" : "rows are"} the bank's own charges (${formatInr(total)} in all)`,
          payload: { rows: charges.map((c) => c.row) },
          evidenceId: a.evidenceId,
          locator: `${a.fileName}, rows ${charges.map((c) => c.row).join(", ")}`,
          excerpt: null,
          requestItemId: statementItem?.id ?? null,
        });
      }
    }
  }

  const sources = textSources(ctx);
  const allText = sources.flatMap((s) => s.lines.map((l) => l.text)).join("\n");

  // Hold / lien confirmation.
  let holdFound = false;
  if (subject) {
    for (const src of sources) {
      for (const l of src.lines) {
        const before = HOLD_RE.exec(l.text);
        const after = before ? null : HOLD_AFTER_RE.exec(l.text);
        if (!before && !after) continue;
        const parsed = parseRupeesToMinor((before ? before[2] : after?.[1]) ?? "");
        const asOn = AS_ON_RE.exec(l.text) ?? AS_ON_RE.exec(src.lines.map((x) => x.text).join(" "));
        const asOf = asOn ? istDate(asOn[1]!, asOn[2]!, asOn[3]!, asOn[4], asOn[5]) : null;
        const bankRef = BANK_REF_RE.exec(src.lines.map((x) => x.text).join(" "))?.[1] ?? null;
        const until = HOLD_UNTIL_RE.exec(src.lines.map((x) => x.text).join(" "));
        const expiresAt = until ? istInputToUtc(`${until[3]}-${until[2]}-${until[1]}T23:59`) : null;
        const existingHold = await ctx.tx.hold.findFirst({ where: { caseId: ctx.caseId, accountEntityId: subject.id } });
        const amount = parsed.ok ? parsed.value : null;
        let classification: DraftFinding["classification"] = "NEW";
        let note = "The bank states an amount held. Accepting records it as a confirmed hold with this as-of time.";
        if (!parsed.ok) {
          classification = "UNCERTAIN";
          note = "A hold is mentioned but the amount could not be read reliably.";
        } else if (existingHold?.confirmedAmountMinor !== null && existingHold?.confirmedAmountMinor !== undefined) {
          classification = existingHold.confirmedAmountMinor === amount ? "ALREADY_KNOWN" : "CONFLICTING";
          note = classification === "ALREADY_KNOWN" ? "This held amount is already recorded." : `The recorded held amount is ${formatInr(existingHold.confirmedAmountMinor)}. Accepting records a change in the held amount.`;
        }
        findings.push({
          findingType: "HOLD_STATUS",
          classification,
          classificationNote: note,
          summary: `Hold confirmed on ${subject.label}: ${amount !== null ? formatInr(amount) : "amount unreadable"}${asOf ? ` as on ${formatDateIST(asOf)}` : ""}${expiresAt ? `, until ${formatDateIST(expiresAt)}` : ""}`,
          payload: { accountEntityId: subject.id, amountMinor: amount?.toString() ?? null, asOf: asOf?.toISOString() ?? null, bankReference: bankRef, restrictionOnly: false, expiresAt: expiresAt?.toISOString() ?? null },
          evidenceId: src.evidenceId,
          locator: `${src.fileName}, line ${l.line}`,
          excerpt: l.text,
          line: l.line,
          requestItemId: item("HOLD_CONFIRMATION")?.id ?? item("BALANCE_CONFIRMATION")?.id ?? null,
          predictedItemStatus: "RECEIVED",
        });
        holdFound = true;
        break;
      }
      if (holdFound) break;
    }
  }

  // A stated balance without a hold answers the balance question but secures nothing.
  let balanceReported = false;
  const balanceItemForReport = item("BALANCE_CONFIRMATION");
  if (subject && !holdFound) {
    for (const src of sources) {
      const hit = src.lines.find((l) => BALANCE_RE.test(l.text));
      if (!hit) continue;
      const m = BALANCE_RE.exec(hit.text)!;
      const parsed = parseRupeesToMinor(m[2] ?? "");
      const asOn = AS_ON_RE.exec(hit.text);
      const asOf = asOn ? istDate(asOn[1]!, asOn[2]!, asOn[3]!, asOn[4], asOn[5]) : null;
      findings.push({
        findingType: "BALANCE_REPORTED",
        classification: parsed.ok ? "NEW" : "UNCERTAIN",
        classificationNote: parsed.ok ? "The bank states a balance but no hold. Accepting answers the balance item; it does not record any funds as secured." : "A balance is mentioned but the amount could not be read reliably.",
        summary: `Balance of ${subject.label} reported as ${parsed.ok ? formatInr(parsed.value) : "an unreadable amount"}${asOf ? ` as on ${formatDateIST(asOf)}` : ""}; no hold stated`,
        payload: { accountEntityId: subject.id, amountMinor: parsed.ok ? parsed.value.toString() : null, asOf: asOf?.toISOString() ?? null, requestItemId: balanceItemForReport?.id ?? null, itemStatus: "RECEIVED", note: "Balance stated by the bank; no hold in place." },
        evidenceId: src.evidenceId,
        locator: `${src.fileName}, line ${hit.line}`,
        excerpt: hit.text,
        line: hit.line,
        requestItemId: balanceItemForReport?.id ?? null,
        predictedItemStatus: "RECEIVED",
      });
      balanceReported = true;
      break;
    }
  }

  // KYC, registered mobile, KYC address, login IP (from text attachments and body).
  let kycFound = false;
  for (const src of sources) {
    for (const l of src.lines) {
      const holder = /account holder(?:'s)? name\s*[:-]\s*(.+?)\s*$/i.exec(l.text);
      if (holder && subject) {
        kycFound = true;
        const named = statedNameCheck(subject, holder[1]!, `${req.recipient.organisation}'s KYC`);
        findings.push({
          findingType: "KYC_RECORD",
          classification: "NEW",
          classificationNote: `The KYC record names an account holder. This records who the bank lists as holder; it does not establish who used or controlled the account.${named?.note ?? ""}`,
          summary: `KYC: ${subject.label} is held in the name of ${holder[1]}`,
          payload: { accountEntityId: subject.id, holderName: holder[1], bank: req.recipient.organisation, ...(named ? { nameCheck: named.check } : {}) },
          evidenceId: src.evidenceId,
          locator: `${src.fileName}, line ${l.line}`,
          excerpt: l.text,
          line: l.line,
          requestItemId: item("KYC")?.id ?? null,
          predictedItemStatus: "RECEIVED",
        });
      }
      const mobile = /registered mobile(?: number)?\s*[:-]\s*(\+?[\dXx*\s-]{8,20})/i.exec(l.text);
      if (mobile && subject) {
        const value = mobile[1]!.trim();
        const existing = await ctx.tx.entity.findFirst({ where: { caseId: ctx.caseId, kind: "PHONE", normalizedValue: normalizeIdentifier("PHONE", value) } });
        findings.push({
          findingType: "RELATIONSHIP",
          classification: existing ? "ALREADY_KNOWN" : "NEW",
          classificationNote: existing ? "This number is already recorded in the case; accepting links it to the account." : "New phone number linked to the account by the bank's record.",
          summary: `Registered mobile on ${subject.label}: ${value}`,
          payload: { relType: "LINKED_IDENTIFIER", from: { kind: "PHONE", value }, toEntityId: subject.id, statement: `${req.recipient.organisation} records ${value} as the registered mobile for ${subject.label}` },
          evidenceId: src.evidenceId,
          locator: `${src.fileName}, line ${l.line}`,
          excerpt: l.text,
          line: l.line,
          // A registered number on its own is not the KYC (documents with photo ID) that was asked for.
          requestItemId: null,
        });
      }
      const address = /address(?: as per KYC| on record)?\s*[:-]\s*(.+?)\s*$/i.exec(l.text);
      if (address && subject && /kyc|record/i.test(l.text)) {
        const opened = /(?:opened on|kyc (?:updated|date))\s*[:-]?\s*(\d{2})[-/.](\d{2})[-/.](\d{4})/i.exec(src.lines.map((x) => x.text).join(" "));
        const eventAt = opened ? istDate(opened[1]!, opened[2]!, opened[3]!) : null;
        findings.push({
          findingType: "LOCATION_OBSERVATION",
          classification: "NEW",
          classificationNote: "Address as recorded by the bank. It reflects the KYC date, not a current location.",
          summary: `KYC address for ${subject.label}: ${address[1]}`,
          payload: {
            entityId: subject.id,
            observationType: "KYC_ADDRESS",
            description: `Address on the ${req.recipient.organisation} KYC record`,
            locationText: address[1],
            precision: "Address as recorded at account opening (not verified)",
            eventAt: eventAt?.toISOString() ?? null,
            eventAtNote: eventAt ? "KYC / account-opening date" : "Date of the KYC record not stated",
            limitations: "Historical KYC address; it is not a current location and has not been verified.",
          },
          evidenceId: src.evidenceId,
          locator: `${src.fileName}, line ${l.line}`,
          excerpt: l.text,
          line: l.line,
          requestItemId: item("KYC")?.id ?? null,
        });
      }
      const ip = /\b((?:\d{1,3}\.){3}\d{1,3})\b.*?(\d{2})[-/.](\d{2})[-/.](\d{4})\s+(\d{2}):(\d{2}):(\d{2})/.exec(l.text);
      if (ip && /log ?in|session/i.test(l.text) && subject) {
        const at = istInputToUtc(`${ip[4]}-${ip[3]}-${ip[2]}T${ip[5]}:${ip[6]}:${ip[7]}`);
        const hasPort = /port\s*[:-]?\s*\d+/i.test(l.text);
        findings.push({
          findingType: "LOCATION_OBSERVATION",
          classification: "NEW",
          classificationNote: hasPort ? "Login record with IP address and source port." : "Login record with IP address but no source port. A shared public IPv4 address may not identify a subscriber without the port.",
          summary: `Login to ${subject.label} from ${ip[1]}${at ? ` on ${formatDateIST(at)}` : ""}`,
          payload: {
            entity: { kind: "IP_ADDRESS", value: ip[1] },
            linkToEntityId: subject.id,
            linkStatement: `${req.recipient.organisation} records an internet-banking login to ${subject.label} from ${ip[1]}`,
            observationType: "IP_LOGIN",
            description: `Internet-banking login to ${subject.label}`,
            locationText: "No geolocation provided (IP address only)",
            precision: "IP address only; network and location unknown",
            eventAt: at?.toISOString() ?? null,
            eventAtNote: "Time as recorded by the bank",
            limitations: hasPort ? null : "Source port not provided. If the address is shared (CGNAT), the subscriber may not be identifiable without the port and exact time.",
          },
          evidenceId: src.evidenceId,
          locator: `${src.fileName}, line ${l.line}`,
          excerpt: l.text,
          line: l.line,
          requestItemId: item("IP_LOGS")?.id ?? null,
          predictedItemStatus: "RECEIVED",
        });
      }
    }
  }

  // Cash taken out of the account (usually reported alongside a hold): money that left, and where the card was used.
  if (subject) {
    const seen = new Set<string>();
    for (const src of sources) {
      for (const l of src.lines) {
        const m = CASH_RE.exec(l.text);
        if (!m) continue;
        const parsed = parseRupeesToMinor(m[1]!);
        const occurred = istDate(m[3]!, m[4]!, m[5]!, m[6], m[7]);
        const place = m[2]?.trim() ?? null;
        const atmId = ATM_ID_RE.exec(src.lines.map((x) => x.text).join(" "))?.[1] ?? null;
        const key = `${parsed.ok ? parsed.value : m[1]}|${occurred?.toISOString() ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const known = parsed.ok && occurred
          ? await ctx.tx.transaction.findFirst({ where: { caseId: ctx.caseId, fromEntityId: subject.id, kind: "CASH_WITHDRAWAL", amountMinor: parsed.value, occurredAt: occurred } })
          : null;
        findings.push({
          findingType: "CASH_WITHDRAWAL",
          classification: !parsed.ok || !occurred ? "UNCERTAIN" : known ? "ALREADY_KNOWN" : "NEW",
          classificationNote: !parsed.ok || !occurred
            ? "A cash withdrawal is mentioned but its amount or time could not be read reliably."
            : known
              ? "This withdrawal is already recorded."
              : `Recorded as money taken out of the account, never as held money. The ATM is a historical sighting, not a current location${atmId ? "" : "; the ATM ID is not given"}.`,
          summary: `Cash withdrawal of ${parsed.ok ? formatInr(parsed.value) : "an unreadable amount"} from ${subject.label}${place ? ` at an ATM in ${place}` : " at an ATM"}${occurred ? ` on ${formatDateTimeIST(occurred)}` : ""}`,
          payload: { subjectEntityId: subject.id, amountMinor: parsed.ok ? parsed.value.toString() : null, occurredAt: occurred?.toISOString() ?? null, place, atmId },
          evidenceId: src.evidenceId,
          locator: `${src.fileName}, line ${l.line}`,
          excerpt: l.text,
          line: l.line,
          requestItemId: null,
        });
      }
    }
  }

  // Preservation receipts: how long the provider keeps the records, and anything the receipt itself discloses.
  const anySubject = req.subjects[0]?.entity ?? null;
  if (req.category === "PRESERVATION" && anySubject) {
    for (const src of sources) {
      for (const l of src.lines) {
        const until = PRESERVED_UNTIL_RE.exec(l.text);
        const days = until ? null : PRESERVED_DAYS_RE.exec(l.text);
        if (!until && !days) continue;
        const preservedUntil = until
          ? istInputToUtc(`${until[3]}-${until[2]}-${until[1]}T23:59`)
          : istInputToUtc(`${utcToIstDateInput(new Date(ctx.receivedAt.getTime() + Number(days![1]) * DAY_MS))}T23:59`);
        const portalReference = PORTAL_REF_RE.exec(src.lines.map((x) => x.text).join(" "))?.[1] ?? null;
        findings.push({
          findingType: "PRESERVATION_CONFIRMED",
          classification: "NEW",
          classificationNote: "Preservation keeps existing records; it produces nothing. Disclosure is a separate request. The expiry date is tracked as a deadline.",
          summary: `${anySubject.label}: records preserved${preservedUntil ? ` until ${formatDateIST(preservedUntil)}` : ""}${portalReference ? ` (portal ref ${portalReference})` : ""}`,
          payload: { entityId: anySubject.id, preservedUntil: preservedUntil?.toISOString() ?? null, portalReference },
          evidenceId: src.evidenceId,
          locator: `${src.fileName}, line ${l.line}`,
          excerpt: l.text,
          line: l.line,
          requestItemId: item("PRESERVATION_CONFIRMATION")?.id ?? null,
          predictedItemStatus: "RECEIVED",
        });
        break;
      }
    }
    if (!subject) {
      for (const src of sources) {
        for (const l of src.lines) {
          const ip = LOGIN_IP_RE.exec(l.text);
          if (!ip) continue;
          const hasPort = /port\s*[:-]?\s*\d+/i.test(l.text);
          findings.push({
            findingType: "LOCATION_OBSERVATION",
            classification: "INCOMPLETE",
            classificationNote: hasPort
              ? "Login IP with a source port. The exact time with time zone is still needed to identify a subscriber."
              : "A login IP alone cannot identify a subscriber: the source port and the exact time with time zone are missing.",
            summary: `Login IP for ${anySubject.label}: ${ip[1]}`,
            payload: {
              entity: { kind: "IP_ADDRESS", value: ip[1] },
              linkToEntityId: anySubject.id,
              linkStatement: `${req.recipient.organisation}'s preservation receipt lists ${ip[1]} as a login IP for ${anySubject.label}`,
              observationType: "IP_LOGIN",
              description: `Login to ${anySubject.label}`,
              locationText: "No geolocation provided (IP address only)",
              precision: "IP address only; network and location unknown",
              eventAt: null,
              eventAtNote: "The receipt gives no login time",
              limitations: "No source port and no exact time: not enough to ask an internet provider who the subscriber was.",
            },
            evidenceId: src.evidenceId,
            locator: `${src.fileName}, line ${l.line}`,
            excerpt: l.text,
            line: l.line,
            requestItemId: null,
          });
        }
      }
    }
  }

  // Statement period completeness.
  const sortedDates = [...rowDates].sort((a, b) => a.getTime() - b.getTime());
  const minDate = sortedDates[0] ?? null;
  const maxDate = sortedDates.at(-1) ?? null;
  if (statementItem && statementRows > 0) {
    const periodText = PERIOD_RE.exec(allText);
    const providedFrom = periodText ? istDate(periodText[1]!, periodText[2]!, periodText[3]!) : minDate;
    const providedTo = periodText ? istDate(periodText[4]!, periodText[5]!, periodText[6]!) : maxDate;
    const v = await ctx.tx.requestVersion.findUnique({ where: { requestId_versionNo: { requestId: req.id, versionNo: req.currentVersionNo } } });
    const short =
      v?.periodFrom && v?.periodTo && providedFrom && providedTo && (providedFrom.getTime() - v.periodFrom.getTime() > 36e5 * 24 || v.periodTo.getTime() - providedTo.getTime() > 36e5 * 24);
    if (short && v?.periodFrom && v.periodTo && providedFrom && providedTo) {
      findings.push({
        findingType: "ITEM_NOT_PROVIDED",
        classification: "INCOMPLETE",
        classificationNote: `Requested ${formatDateIST(v.periodFrom)} to ${formatDateIST(v.periodTo)}; provided ${formatDateIST(providedFrom)} to ${formatDateIST(providedTo)}.`,
        summary: "Statement covers only part of the requested period",
        payload: { requestItemId: statementItem.id, itemStatus: "PARTIAL", note: `Statement provided for ${formatDateIST(providedFrom)} to ${formatDateIST(providedTo)} only.` },
        evidenceId: ctx.messageEvidenceId,
        locator: bodyLine(ctx.bodyText, periodText?.[0]) ? `Message body, line ${bodyLine(ctx.bodyText, periodText?.[0])}` : "Message body",
        excerpt: periodText?.[0] ?? null,
        line: bodyLine(ctx.bodyText, periodText?.[0]),
        requestItemId: statementItem.id,
        predictedItemStatus: "PARTIAL",
      });
    }
  }

  // Items not provided.
  const said = SEPARATELY_RE.test(allText);
  const kycItem = item("KYC");
  if (kycItem && !kycFound && statementRows + (holdFound ? 1 : 0) > 0) {
    findings.push({
      findingType: "ITEM_NOT_PROVIDED",
      classification: "INCOMPLETE",
      classificationNote: said ? "The bank says this will be furnished separately." : "Not included in this response.",
      summary: "KYC details not provided",
      payload: { requestItemId: kycItem.id, itemStatus: "PENDING", note: said ? "Bank states KYC will be furnished separately." : "Not included in the response." },
      evidenceId: ctx.messageEvidenceId,
      locator: (() => { const l = ctx.bodyText.split(/\r?\n/).findIndex((x) => SEPARATELY_RE.test(x)); return l >= 0 ? `Message body, line ${l + 1}` : "Message body"; })(),
      excerpt: ctx.bodyText.split(/\r?\n/).find((x) => SEPARATELY_RE.test(x)) ?? null,
      line: (() => { const l = ctx.bodyText.split(/\r?\n/).findIndex((x) => SEPARATELY_RE.test(x)); return l >= 0 ? l + 1 : null; })(),
      requestItemId: kycItem.id,
      predictedItemStatus: "PENDING",
    });
  }
  const balanceItem = item("BALANCE_CONFIRMATION");
  const existingConfirmedHold = subject ? await ctx.tx.hold.findFirst({ where: { caseId: ctx.caseId, accountEntityId: subject.id, status: "CONFIRMED_HELD" } }) : null;
  if (balanceItem && !holdFound && !balanceReported && existingConfirmedHold && existingConfirmedHold.confirmedAmountMinor !== null) {
    findings.push({
      findingType: "NOTE",
      classification: "ALREADY_KNOWN",
      classificationNote: "The balance and hold status were already confirmed by the bank for this account.",
      summary: `Balance already confirmed: ${formatInr(existingConfirmedHold.confirmedAmountMinor)} held${existingConfirmedHold.confirmedAsOf ? ` as on ${formatDateIST(existingConfirmedHold.confirmedAsOf)}` : ""}`,
      payload: { requestItemId: balanceItem.id, itemStatus: "RECEIVED", note: "Answered by the earlier hold confirmation." },
      evidenceId: ctx.messageEvidenceId,
      locator: "Message body",
      excerpt: null,
      requestItemId: balanceItem.id,
      predictedItemStatus: "RECEIVED",
    });
  } else if (balanceItem && !holdFound && !balanceReported && subject && statementRows > 0) {
    const incoming = await ctx.tx.transaction.findMany({ where: { caseId: ctx.caseId, toEntityId: subject.id } });
    const received = incoming.reduce((s, t) => s + t.amountMinor, 0n);
    const outgoingKnown = await ctx.tx.transaction.findMany({ where: { caseId: ctx.caseId, fromEntityId: subject.id } });
    const knownOut = outgoingKnown.reduce((s, t) => s + t.amountMinor, 0n);
    const newOut = findings
      .filter((f) => f.findingType === "TRANSACTION" && f.payload.direction === "DEBIT" && f.classification === "NEW" && f.payload.amountMinor)
      .reduce((s, f) => s + BigInt(String(f.payload.amountMinor)), 0n);
    const untraced = received - knownOut - newOut;
    findings.push({
      findingType: "BALANCE_UNCONFIRMED",
      classification: "INCOMPLETE",
      classificationNote: "The response does not state the remaining balance or any hold. Unknown is not zero.",
      summary: `Remaining balance and hold status of ${subject.label} not confirmed${untraced > 0n ? ` (${formatInr(untraced)} credited but not traced in the statement)` : ""}`,
      payload: { requestItemId: balanceItem.id, itemStatus: "PENDING", note: "Balance and lien status not stated in the response.", untracedMinor: untraced.toString() },
      evidenceId: ctx.messageEvidenceId,
      locator: (() => { const l = ctx.bodyText.split(/\r?\n/).findIndex((x) => /balance|lien/i.test(x)); return l >= 0 ? `Message body, line ${l + 1}` : "Message body"; })(),
      excerpt: ctx.bodyText.split(/\r?\n/).find((x) => /balance|lien/i.test(x)) ?? null,
      line: (() => { const l = ctx.bodyText.split(/\r?\n/).findIndex((x) => /balance|lien/i.test(x)); return l >= 0 ? l + 1 : null; })(),
      requestItemId: balanceItem.id,
      predictedItemStatus: "PENDING",
    });
  }

  // Telecom replies (CDR, CAF) about a phone number.
  const phoneSubject = req.subjects.map((s) => s.entity).find((e) => e.kind === "PHONE");
  if (phoneSubject) findings.push(...(await readTelecom(ctx, phoneSubject)));

  // Suggested response type (officer confirms during review).
  let suggested: ResponseType;
  if (REJECT_RE.test(ctx.bodyText)) suggested = "REJECTION";
  else if (findings.filter((f) => f.findingType !== "NOTE").length === 0) suggested = ACK_RE.test(ctx.bodyText) || ctx.bodyText.length < 600 ? "ACKNOWLEDGEMENT" : "PARTIAL";
  else {
    const predicted = req.items.map((it) => {
      const related = findings.filter((f) => f.requestItemId === it.id);
      if (related.length === 0) return it.status;
      if (related.some((f) => f.predictedItemStatus === "PARTIAL")) return "PARTIAL";
      if (related.some((f) => f.predictedItemStatus === "PENDING")) return it.status === "RECEIVED" ? "RECEIVED" : "PENDING";
      return "RECEIVED";
    });
    suggested = suggestResponseTypeFromItems(predicted);
  }
  return { findings, suggestedType: suggested };
}

// ───────────────────────── Import ─────────────────────────

export interface ImportOptions {
  caseId?: string | null;
  /** Officer-chosen request (manual import). Must be a submitted request in the same case. */
  requestIdHint?: string | null;
  isSynthetic?: boolean;
  actorId: string;
  actor?: SessionUser | null;
  /** The local model that reads what the rules cannot (tests pass a stub; demonstration replies are not read by it). */
  generate?: Generate;
  /** Where the message came from, for the record of the evidence (GMAIL: read from the linked account's inbox). */
  source?: "GMAIL";
}

/** Imports an incoming message (simulated mailbox / manual import). Duplicate imports are detected and ignored. */
export async function importResponse(db: Db, msg: IncomingMessage, opts: ImportOptions): Promise<{ status: "IMPORTED" | "DUPLICATE"; responseId: string; matchStatus: string; modelRead?: { added: number; reason?: string } }> {
  const result = await importResponseTx(db, msg, opts);
  // What the rules could not place is read by the local model after the import is saved, so a slow or absent model
  // never holds the database or loses the reply.
  if (result.status === "IMPORTED" && result.matchStatus === "MATCHED" && !opts.isSynthetic) {
    const modelRead = await readReplyWithModel(db, result.responseId, { generate: opts.generate }).catch((err: unknown) => ({ added: 0, reason: err instanceof Error ? err.message : "The local model could not read it." }));
    return { ...result, modelRead };
  }
  return result;
}

async function importResponseTx(db: Db, msg: IncomingMessage, opts: ImportOptions): Promise<{ status: "IMPORTED" | "DUPLICATE"; responseId: string; matchStatus: string }> {
  const fingerprint = fingerprintMessage(msg);
  const dup = await db.response.findUnique({ where: { fingerprint } });
  if (dup) return { status: "DUPLICATE", responseId: dup.id, matchStatus: dup.matchStatus };
  if (opts.actor && opts.caseId) await loadCaseForUser(db, opts.actor, opts.caseId, "write");

  const prepared = await Promise.all(
    msg.attachments.map((a) => prepareEvidence({ fileName: a.fileName, buffer: a.buffer, category: "BANK_RESPONSE", sourceDescription: `Attachment to message from ${msg.fromAddress}`, receivedAt: msg.receivedAt, isSynthetic: opts.isSynthetic })),
  );
  const emlPrepared = await prepareEvidence({
    fileName: `message-${msg.receivedAt.toISOString().slice(0, 10)}.eml`,
    buffer: buildEml(msg),
    title: `Message: ${msg.subject}`.slice(0, 200),
    category: "EMAIL_MESSAGE",
    sourceDescription: `${opts.source === "GMAIL" ? "Read from the linked Gmail account" : msg.channel === "EMAIL" ? "Received in the simulated mailbox" : "Imported manually"} from ${msg.fromAddress}`,
    receivedAt: msg.receivedAt,
    isSynthetic: opts.isSynthetic,
  });

  return db.$transaction(async (tx) => {
    const again = await tx.response.findUnique({ where: { fingerprint } });
    if (again) return { status: "DUPLICATE" as const, responseId: again.id, matchStatus: again.matchStatus };
    let match = await matchMessage(tx, msg, opts.caseId ?? null);
    if (opts.requestIdHint) {
      const hinted = await tx.request.findUnique({ where: { id: opts.requestIdHint } });
      if (!hinted || (opts.caseId && hinted.caseId !== opts.caseId) || !["SUBMITTED", "ACKNOWLEDGED", "PARTIAL_RESPONSE", "COMPLETE_RESPONSE"].includes(hinted.status)) {
        throw new AppError("Choose a submitted request from this case.", "VALIDATION", { requestId: "Choose a submitted request from this case." });
      }
      match = { matchStatus: "MATCHED", requestId: hinted.id, caseId: hinted.caseId, basis: `Matched to ${hinted.reference} by the importing officer. ${match.basis}` };
    }
    if (opts.actor && match.caseId) await loadCaseForUser(tx, opts.actor, match.caseId, "write");
    if (!match.caseId && msg.attachments.length > 0) {
      throw new AppError("This message could not be matched to a case. Choose the case it belongs to, then import it again.", "VALIDATION", { caseId: "Choose a case." });
    }
    const response = await tx.response.create({
      data: {
        importedAt: now(),
        caseId: match.caseId,
        requestId: match.requestId,
        matchStatus: match.matchStatus,
        matchBasis: match.basis,
        fromAddress: msg.fromAddress,
        toAddress: msg.toAddress,
        subject: msg.subject,
        receivedAt: msg.receivedAt,
        bodyText: msg.bodyText,
        channel: msg.channel,
        fingerprint,
        importedById: opts.actorId,
      },
    });
    let messageEvidenceId: string | null = null;
    const attachments: GenContext["attachments"] = [];
    if (match.caseId) {
      const eml = await insertEvidenceTx(tx, opts.actorId, match.caseId, { ...emlPrepared, upload: { ...emlPrepared.upload, responseId: response.id } });
      messageEvidenceId = eml.id;
      for (const p of prepared) {
        const item = await insertEvidenceTx(tx, opts.actorId, match.caseId, { ...p, upload: { ...p.upload, responseId: response.id, parentId: null } });
        attachments.push({ evidenceId: item.id, fileName: p.upload.fileName, prepared: p });
      }
      await tx.response.update({ where: { id: response.id }, data: { messageEvidenceId } });
    }
    if (match.caseId && match.requestId) {
      // How sure the match is, with the same rules the inbox uses, so a weak match can be shown as one.
      const ranked = await rankRequestsFor(tx, match.caseId, msg);
      const own = ranked.find((x) => x.request.id === match.requestId);
      const firCount = new Set([...`${msg.subject}\n${msg.bodyText}`.matchAll(/\bFIR\s*(?:No\.?\s*)?(\d{1,5}\/\d{4})\b/gi)].map((m) => m[1])).size;
      await tx.response.update({ where: { id: response.id }, data: { matchScore: own?.score ?? null, firCount: firCount || null } });
    }
    if (match.caseId && match.requestId) {
      const request = await loadRequestBundle(tx, match.requestId);
      const { findings, suggestedType } = await generateFindings({ tx, caseId: match.caseId, request, messageEvidenceId, bodyText: msg.bodyText, receivedAt: msg.receivedAt, attachments });
      await tx.response.update({ where: { id: response.id }, data: { suggestedType } });
      await tx.responseFinding.createMany({
        data: findings.map((f, i) => ({
          responseId: response.id,
          caseId: match.caseId!,
          findingType: f.findingType,
          classification: f.classification,
          classificationNote: f.classificationNote,
          summary: f.summary,
          payloadJson: JSON.stringify(f.payload),
          evidenceId: f.evidenceId,
          locator: f.locator,
          excerpt: f.excerpt,
          page: f.page ?? null,
          row: f.row ?? null,
          line: f.line ?? null,
          requestItemId: f.requestItemId,
          sortOrder: i,
        })),
      });
    }
    if (match.caseId) {
      await recordAudit(tx, {
        caseId: match.caseId,
        actorId: opts.actorId,
        action: "response.imported",
        objectType: "Response",
        objectId: response.id,
        summary: `Response received from ${msg.fromAddress}: ${match.matchStatus === "MATCHED" ? "matched" : "needs match review"}`,
        detail: { matchBasis: match.basis },
        at: msg.receivedAt,
      });
      await refreshRecommendationsTx(tx, match.caseId, opts.actorId);
    }
    return { status: "IMPORTED" as const, responseId: response.id, matchStatus: match.matchStatus };
  });
}

// ───────────────────────── Review ─────────────────────────

async function loadResponseForUser(tx: Tx, user: SessionUser, responseId: string) {
  const r = await tx.response.findUnique({ where: { id: responseId } });
  if (!r) throw notFoundError("response");
  if (r.caseId) await loadCaseForUser(tx, user, r.caseId, "write");
  else if (user.role !== "SUPERVISOR") throw notFoundError("response");
  return r;
}

export function decideFinding(
  db: Db,
  user: SessionUser,
  findingId: string,
  input: { decision: "ACCEPTED" | "EDITED" | "REJECTED" | "DEFERRED" | "PENDING"; reason?: string | null; editedPayload?: FindingPayload | null },
) {
  return db.$transaction(async (tx) => {
    const f = await tx.responseFinding.findUnique({ where: { id: findingId } });
    if (!f) throw notFoundError("finding");
    await loadResponseForUser(tx, user, f.responseId);
    if (f.appliedAt) throw new AppError("This result has already been applied to the case. Record a correction instead.", "PRECONDITION");
    if ((input.decision === "REJECTED" || input.decision === "DEFERRED") && !input.reason?.trim()) {
      throw new AppError("Give a reason.", "VALIDATION", { reason: `Give a reason for ${input.decision === "REJECTED" ? "rejecting" : "deferring"}.` });
    }
    let edited: string | null = null;
    if (input.decision === "EDITED") {
      if (!input.editedPayload) throw new AppError("Nothing was edited.", "VALIDATION");
      const p = input.editedPayload;
      if (p.amountMinor !== undefined && p.amountMinor !== null && !/^\d+$/.test(String(p.amountMinor))) throw new AppError("Enter a valid amount.", "VALIDATION", { amount: "Enter a valid amount." });
      edited = JSON.stringify({ ...(JSON.parse(f.payloadJson) as FindingPayload), ...p });
    }
    await tx.responseFinding.update({
      where: { id: findingId },
      data: { decision: input.decision, decisionReason: input.reason?.trim() || null, editedPayloadJson: edited ?? (input.decision === "EDITED" ? f.editedPayloadJson : null), decidedById: user.id, decidedAt: now() },
    });
    await tx.response.updateMany({ where: { id: f.responseId, reviewStatus: "UNREVIEWED" }, data: { reviewStatus: "IN_REVIEW" } });
    return tx.responseFinding.findUniqueOrThrow({ where: { id: findingId } });
  });
}

export function confirmResponseMatch(db: Db, user: SessionUser, responseId: string, requestId: string) {
  return db.$transaction(async (tx) => {
    const r = await loadResponseForUser(tx, user, responseId);
    const req = await tx.request.findUnique({ where: { id: requestId } });
    if (!req) throw notFoundError("request");
    await loadCaseForUser(tx, user, req.caseId, "write");
    if (r.caseId && r.caseId !== req.caseId) throw new AppError("The request belongs to a different case from this message.", "VALIDATION");
    if (r.matchStatus === "MATCHED" && r.requestId === requestId) return r;
    await tx.response.update({ where: { id: responseId }, data: { matchStatus: "MATCHED", requestId, caseId: req.caseId, matchBasis: `${r.matchBasis} Match confirmed by ${user.displayName}.`, version: { increment: 1 } } });
    const findingsCount = await tx.responseFinding.count({ where: { responseId } });
    if (findingsCount === 0) {
      const request = await loadRequestBundle(tx, requestId);
      const attachments = await tx.evidenceItem.findMany({ where: { responseId, category: { not: "EMAIL_MESSAGE" } } });
      const gen = await generateFindings({
        tx,
        caseId: req.caseId,
        request,
        messageEvidenceId: r.messageEvidenceId,
        bodyText: r.bodyText,
        receivedAt: r.receivedAt,
        attachments: [],
      });
      await tx.response.update({ where: { id: responseId }, data: { suggestedType: gen.suggestedType } });
      await tx.responseFinding.createMany({
        data: gen.findings.map((f, i) => ({ responseId, caseId: req.caseId, findingType: f.findingType, classification: f.classification, classificationNote: f.classificationNote, summary: f.summary, payloadJson: JSON.stringify(f.payload), evidenceId: f.evidenceId, locator: f.locator, excerpt: f.excerpt, requestItemId: f.requestItemId, sortOrder: i })),
      });
      void attachments;
    }
    await recordAudit(tx, { caseId: req.caseId, actorId: user.id, action: "response.match_confirmed", objectType: "Response", objectId: responseId, summary: `Message from ${r.fromAddress} matched to ${req.reference}` });
    await refreshRecommendationsTx(tx, req.caseId, user.id);
    return tx.response.findUniqueOrThrow({ where: { id: responseId } });
  });
}

// ───────────────────────── Apply ─────────────────────────

async function nextAccountLabel(tx: Tx, caseId: string, value: string): Promise<string> {
  const accounts = await tx.entity.findMany({ where: { caseId, kind: "BANK_ACCOUNT" }, select: { label: true } });
  const letters = accounts.map((a) => /^Account ([A-Z])$/.exec(a.label)?.[1]).filter((x): x is string => !!x);
  if (letters.length > 0) {
    const max = letters.sort().at(-1)!;
    if (max < "Z") return `Account ${String.fromCharCode(max.charCodeAt(0) + 1)}`;
  }
  return `Account ${shownId(value)}`;
}

async function upsertIdentifier(tx: Tx, caseId: string, kind: string, value: string, extra: { label?: string; attributes?: Record<string, unknown>; caseRole?: string; phase: number; at: Date }) {
  const normalizedValue = normalizeIdentifier(kind, value);
  const existing = await tx.entity.findUnique({ where: { caseId_kind_normalizedValue: { caseId, kind, normalizedValue } } });
  if (existing) return { entity: existing, created: false };
  const entity = await tx.entity.create({
    data: {
      caseId,
      kind,
      label: extra.label ?? value,
      value,
      normalizedValue,
      attributesJson: JSON.stringify(extra.attributes ?? {}),
      caseRole: extra.caseRole ?? null,
      isMasked: isMaskedValue(value),
      discoveredAt: extra.at,
      discoveryPhase: extra.phase,
    },
  });
  return { entity, created: true };
}

async function addSource(tx: Tx, caseId: string, actorId: string, f: { evidenceId: string | null; locator: string | null; excerpt: string | null; page: number | null; row: number | null; line: number | null }, subjectType: string, subjectId: string, stance = "SUPPORTS", note: string | null = null) {
  if (!f.evidenceId) return;
  const locator = f.locator ?? "Response";
  const dedupeKey = `${subjectType}:${subjectId}:${f.evidenceId}:${locator}:${stance}`;
  await tx.sourceAssertion.upsert({
    where: { caseId_dedupeKey: { caseId, dedupeKey } },
    create: { caseId, evidenceId: f.evidenceId, page: f.page, row: f.row, line: f.line, locator, excerpt: f.excerpt ?? "", subjectType, subjectId, stance, note, dedupeKey, createdById: actorId },
    update: {},
  });
}

/**
 * Applies the officer's accepted/edited results in one transaction. Idempotent: results already
 * applied are skipped, so applying the same response twice creates nothing new. Financial
 * totals change only through confirmed financial records (accepted holds / transactions).
 */
export function applyResponse(db: Db, user: SessionUser, responseId: string, input: { responseType: ResponseType; expectedVersion: number }) {
  return db.$transaction(async (tx) => {
    const r = await loadResponseForUser(tx, user, responseId);
    if (r.version !== input.expectedVersion) throw conflictError("This response was updated by someone else. Reload and review again.");
    if (r.matchStatus !== "MATCHED" || !r.requestId || !r.caseId) throw new AppError("Confirm which request this message answers before applying it.", "PRECONDITION");
    const caseId = r.caseId;
    const request = await loadRequestBundle(tx, r.requestId);
    const findings = await tx.responseFinding.findMany({ where: { responseId }, orderBy: { sortOrder: "asc" } });
    const toApply = findings.filter((f) => (f.decision === "ACCEPTED" || f.decision === "EDITED") && !f.appliedAt);
    const at = now();
    const maxPhase = await tx.entity.aggregate({ where: { caseId }, _max: { discoveryPhase: true } });
    const phase = (maxPhase._max.discoveryPhase ?? 0) + 1;
    const affectedEntityIds = new Set<string>();
    let applied = 0;

    for (const f of toApply) {
      const p = JSON.parse(f.editedPayloadJson ?? f.payloadJson) as FindingPayload;
      const refs: Record<string, string> = {};
      switch (f.findingType) {
        case "TRANSACTION": {
          const subjectId = String(p.subjectEntityId);
          const cp = (p.counterparty ?? {}) as { entityId?: string | null; value?: string | null; bank?: string | null; ifsc?: string | null };
          if (f.classification === "CONFLICTING" && p.existingTransactionId && p.conflict === "DATE") {
            // The bank confirms the payment; only its date differs. Both dates stay as their sources give them.
            const existingTxn = await tx.transaction.findUniqueOrThrow({ where: { id: String(p.existingTransactionId) } });
            if (existingTxn.status === "REPORTED_BY_VICTIM") await tx.transaction.update({ where: { id: existingTxn.id }, data: { status: "CONFIRMED_BY_BANK" } });
            await addSource(tx, caseId, user.id, f, "TRANSACTION", existingTxn.id, "CONTRADICTS", f.classificationNote);
            refs.transactionId = existingTxn.id;
            affectedEntityIds.add(subjectId);
            break;
          }
          if (f.classification === "CONFLICTING" && p.existingTransactionId) {
            await tx.transaction.update({ where: { id: String(p.existingTransactionId) }, data: { status: "DISPUTED" } });
            await addSource(tx, caseId, user.id, f, "TRANSACTION", String(p.existingTransactionId), "CONTRADICTS", f.classificationNote);
            refs.transactionId = String(p.existingTransactionId);
            break;
          }
          if (p.existingTransactionId) {
            await tx.transaction.update({ where: { id: String(p.existingTransactionId) }, data: { status: "CONFIRMED_BY_BANK" } });
            await addSource(tx, caseId, user.id, f, "TRANSACTION", String(p.existingTransactionId));
            refs.transactionId = String(p.existingTransactionId);
            affectedEntityIds.add(subjectId);
            break;
          }
          if (!p.amountMinor || !p.occurredAt) throw new AppError(`"${f.summary}" is missing an amount or date. Edit it before accepting.`, "VALIDATION");
          let counterpartyId = cp.entityId ?? null;
          if (!counterpartyId) {
            if (!cp.value) throw new AppError(`"${f.summary}" has no counterparty account. Edit it before accepting.`, "VALIDATION");
            const label = await nextAccountLabel(tx, caseId, cp.value);
            const { entity, created } = await upsertIdentifier(tx, caseId, "BANK_ACCOUNT", cp.value, {
              label,
              attributes: { bank: cp.bank ?? bankFromIfsc(cp.ifsc) ?? undefined, ifsc: cp.ifsc ?? undefined },
              caseRole: p.victimPayment
                ? `Received the complainant's payment (per ${request.recipient.organisation}'s record)`
                : `Onward recipient from ${(await tx.entity.findUnique({ where: { id: subjectId } }))?.label ?? "a traced account"}`,
              phase,
              at: at,
            });
            counterpartyId = entity.id;
            if (created) await addSource(tx, caseId, user.id, f, "ENTITY", entity.id, "MENTIONS");
          }
          const incoming = await tx.transaction.findMany({ where: { caseId, toEntityId: subjectId } });
          const credit = p.direction === "CREDIT";
          // A debit from the complainant's own account is their payment: the first layer of the trail, against their claim.
          const victimPayment = !credit && p.victimPayment === true;
          const claim = victimPayment ? await tx.victimClaim.findFirst({ where: { caseId }, orderBy: { lossAmountMinor: "desc" } }) : null;
          const layer = victimPayment ? 1 : credit ? Math.max(1, Math.min(...incoming.map((t) => t.layer), 1)) : (incoming.length ? Math.min(...incoming.map((t) => t.layer)) : 1) + 1;
          const dedupeKey = p.reference ? `REF:${String(p.reference).toUpperCase()}` : `ROW:${sha(`${subjectId}|${counterpartyId}|${p.amountMinor}|${p.occurredAt}`)}`;
          const txn = await tx.transaction.upsert({
            where: { caseId_dedupeKey: { caseId, dedupeKey } },
            create: {
              caseId,
              fromEntityId: credit ? counterpartyId : subjectId,
              toEntityId: credit ? subjectId : counterpartyId,
              amountMinor: BigInt(String(p.amountMinor)),
              occurredAt: new Date(String(p.occurredAt)),
              channel: (p.channel as string | null) ?? "OTHER",
              reference: (p.reference as string | null) ?? null,
              kind: victimPayment ? "VICTIM_PAYMENT" : "ONWARD_TRANSFER",
              layer,
              claimId: claim?.id ?? null,
              status: "CONFIRMED_BY_BANK",
              discoveredAt: at,
              discoveryPhase: phase,
              dedupeKey,
            },
            update: {},
          });
          await addSource(tx, caseId, user.id, f, "TRANSACTION", txn.id);
          refs.transactionId = txn.id;
          refs.counterpartyId = counterpartyId;
          affectedEntityIds.add(subjectId);
          affectedEntityIds.add(counterpartyId);
          break;
        }
        case "HOLD_STATUS": {
          const accountId = String(p.accountEntityId);
          const account = await tx.entity.findUniqueOrThrow({ where: { id: accountId } });
          const holdKey = `${parseAttributes(account.attributesJson).bank ?? "BANK"}:${account.normalizedValue}`;
          if (f.classification === "ALREADY_KNOWN") {
            // The bank repeats a hold already on record: keep this record as corroboration; nothing changes.
            const same = await tx.hold.findUnique({ where: { caseId_holdKey: { caseId, holdKey } } });
            if (same) {
              await addSource(tx, caseId, user.id, f, "HOLD", same.id);
              refs.holdId = same.id;
              break;
            }
          }
          const amount = p.amountMinor ? BigInt(String(p.amountMinor)) : null;
          const asOf = p.asOf ? new Date(String(p.asOf)) : at;
          const existing = await tx.hold.findUnique({ where: { caseId_holdKey: { caseId, holdKey } } });
          const hold = await tx.hold.upsert({
            where: { caseId_holdKey: { caseId, holdKey } },
            create: {
              caseId,
              accountEntityId: accountId,
              holdKey,
              bankReference: (p.bankReference as string | null) ?? null,
              status: amount === null ? "RESTRICTION_CONFIRMED" : "CONFIRMED_HELD",
              confirmedAmountMinor: amount,
              confirmedAsOf: amount === null ? null : asOf,
              requestId: request.category === "HOLD" ? request.id : null,
              expiresAt: p.expiresAt ? new Date(String(p.expiresAt)) : null,
            },
            update: {
              status: amount === null ? "RESTRICTION_CONFIRMED" : "CONFIRMED_HELD",
              confirmedAmountMinor: amount,
              confirmedAsOf: amount === null ? null : asOf,
              bankReference: (p.bankReference as string | null) ?? existing?.bankReference ?? null,
              ...(p.expiresAt ? { expiresAt: new Date(String(p.expiresAt)) } : {}),
              version: { increment: 1 },
            },
          });
          await tx.holdEvent.create({
            data: {
              holdId: hold.id,
              caseId,
              at: asOf,
              type: amount === null ? "RESTRICTION_CONFIRMED" : existing?.confirmedAmountMinor != null ? "AMOUNT_CHANGED" : "AMOUNT_CONFIRMED",
              amountMinor: amount,
              previousAmountMinor: existing?.confirmedAmountMinor ?? null,
              recordedAt: at,
              note: `Recorded from the response received ${formatDateIST(r.receivedAt)} (${request.reference}).`,
              actorId: user.id,
            },
          });
          await addSource(tx, caseId, user.id, f, "HOLD", hold.id);
          await recordAudit(tx, {
            caseId,
            actorId: user.id,
            action: "funds.hold_confirmed",
            objectType: "Hold",
            objectId: hold.id,
            summary: amount === null ? `Restriction confirmed on ${account.label}; amount not stated` : `Hold of ${formatInr(amount)} confirmed on ${account.label}`,
          });
          refs.holdId = hold.id;
          affectedEntityIds.add(accountId);
          break;
        }
        case "KYC_RECORD": {
          const accountId = String(p.accountEntityId);
          const person = await tx.entity.create({
            data: {
              caseId,
              kind: "PERSON",
              label: String(p.holderName),
              value: String(p.holderName),
              normalizedValue: `person:${crypto.randomUUID()}`,
              caseRole: "Account holder on record (per bank KYC). Not a finding of involvement.",
              discoveredAt: at,
              discoveryPhase: phase,
            },
          });
          await tx.partyRole.create({ data: { caseId, entityId: person.id, role: "ACCOUNT_HOLDER_ON_RECORD", basis: `${p.bank} KYC record` } });
          const account = await tx.entity.findUniqueOrThrow({ where: { id: accountId } });
          const rel = await tx.relationship.create({
            data: {
              caseId,
              fromEntityId: accountId,
              toEntityId: person.id,
              type: "REGISTERED_TO",
              statement: `${p.bank} ${typeof p.recordName === "string" ? p.recordName : "KYC record"} lists ${p.holderName} as the holder of ${account.label}`,
              discoveredAt: at,
              discoveryPhase: phase,
              dedupeKey: `REGISTERED_TO:${accountId}:${person.id}`,
            },
          });
          await addSource(tx, caseId, user.id, f, "RELATIONSHIP", rel.id);
          await addSource(tx, caseId, user.id, f, "ENTITY", person.id, "MENTIONS");
          refs.personId = person.id;
          refs.relationshipId = rel.id;
          affectedEntityIds.add(accountId);
          await recordNameCheck(tx, caseId, user.id, accountId, String(p.holderName), `${p.bank} ${typeof p.recordName === "string" ? p.recordName : "KYC record"}`, at);
          break;
        }
        case "SUBSCRIBER_RECORD": {
          const phoneId = String(p.phoneEntityId);
          const phone = await tx.entity.findUniqueOrThrow({ where: { id: phoneId } });
          const person = await tx.entity.create({
            data: { caseId, kind: "PERSON", label: String(p.holderName), value: String(p.holderName), normalizedValue: `person:${crypto.randomUUID()}`, caseRole: `Subscriber on record of ${phone.label} (per ${p.source}). Not a finding of involvement.`, discoveredAt: at, discoveryPhase: phase },
          });
          await tx.partyRole.create({ data: { caseId, entityId: person.id, role: "ACCOUNT_HOLDER_ON_RECORD", basis: String(p.source) } });
          const rel = await tx.relationship.create({
            data: { caseId, fromEntityId: phoneId, toEntityId: person.id, type: "REGISTERED_TO", statement: `${String(p.source).replace(/^the /, "The ")} lists ${p.holderName} as the subscriber of ${phone.label}.`, discoveredAt: at, discoveryPhase: phase, dedupeKey: `REGISTERED_TO:${phoneId}:${person.id}` },
          });
          await addSource(tx, caseId, user.id, f, "RELATIONSHIP", rel.id);
          await addSource(tx, caseId, user.id, f, "ENTITY", person.id, "MENTIONS");
          if (p.conflictWithRelationshipId) await addSource(tx, caseId, user.id, f, "RELATIONSHIP", String(p.conflictWithRelationshipId), "CONTRADICTS", f.classificationNote);
          if (p.address) {
            const dedupeKey = `KYC_ADDRESS:${phoneId}::${p.address}`;
            const loc = await tx.locationObservation.upsert({
              where: { caseId_dedupeKey: { caseId, dedupeKey } },
              create: { caseId, entityId: phoneId, observationType: "KYC_ADDRESS", description: `Address on the CAF for ${phone.label}`, locationText: String(p.address), precision: "Address as recorded at activation (not verified)", eventAt: p.activatedAt ? new Date(String(p.activatedAt)) : null, receivedAt: r.receivedAt, discoveryPhase: phase, dedupeKey },
              update: {},
            });
            await addSource(tx, caseId, user.id, f, "LOCATION", loc.id);
            refs.locationId = loc.id;
          }
          refs.personId = person.id;
          refs.relationshipId = rel.id;
          affectedEntityIds.add(phoneId);
          await recordNameCheck(tx, caseId, user.id, phoneId, String(p.holderName), String(p.source), at);
          break;
        }
        case "RELATIONSHIP": {
          const from = p.from as { kind: string; value: string };
          const { entity } = await upsertIdentifier(tx, caseId, from.kind, from.value, { caseRole: (p.caseRole as string | undefined) ?? "Linked to an account by a bank record", phase, at });
          const toId = String(p.toEntityId);
          const dedupeKey = `${p.relType}:${entity.id}:${toId}`;
          const rel = await tx.relationship.upsert({
            where: { caseId_dedupeKey: { caseId, dedupeKey } },
            create: { caseId, fromEntityId: entity.id, toEntityId: toId, type: String(p.relType), statement: String(p.statement), discoveredAt: at, discoveryPhase: phase, dedupeKey },
            update: {},
          });
          await addSource(tx, caseId, user.id, f, "RELATIONSHIP", rel.id);
          refs.entityId = entity.id;
          refs.relationshipId = rel.id;
          affectedEntityIds.add(toId);
          break;
        }
        case "LOCATION_OBSERVATION": {
          let entityId = (p.entityId as string | undefined) ?? null;
          const ent = p.entity as { kind: string; value: string } | undefined;
          if (ent) {
            const { entity } = await upsertIdentifier(tx, caseId, ent.kind, ent.value, { caseRole: "Observed in a bank login record", phase, at });
            entityId = entity.id;
            refs.entityId = entity.id;
            if (p.linkToEntityId) {
              const dedupeKey = `LINKED_IDENTIFIER:${entity.id}:${p.linkToEntityId}`;
              const rel = await tx.relationship.upsert({
                where: { caseId_dedupeKey: { caseId, dedupeKey } },
                create: { caseId, fromEntityId: entity.id, toEntityId: String(p.linkToEntityId), type: "LINKED_IDENTIFIER", statement: String(p.linkStatement), discoveredAt: at, discoveryPhase: phase, dedupeKey },
                update: {},
              });
              await addSource(tx, caseId, user.id, f, "RELATIONSHIP", rel.id);
              refs.relationshipId = rel.id;
            }
          }
          const dedupeKey = `${p.observationType}:${entityId}:${p.eventAt ?? ""}:${p.locationText}`;
          const loc = await tx.locationObservation.upsert({
            where: { caseId_dedupeKey: { caseId, dedupeKey } },
            create: {
              caseId,
              entityId,
              observationType: String(p.observationType),
              description: String(p.description),
              locationText: String(p.locationText),
              precision: String(p.precision),
              eventAt: p.eventAt ? new Date(String(p.eventAt)) : null,
              eventAtNote: (p.eventAtNote as string | null) ?? null,
              receivedAt: r.receivedAt,
              limitations: (p.limitations as string | null) ?? null,
              discoveryPhase: phase,
              dedupeKey,
            },
            update: {},
          });
          await addSource(tx, caseId, user.id, f, "LOCATION", loc.id);
          refs.locationId = loc.id;
          break;
        }
        case "CASH_WITHDRAWAL": {
          const subjectId = String(p.subjectEntityId);
          if (!p.amountMinor || !p.occurredAt) throw new AppError(`"${f.summary}" is missing an amount or time. Edit it before accepting.`, "VALIDATION");
          const account = await tx.entity.findUniqueOrThrow({ where: { id: subjectId } });
          const occurredAt = new Date(String(p.occurredAt));
          const place = (p.place as string | null) ?? null;
          const { entity: cash } = await upsertIdentifier(tx, caseId, "CASH", `Cash withdrawn from ${account.value} on ${formatDateTimeIST(occurredAt)}`, {
            label: place ? `Cash, ATM ${place}` : "Cash withdrawal",
            caseRole: "Cash taken out of the account; to be traced",
            phase,
            at,
          });
          const incoming = await tx.transaction.findMany({ where: { caseId, toEntityId: subjectId } });
          const dedupeKey = `CASH:${sha(`${subjectId}|${p.amountMinor}|${p.occurredAt}`)}`;
          const txn = await tx.transaction.upsert({
            where: { caseId_dedupeKey: { caseId, dedupeKey } },
            create: {
              caseId,
              fromEntityId: subjectId,
              toEntityId: cash.id,
              amountMinor: BigInt(String(p.amountMinor)),
              occurredAt,
              channel: "CASH_WITHDRAWAL",
              reference: (p.atmId as string | null) ?? null,
              kind: "CASH_WITHDRAWAL",
              layer: (incoming.length ? Math.min(...incoming.map((t) => t.layer)) : 1) + 1,
              status: "CONFIRMED_BY_BANK",
              discoveredAt: at,
              discoveryPhase: phase,
              dedupeKey,
            },
            update: {},
          });
          await addSource(tx, caseId, user.id, f, "TRANSACTION", txn.id);
          const locKey = `ATM_WITHDRAWAL:${subjectId}:${occurredAt.toISOString()}`;
          const loc = await tx.locationObservation.upsert({
            where: { caseId_dedupeKey: { caseId, dedupeKey: locKey } },
            create: {
              caseId,
              entityId: subjectId,
              observationType: "ATM_WITHDRAWAL",
              description: `${formatInr(BigInt(String(p.amountMinor)))} cash withdrawn from ${account.label}`,
              locationText: place ? `ATM, ${place}` : "ATM, place not given",
              precision: "ATM_SITE",
              eventAt: occurredAt,
              eventAtNote: "Time of the withdrawal as reported by the bank",
              receivedAt: r.receivedAt,
              limitations: `ATM site only: a historical sighting, not a current location.${p.atmId ? "" : " ATM ID not given, so footage cannot be requested yet."}`,
              discoveryPhase: phase,
              dedupeKey: locKey,
            },
            update: {},
          });
          await addSource(tx, caseId, user.id, f, "LOCATION", loc.id);
          refs.transactionId = txn.id;
          refs.cashEntityId = cash.id;
          refs.locationId = loc.id;
          affectedEntityIds.add(subjectId);
          break;
        }
        case "RESTRICTION_CONFIRMED": {
          const accountId = String(p.accountEntityId);
          const account = await tx.entity.findUniqueOrThrow({ where: { id: accountId } });
          const hold = await tx.hold.findFirst({ where: { caseId, accountEntityId: accountId } });
          if (!hold) throw new AppError(`Record the hold on ${account.label} before its restriction.`, "PRECONDITION");
          const when = p.at ? new Date(String(p.at)) : at;
          await tx.holdEvent.create({ data: { holdId: hold.id, caseId, at: when, recordedAt: at, type: "RESTRICTION_ADDED", amountMinor: hold.confirmedAmountMinor, previousAmountMinor: hold.confirmedAmountMinor, note: `Debit freeze on the whole account from ${formatDateIST(when)} (${request.reference}). The held amount is unchanged.`, actorId: user.id } });
          await tx.hold.update({ where: { id: hold.id }, data: { note: `Debit freeze on the whole account from ${formatDateIST(when)}.`, version: { increment: 1 } } });
          await recordAudit(tx, { caseId, actorId: user.id, action: "funds.restriction_recorded", objectType: "Hold", objectId: hold.id, summary: `Debit freeze recorded on ${account.label}; the held amount is unchanged` });
          refs.holdId = hold.id;
          affectedEntityIds.add(accountId);
          break;
        }
        case "PRESERVATION_CONFIRMED": {
          if (p.preservedUntil) await tx.request.update({ where: { id: request.id }, data: { preservedUntil: new Date(String(p.preservedUntil)) } });
          if (p.entityId) await addSource(tx, caseId, user.id, f, "ENTITY", String(p.entityId), "MENTIONS", "Preservation confirmed by the provider");
          refs.requestId = request.id;
          break;
        }
        default:
          break; // ITEM_NOT_PROVIDED, BALANCE_UNCONFIRMED, NOTE: no fact changes
      }
      await tx.responseFinding.update({ where: { id: f.id }, data: { appliedAt: at, appliedRefJson: JSON.stringify(refs) } });
      applied++;
    }

    if (applied > 0) await recomputeLayersTx(tx, caseId);

    // Requested-versus-received checklist, from accepted results only.
    const decided = await tx.responseFinding.findMany({ where: { responseId, decision: { in: ["ACCEPTED", "EDITED"] } } });
    for (const it of request.items) {
      const related = decided.filter((f) => f.requestItemId === it.id);
      if (related.length === 0) continue;
      const explicit = related.map((f) => JSON.parse(f.editedPayloadJson ?? f.payloadJson) as FindingPayload).find((p) => p.requestItemId === it.id && p.itemStatus);
      const factual = related.some((f) => !["ITEM_NOT_PROVIDED", "BALANCE_UNCONFIRMED", "NOTE"].includes(f.findingType));
      const status = explicit?.itemStatus === "PARTIAL" ? "PARTIAL" : factual ? "RECEIVED" : String(explicit?.itemStatus ?? it.status);
      if (status !== it.status || it.responseId !== responseId) {
        await tx.requestItem.update({ where: { id: it.id }, data: { status, responseId, note: (explicit?.note as string | undefined) ?? it.note } });
      }
    }

    const transition = nextRequestStatus(request.status, { type: "RESPONSE_REVIEWED", responseType: input.responseType });
    if (!transition.ok) throw new AppError(transition.error, "PRECONDITION");
    if (transition.status !== request.status) {
      await tx.request.update({ where: { id: request.id }, data: { status: transition.status, version: { increment: 1 } } });
    }

    const pendingLeft = await tx.responseFinding.count({ where: { responseId, decision: { in: ["PENDING", "DEFERRED"] } } });
    await tx.response.update({
      where: { id: responseId },
      data: { responseType: input.responseType, reviewStatus: pendingLeft === 0 ? "APPLIED" : "IN_REVIEW", appliedAt: at, appliedById: user.id, version: { increment: 1 } },
    });

    if (affectedEntityIds.size > 0) {
      await flagDraftsForReviewTx(tx, caseId, [...affectedEntityIds], `New information from ${request.recipient.organisation} (${request.reference}) changed facts this draft relies on.`);
      // An officer's own entry is now backed by a record.
      await tx.entity.updateMany({ where: { id: { in: [...affectedEntityIds] }, officerEntry: true }, data: { officerEntry: false } });
    }

    // Justified follow-up proposal for outstanding items after a partial response.
    let followUpId: string | null = null;
    if (input.responseType === "PARTIAL") {
      const items = await tx.requestItem.findMany({ where: { requestId: request.id }, orderBy: { sortOrder: "asc" } });
      const outstanding = items.filter((i) => i.status === "PENDING" || i.status === "PARTIAL");
      const existingChild = await tx.request.findFirst({ where: { parentRequestId: request.id, status: { in: ["DRAFT", "AWAITING_APPROVAL", "APPROVED", "SUBMISSION_FAILED"] } } });
      if (outstanding.length > 0 && !existingChild) {
        const version = await tx.requestVersion.findUniqueOrThrow({ where: { requestId_versionNo: { requestId: request.id, versionNo: request.currentVersionNo } } });
        const kase = await tx.case.findUniqueOrThrow({ where: { id: caseId }, include: { station: true } });
        const subjectLabel = request.subjects.map((s) => `${s.entity.label} (${s.entity.value})`).join(", ");
        const template = await tx.template.findFirst({ where: { category: "FOLLOW_UP", active: true } });
        const vars = {
          parentReference: request.reference,
          requestReference: "{{requestReference}}",
          responseDate: formatDateIST(r.receivedAt),
          subjectLabel,
          outstandingItems: outstanding.map((i) => `- ${i.label}${i.note ? ` (${i.note})` : ""}`).join("\n"),
          caseReference: kase.referenceType === "FIR" ? `FIR No. ${kase.firNumber}/${kase.firYear}` : `Complaint ${kase.complaintRef}`,
          station: kase.station.name,
          officerName: user.displayName,
          officerRank: user.rank,
          signature: getAppConfig().mailbox.signature.join("\n"),
        };
        // Signed with the officer's own closing and sent from their own mailbox, when they have set them.
        const mail = await mailDefaultsFor(tx, user);
        const body = withClosing(
          template
            ? renderTemplate(template.bodyTemplate, vars)
            : `With reference to ${vars.parentReference} and your reply dated ${vars.responseDate} concerning ${subjectLabel}, the following items are still outstanding:\n\n${vars.outstandingItems}\n\nPlease provide them, quoting {{requestReference}}.\n\n${vars.officerName}, ${vars.officerRank}\n${vars.signature}`,
          user,
          getAppConfig().mailbox,
          mail.closing,
        );
        const draft = await createDraftTx(tx, user, {
          fromAddress: mail.own.from ? mail.from : null,
          caseId,
          category: request.category,
          recipientId: request.recipientId,
          routeId: request.routeId,
          subject: template ? renderTemplate(template.subjectTemplate, vars) : `Follow-up to ${request.reference}: outstanding items (${vars.caseReference})`,
          body,
          scope: `Outstanding items from ${request.reference}: ${outstanding.map((i) => i.label).join("; ")}`,
          periodFrom: version.periodFrom,
          periodTo: version.periodTo,
          items: outstanding.map((i) => ({ label: i.label, itemType: i.itemType })),
          subjectEntityIds: request.subjects.map((s) => s.entityId),
          parentRequestId: request.id,
          authorId: await assistantAuthorId(tx, kase.stationId),
        });
        followUpId = draft.id;
      }
    }

    await recordAudit(tx, {
      caseId,
      actorId: user.id,
      action: "response.applied",
      objectType: "Response",
      objectId: responseId,
      summary: applied > 0 ? `Response to ${request.reference} reviewed: ${applied} result(s) applied; recorded as ${input.responseType.toLowerCase()}` : `Response to ${request.reference} reviewed; nothing new to apply`,
      detail: { responseType: input.responseType, applied, followUpId },
    });
    await refreshRecommendationsTx(tx, caseId, user.id);
    return { applied, followUpRequestId: followUpId, requestStatus: transition.status };
  });
}
