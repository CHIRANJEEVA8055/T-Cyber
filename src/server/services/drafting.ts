import { formatInr } from "@/domain/money";
import { formatDateIST, formatDateTimeIST, istInputToUtc, utcToIstDateInput } from "@/domain/time";
import type { Db, Tx } from "../db";
import type { SessionUser } from "../auth/session";
import { loadCaseForUser } from "../auth/access";
import { AppError, notFoundError } from "../errors";
import { createDraftTx, getRequestState, updateDraftTx } from "./requests";
import { CALLER_NUMBER_ITEMS, defaultItemsFor, renderSubject, renderTemplate } from "./templates";
import { parseAttributes } from "./facts";
import { caseReference } from "./cases";
import { getAppConfig } from "../config";
import { assistantAuthorId } from "../assistant-identity";
import { bankProvider, emailProvider, isVictimOwned, platformProvider, providerByName, PROVIDERS, type Provider } from "@/domain/providers";
import { nodalAddressAvailable, nodalRecipientFor } from "./nodal";
import { draftGapFor, type DraftGap, type GapContext, type GapKind } from "./draft-gaps";
import { recordAudit } from "../audit";
import { mailDefaultsFor } from "./mail-defaults";
import { withClosing } from "@/domain/closing";
import { formatSections } from "@/domain/legal-sections";
import { shownId } from "@/domain/identifiers";

/** Departmental routes (UNICROSS, NPCI) are the station's own configuration, used for real cases too. */
const DEPARTMENTAL = ["POLICE_UNIT", "NPCI"];
const ACTIVE = ["DRAFT", "AWAITING_APPROVAL", "APPROVED", "SUBMISSION_FAILED", "SUBMITTED", "ACKNOWLEDGED", "PARTIAL_RESPONSE"];
const UNSENT = ["DRAFT", "AWAITING_APPROVAL", "APPROVED", "SUBMISSION_FAILED"];

/** Built-in wording used only when no template is configured for a route (Settings → Templates). */
export const DEFAULT_TEMPLATES: Record<string, { subject: string; body: string }> = {
  HOLD: {
    subject: "{{caseReference}} · {{subjectLabel}} {{subjectShort}} · hold request · {{requestReference}}",
    body: "To the Nodal Officer, {{bank}}\n\nSir/Madam,\n\nIn {{caseReference}} of {{station}}, {{district}} ({{sections}}), {{moneyIn}}\n\nKindly mark a debit freeze on account {{subjectValue}} and confirm:\n{{items}}\n\nKindly reply quoting {{requestReference}}.\n\n{{officerName}}, {{officerRank}}\n{{signature}}",
  },
  INFORMATION_BANK: {
    subject: "{{caseReference}} · {{subjectLabel}} {{subjectShort}} · statement and KYC · {{requestReference}}",
    body: "To the Nodal Officer, {{bank}}\n\nSir/Madam,\n\nIn {{caseReference}} of {{station}}, {{district}} ({{sections}}), {{moneyIn}}{{holdNote}}\n\nUnder Section 94 BNSS, kindly furnish{{periodText}}:\n{{items}}\n\n{{firCopyNote}}Kindly reply to this mailbox, quoting {{requestReference}}.\n\n{{officerName}}, {{officerRank}}\n{{signature}}",
  },
  INFORMATION_PHONE: {
    subject: "{{caseReference}} · CDR and CAF · mobile {{subjectShort}} · {{requestReference}}",
    body: "Through the UNICROSS desk, Zonal ACP\n\nSir/Madam,\n\nIn {{caseReference}} of {{station}} ({{sections}}): {{relevance}}\n\nKindly obtain and forward{{periodText}}:\n{{items}}\n\n{{firCopyNote}}Reply via DD to this station's mailbox, quoting {{requestReference}}.\n\n{{officerName}}, {{officerRank}}\n{{signature}}",
  },
  INFORMATION_IP: {
    subject: "{{caseReference}} · login session details · {{subjectValue}} · {{requestReference}}",
    body: "To the Nodal Officer, {{bank}}\n\nSir/Madam,\n\nIn {{caseReference}} of {{station}} ({{sections}}): {{relevance}}\n\nKindly furnish:\n{{items}}\n\nKindly reply quoting {{requestReference}}.\n\n{{officerName}}, {{officerRank}}\n{{signature}}",
  },
  INFORMATION_OTHER: {
    subject: "{{caseReference}} · {{subjectLabel}} · information request · {{requestReference}}",
    body: "Sir/Madam,\n\nIn {{caseReference}} of {{station}} ({{sections}}): {{relevance}}\n\nKindly furnish{{periodText}}:\n{{items}}\n\nKindly reply quoting {{requestReference}}.\n\n{{officerName}}, {{officerRank}}\n{{signature}}",
  },
  INFORMATION_VICTIM_BANK: {
    subject: "{{caseReference}} · debit details of the complainant's account {{subjectShort}} · {{requestReference}}",
    body: "To the Nodal Officer, {{bank}}\n\nSir/Madam,\n\nIn {{caseReference}} of {{station}}, {{district}} ({{sections}}), {{lossNote}}\n\nUnder Section 94 BNSS, kindly furnish{{periodText}}:\n{{items}}\n\n{{firCopyNote}}Kindly reply to this mailbox, quoting {{requestReference}}.\n\n{{officerName}}, {{officerRank}}\n{{signature}}",
  },
  INFORMATION_WHATSAPP: {
    subject: "{{caseReference}} · WhatsApp account on {{subjectValue}} · {{requestReference}}",
    body: "To the Law Enforcement Response Team, {{bank}}\n\nSir/Madam,\n\nIn {{caseReference}} of {{station}} ({{sections}}): {{relevance}}\n\nKindly furnish, and preserve pending legal process:\n{{items}}\n\n{{firCopyNote}}Kindly reply quoting {{requestReference}}.\n\n{{officerName}}, {{officerRank}}\n{{signature}}",
  },
  INFORMATION_WEBSITE: {
    subject: "{{caseReference}} · registrant and hosting details · {{subjectLabel}} · {{requestReference}}",
    body: "To the Law Enforcement Response Team, {{bank}}\n\nSir/Madam,\n\nIn {{caseReference}} of {{station}} ({{sections}}), the following website was used to commit the offence: {{subjectValue}}.\n\nKindly furnish, and preserve pending legal process:\n{{items}}\n\n{{firCopyNote}}Kindly reply quoting {{requestReference}}.\n\n{{officerName}}, {{officerRank}}\n{{signature}}",
  },
  INFORMATION_ACCOUNT: {
    subject: "{{caseReference}} · account details · {{subjectValue}} · {{requestReference}}",
    body: "To the Law Enforcement Response Team, {{bank}}\n\nSir/Madam,\n\nIn {{caseReference}} of {{station}} ({{sections}}), {{relevance}}\n\nKindly furnish the following about {{subjectValue}}{{periodText}}:\n{{items}}\n\n{{firCopyNote}}Kindly reply quoting {{requestReference}}.\n\n{{officerName}}, {{officerRank}}\n{{signature}}",
  },
  PRESERVATION: {
    subject: "{{caseReference}} · preservation request · {{subjectLabel}} · {{requestReference}}",
    body: "Sir/Madam,\n\nIn {{caseReference}} of {{station}} ({{sections}}), kindly preserve the records you hold for {{subjectValue}} while the disclosure process is pursued. This is a preservation request only; it does not ask for disclosure.\n\nKindly confirm:\n{{items}}\n\nReference: {{requestReference}}\n\n{{officerName}}, {{officerRank}}\n{{signature}}",
  },
  RESTORATION: {
    subject: "{{caseReference}} · restoration of held funds · {{subjectLabel}} {{subjectShort}} · {{requestReference}}",
    body: "To the Nodal Officer, {{bank}}\n\nSir/Madam,\n\nIn {{caseReference}} of {{station}}, kindly restore the funds held in {{subjectValue}} as directed.\n\nAuthority: [record the order or approval reference before approval]\n\nKindly confirm:\n{{items}}\n\nReference: {{requestReference}}\n\n{{officerName}}, {{officerRank}}\n{{signature}}",
  },
  FOLLOW_UP: {
    subject: "Reminder: {{parentReference}} · outstanding items · {{caseReference}}",
    body: "Sir/Madam,\n\nWith reference to {{parentReference}} concerning {{subjectLabel}}, the following items are still outstanding:\n\n{{outstandingItems}}\n\nKindly furnish them, quoting {{requestReference}}.\n\n{{officerName}}, {{officerRank}}\n{{signature}}",
  },
};

/** Rules whose requests have their own wording and items. */
const RULE_TEMPLATES: Record<string, string> = { FUNDS_VICTIM_DEBITS: "INFORMATION_VICTIM_BANK", IDENTITY_WHATSAPP: "INFORMATION_WHATSAPP", EVIDENCE_WEBSITE: "INFORMATION_WEBSITE", IDENTITY_ACCOUNT_DETAILS: "INFORMATION_ACCOUNT" };
const RULE_ITEMS: Record<string, { label: string; itemType: string }[]> = {
  FUNDS_VICTIM_DEBITS: [
    { label: "Each debit to the fraudsters in the period: date, time, amount and UTR/RRN", itemType: "STATEMENT" },
    { label: "For each debit, the beneficiary account number, IFSC and bank", itemType: "BENEFICIARY_DETAILS" },
    { label: "The status of any recall, chargeback or complaint raised on these debits, with its reference", itemType: "OTHER" },
  ],
  IDENTITY_WHATSAPP: [
    { label: "Basic subscriber information: registration date, name, email and device details of the account", itemType: "ACCOUNT_DETAILS" },
    { label: "IP addresses with timestamps (and time zone) of registration and recent logins", itemType: "IP_LOGS" },
    { label: "Confirmation that the account's records are preserved, and until when", itemType: "PRESERVATION_CONFIRMATION" },
  ],
  IDENTITY_ACCOUNT_DETAILS: [
    { label: "Registration details: name given, date of creation, registered phone numbers and recovery email", itemType: "ACCOUNT_DETAILS" },
    { label: "IP addresses with date, time and time zone of the registration and of the logins during the offence", itemType: "IP_LOGS" },
    { label: "Other accounts linked to it by the same phone number, recovery email or device", itemType: "LINKED_CONTACTS" },
    { label: "Confirmation that these records are kept until the investigation is complete", itemType: "PRESERVATION_CONFIRMATION" },
  ],
  EVIDENCE_WEBSITE: [
    { label: "Registrant name, address, email and phone, with the date of registration", itemType: "ACCOUNT_DETAILS" },
    { label: "Payment details for the domain (mode, transaction ID, card or account used)", itemType: "OTHER" },
    { label: "IP addresses with timestamps of registration and account logins", itemType: "IP_LOGS" },
    { label: "The hosting provider and name servers of the site", itemType: "OTHER" },
    { label: "Confirmation that the records are preserved, and until when", itemType: "PRESERVATION_CONFIRMATION" },
  ],
};

function templateKey(category: string, kind: string | null): string {
  if (category !== "INFORMATION") return category;
  if (kind === "BANK_ACCOUNT" || kind === "UPI_ID" || kind === "WALLET") return "INFORMATION_BANK";
  if (kind === "PHONE") return "INFORMATION_PHONE";
  if (kind === "IP_ADDRESS") return "INFORMATION_IP";
  return "INFORMATION_OTHER";
}

const lossText = (claims: { lossAmountMinor: bigint }[]) => {
  const total = claims.reduce((a, c) => a + c.lossAmountMinor, 0n);
  return total > 0n ? formatInr(total) : "money";
};
const startOfIstDay = (d: Date) => istInputToUtc(`${utcToIstDateInput(d)}T00:00`)!;
const endOfIstDay = (d: Date) => istInputToUtc(`${utcToIstDateInput(d)}T23:59:59`)!;

/** Who holds the records a request asks for, in a real case: the provider to find on the nodal officer list. */
function providerFor(entity: { kind: string; value: string; caseRole: string | null; attributesJson: string }, category: string, ruleId: string | null): { provider: Provider; organisationType: string } | { gap: GapKind } | null {
  const a = parseAttributes(entity.attributesJson);
  const recorded = [a.provider, a.registrar].find((x): x is string => typeof x === "string" && !!x.trim());
  const bank = typeof a.bank === "string" && a.bank.trim() ? a.bank.trim() : null;
  switch (entity.kind) {
    case "BANK_ACCOUNT":
    case "WALLET":
      return bank ? { provider: bankProvider(bank), organisationType: "BANK" } : { gap: "BANK" };
    case "UPI_ID":
      if (category === "INFORMATION") return { provider: PROVIDERS.npci, organisationType: "NPCI" };
      return bank ? { provider: bankProvider(bank), organisationType: "BANK" } : { gap: "UPI_BANK" };
    case "EMAIL": {
      const p = recorded ? providerByName(recorded) : emailProvider(entity.value);
      return p ? { provider: p, organisationType: "PLATFORM" } : { gap: "MAIL_PROVIDER" };
    }
    case "PLATFORM_PROFILE": {
      const p = recorded ? providerByName(recorded) : platformProvider((a.platform as string | undefined) ?? entity.caseRole);
      return p ? { provider: p, organisationType: "PLATFORM" } : { gap: "PLATFORM" };
    }
    case "WEBSITE":
      return recorded ? { provider: providerByName(recorded), organisationType: "PLATFORM" } : { gap: "REGISTRAR" };
    case "PHONE":
      return ruleId === "IDENTITY_WHATSAPP" ? { provider: PROVIDERS.whatsapp, organisationType: "PLATFORM" } : null;
    default:
      return null;
  }
}

/** The details of the case the guidance for a missing detail is written from. */
async function gapContext(db: Db | Tx, caseId: string, category: string, subject: { id: string; kind: string; value: string; label: string } | null): Promise<GapContext> {
  const [kase, incoming, victimAccounts, fir, debits] = await Promise.all([
    db.case.findUniqueOrThrow({ where: { id: caseId }, select: { complaintRef: true } }),
    subject ? db.transaction.findMany({ where: { caseId, toEntityId: subject.id }, orderBy: { occurredAt: "asc" }, select: { amountMinor: true, occurredAt: true, reference: true } }) : [],
    db.entity.findMany({ where: { caseId, kind: "BANK_ACCOUNT" }, select: { attributesJson: true, caseRole: true, belongsTo: true } }),
    db.evidenceItem.findFirst({ where: { caseId, category: "FIR_COPY" }, select: { id: true } }),
    db.task.findFirst({ where: { caseId, ruleId: "FUNDS_VICTIM_DEBITS", status: { in: ["OPEN", "DRAFT_PREPARED", "WAITING"] } }, select: { title: true } }),
  ]);
  const victimBanks = [...new Set(victimAccounts.filter((e) => isVictimOwned({ caseRole: e.caseRole, attributes: parseAttributes(e.attributesJson), belongsTo: e.belongsTo })).map((e) => parseAttributes(e.attributesJson).bank).filter((b): b is string => typeof b === "string" && !!b.trim()))];
  const own = subject ? await db.entity.findUnique({ where: { id: subject.id }, select: { caseRole: true, attributesJson: true, belongsTo: true } }) : null;
  const subjectIsVictims = !!own && isVictimOwned({ caseRole: own.caseRole, attributes: parseAttributes(own.attributesJson), belongsTo: own.belongsTo });
  return { caseId, category, subject, subjectIsVictims, incoming, victimBanks, victimDebitsAction: debits ? `“${debits.title}”` : null, hasFirCopy: !!fir, complaintRef: kase.complaintRef };
}

/**
 * What stops a proposed request from being addressed (null when nothing does), with the steps to find it: shown on
 * the action before the officer tries, never as an error. A request can still be drafted without the addressee.
 */
export async function draftGap(db: Db | Tx, kase: { id: string; isDemo: boolean }, task: { ruleId: string | null; requestCategory: string | null; subjectEntityIdsJson: string }): Promise<DraftGap | null> {
  if (!task.requestCategory) return null;
  const subjectId = (JSON.parse(task.subjectEntityIdsJson) as string[])[0];
  const subject = subjectId ? await db.entity.findUnique({ where: { id: subjectId } }) : null;
  if (!subject) return draftGapFor("NO_SUBJECT", await gapContext(db, kase.id, task.requestCategory, null));
  const ctx = () => gapContext(db, kase.id, task.requestCategory!, subject);
  if (!kase.isDemo) {
    const need = providerFor(subject, task.requestCategory, task.ruleId);
    if (need && "gap" in need) return draftGapFor(need.gap, await ctx());
    if (need) return (await nodalAddressAvailable(db, need.provider)) ? null : draftGapFor("NODAL_ADDRESS", { ...(await ctx()), providerName: need.provider.name });
    const found = await db.routingRule.findMany({ where: { subjectKind: subject.kind, category: task.requestCategory, active: true }, include: { recipient: true } });
    return found.some((r) => r.resolveBy === "FIXED" && r.recipient?.active && (!r.recipient.isSynthetic || DEPARTMENTAL.includes(r.recipient.organisationType))) ? null : draftGapFor("ROUTE", await ctx());
  }
  const knownBank = parseAttributes(subject.attributesJson).bank;
  if (await resolveRoute(db, kase.id, task.requestCategory, subject, { isDemo: true })) return null;
  // A demonstration case: an account whose bank is unknown is a missing bank, anything else a missing route.
  return draftGapFor(subject.kind === "BANK_ACCOUNT" && !knownBank ? "BANK" : "ROUTE", { ...(await ctx()), providerName: typeof knownBank === "string" ? knownBank : null });
}

/** Why a proposed request cannot be addressed yet, as one line (null when it can). */
export async function draftBlocker(db: Db | Tx, kase: { id: string; isDemo: boolean }, task: { ruleId: string | null; requestCategory: string | null; subjectEntityIdsJson: string }): Promise<string | null> {
  return (await draftGap(db, kase, task))?.message ?? null;
}

export async function resolveRoute(tx: Tx | Db, caseId: string, category: string, entity: { id: string; kind: string; value?: string; caseRole?: string | null; attributesJson: string }, opts: { isDemo?: boolean; ruleId?: string | null } = {}) {
  const found = await tx.routingRule.findMany({ where: { subjectKind: entity.kind, category, active: true }, include: { recipient: true, template: true } });
  // A real case is never written to the synthetic demonstration directory: banks, platforms and mail providers come
  // from the nodal officer list (unverified until a supervisor checks them); departmental routes (UNICROSS) stay.
  if (opts.isDemo === false) {
    const need = providerFor({ kind: entity.kind, value: entity.value ?? "", caseRole: entity.caseRole ?? null, attributesJson: entity.attributesJson }, category, opts.ruleId ?? null);
    if (need && "gap" in need) throw new AppError(draftGapFor(need.gap, { caseId, category, subject: { id: entity.id, kind: entity.kind, value: entity.value ?? "", label: entity.value ?? "" }, incoming: [], victimBanks: [], victimDebitsAction: null, hasFirCopy: false, complaintRef: null }).message, "PRECONDITION");
    if (need) {
      const recipient = await nodalRecipientFor(tx, need.provider, { organisationType: need.organisationType, category });
      if (!recipient) throw new AppError(`${need.provider.name} has no email address on the nodal officer list. Import a newer list (Settings → Nodal officers), or add ${need.provider.name}'s confirmed address to the recipient directory in the station configuration with "synthetic": false; then draft again.`, "PRECONDITION");
      if (!recipient.active) throw new AppError(`The directory entry for ${need.provider.name} (${recipient.address}) is switched off. Turn it back on in Settings → Recipients, then draft again.`, "PRECONDITION");
      return { rule: found[0] ?? null, recipient };
    }
    const departmental = found.filter((r) => r.resolveBy === "FIXED" && r.recipient && (!r.recipient.isSynthetic || DEPARTMENTAL.includes(r.recipient.organisationType)));
    const usable = departmental.find((r) => r.recipient?.active);
    return usable?.recipient ? { rule: usable, recipient: usable.recipient } : null;
  }
  // A rule may name attributes the identifier must have (e.g. { "platform": "Dating platform" }); those are tried first.
  const conditions = (r: { matchJson: string | null }) => Object.entries((r.matchJson ? JSON.parse(r.matchJson) : {}) as Record<string, unknown>);
  const rules = [...found].sort((a, b) => conditions(b).length - conditions(a).length);
  const attrs = parseAttributes(entity.attributesJson);
  for (const rule of rules) {
    if (!conditions(rule).every(([k, v]) => String(attrs[k] ?? "").toLowerCase() === String(v).toLowerCase())) continue;
    if (rule.resolveBy === "FIXED") {
      if (rule.recipient?.active) return { rule, recipient: rule.recipient };
      continue;
    }
    let bank: string | null = null;
    if (rule.resolveBy === "ACCOUNT_BANK") bank = (parseAttributes(entity.attributesJson).bank as string | undefined) ?? null;
    if (rule.resolveBy === "LINKED_ACCOUNT_BANK") {
      const links = await tx.relationship.findMany({ where: { caseId, OR: [{ fromEntityId: entity.id }, { toEntityId: entity.id }] }, include: { fromEntity: true, toEntity: true } });
      const account = links.map((l) => (l.fromEntityId === entity.id ? l.toEntity : l.fromEntity)).find((e) => e.kind === "BANK_ACCOUNT");
      bank = account ? ((parseAttributes(account.attributesJson).bank as string | undefined) ?? null) : null;
    }
    if (!bank) continue;
    const candidates = await tx.recipient.findMany({ where: { organisation: bank, organisationType: "BANK", active: true } });
    const supporting = candidates.filter((r) => (JSON.parse(r.categoriesJson) as string[]).includes(category));
    const recipient = supporting.find((r) => r.verificationStatus === "VERIFIED") ?? supporting[0];
    if (recipient) return { rule, recipient };
  }
  return null;
}

/** The one directory entry an unaddressed draft points at: switched off, never sent to, with a reserved address. */
export async function unaddressedRecipient(tx: Tx | Db) {
  const found = await tx.recipient.findFirst({ where: { organisationType: "UNADDRESSED" } });
  if (found) return found;
  return tx.recipient.create({
    data: {
      name: "Nodal officer (not yet known)",
      organisation: "Addressee not yet known",
      organisationType: "UNADDRESSED",
      channel: "EMAIL",
      address: "addressee-not-known@example.invalid",
      verificationStatus: "UNVERIFIED",
      categoriesJson: JSON.stringify(["INFORMATION", "PRESERVATION", "HOLD", "RESTORATION"]),
      active: false,
      isSynthetic: false,
      notes: "Stands in for the addressee of a draft written before the addressee is known. Nothing is ever sent to it.",
    },
  });
}

/**
 * Creates (or returns the existing) draft request for a recommended action. Never sends anything. When the addressee
 * cannot be found yet and `withoutAddressee` is set, the draft is written in full with the addressee left blank (it
 * can be edited and printed, not approved or sent); it is addressed in place once the missing detail is recorded.
 */
export function prepareDraftFromTask(db: Db, user: SessionUser, taskId: string, opts: { asAssistant?: boolean; withoutAddressee?: boolean } = {}) {
  return db.$transaction(async (tx) => {
    const task = await tx.task.findUnique({ where: { id: taskId } });
    if (!task) throw notFoundError("task");
    const kase = await loadCaseForUser(tx, user, task.caseId, "write");
    const authorId = opts.asAssistant ? await assistantAuthorId(tx, kase.stationId) : null;
    const isFollowUp = task.dedupeKey.startsWith("FOLLOWUP:");

    // A real case's unsent draft that was addressed to the demonstration directory is re-addressed in place.
    // So is a draft written without its addressee, once the missing detail is recorded.
    let reroute: { id: string; version: number; reference: string; from: string; unaddressed: boolean } | null = null;
    if (task.requestId && !isFollowUp) {
      const existing = await tx.request.findUnique({ where: { id: task.requestId }, include: { recipient: true } });
      if (existing && ACTIVE.includes(existing.status)) {
        const demoAddress = !kase.isDemo && UNSENT.includes(existing.status) && existing.recipient.isSynthetic && !DEPARTMENTAL.includes(existing.recipient.organisationType);
        const unaddressed = UNSENT.includes(existing.status) && existing.recipient.organisationType === "UNADDRESSED";
        if (!demoAddress && !unaddressed) return getRequestState(tx, existing.id);
        reroute = { id: existing.id, version: existing.version, reference: existing.reference, from: existing.recipient.organisation, unaddressed };
      }
    }
    if (!task.requestCategory) throw new AppError("This action does not involve a request to an external recipient.", "PRECONDITION");
    // An email address or profile used to get a preservation request; it is now asked for its details. A preservation
    // draft the assistant wrote for it and that was never sent is taken over (same reference) and rewritten.
    let adopt = false;
    if (!reroute && !task.requestId && task.ruleId === "IDENTITY_ACCOUNT_DETAILS") {
      const sid = (JSON.parse(task.subjectEntityIdsJson) as string[])[0];
      const assistant = await assistantAuthorId(tx, kase.stationId);
      const old = sid && assistant ? await tx.request.findFirst({ where: { caseId: kase.id, category: "PRESERVATION", parentRequestId: null, status: { in: UNSENT }, subjects: { some: { entityId: sid } } }, include: { recipient: true, versions: { select: { createdById: true } } } }) : null;
      if (old && old.versions.every((v) => v.createdById === assistant)) {
        reroute = { id: old.id, version: old.version, reference: old.reference, from: old.recipient.organisation, unaddressed: old.recipient.organisationType === "UNADDRESSED" };
        adopt = true;
      }
    }

    // The officer's own From address and closing, when they have set them; the station's otherwise.
    const mail = await mailDefaultsFor(tx, user);
    const sign = (body: string) => withClosing(body, user, getAppConfig().mailbox, mail.closing);
    const fromAddress = mail.own.from ? mail.from : null;
    const vars: Record<string, string> = {
      caseReference: caseReference(kase),
      station: kase.station.name,
      officerName: user.displayName,
      officerRank: user.rank,
      relevance: task.relevance,
      requestReference: "{{requestReference}}", // replaced with the new reference when the draft is created
      signature: getAppConfig().mailbox.signature.join("\n"),
      stationAddress: getAppConfig().station.address,
      stationPhone: getAppConfig().station.phone,
      stationEmail: getAppConfig().station.email,
      fromAddress: getAppConfig().mailbox.fromAddress,
    };

    if (isFollowUp) {
      const parent = await tx.request.findUnique({ where: { id: task.dedupeKey.slice("FOLLOWUP:".length) }, include: { items: { orderBy: { sortOrder: "asc" } }, subjects: { include: { entity: true } } } });
      if (!parent) throw notFoundError("request");
      const child = await tx.request.findFirst({ where: { parentRequestId: parent.id, status: { in: UNSENT } } });
      if (child) return getRequestState(tx, child.id);
      const outstanding = parent.items.filter((i) => i.status === "PENDING" || i.status === "PARTIAL");
      const items = (outstanding.length ? outstanding : parent.items).map((i) => ({ label: i.label, itemType: i.itemType }));
      const version = await tx.requestVersion.findUniqueOrThrow({ where: { requestId_versionNo: { requestId: parent.id, versionNo: parent.currentVersionNo } } });
      const tpl = (await tx.template.findFirst({ where: { category: "FOLLOW_UP", active: true } })) ?? null;
      const fv = {
        ...vars,
        parentReference: parent.reference,
        subjectLabel: parent.subjects.map((s) => `${s.entity.label} (${s.entity.value})`).join(", ") || "the subject of the original request",
        outstandingItems: items.map((i) => `- ${i.label}`).join("\n"),
        responseDate: parent.submittedAt ? formatDateIST(parent.submittedAt) : "",
      };
      return createDraftTx(tx, user, {
        caseId: kase.id,
        category: parent.category,
        recipientId: parent.recipientId,
        routeId: parent.routeId,
        subject: renderSubject(tpl?.subjectTemplate ?? DEFAULT_TEMPLATES.FOLLOW_UP!.subject, fv),
        body: sign(renderTemplate(tpl?.bodyTemplate ?? DEFAULT_TEMPLATES.FOLLOW_UP!.body, fv)),
        fromAddress,
        scope: `Outstanding items from ${parent.reference}`,
        periodFrom: version.periodFrom,
        periodTo: version.periodTo,
        items,
        subjectEntityIds: parent.subjects.map((s) => s.entityId),
        taskId: task.id,
        parentRequestId: parent.id,
        authorId,
      });
    }

    const subjectIds = JSON.parse(task.subjectEntityIdsJson) as string[];
    const subject = subjectIds.length ? await tx.entity.findUnique({ where: { id: subjectIds[0] } }) : null;
    if (!subject || subject.caseId !== kase.id) throw new AppError("This action has no identifier to address the request to.", "PRECONDITION");
    let route: Awaited<ReturnType<typeof resolveRoute>> = null;
    try {
      route = await resolveRoute(tx, kase.id, task.requestCategory, subject, { isDemo: kase.isDemo, ruleId: task.ruleId });
    } catch (err) {
      if (!(err instanceof AppError && err.code === "PRECONDITION")) throw err;
    }
    // The addressee cannot be found yet: say what is missing, or (when asked) draft it with the addressee left blank.
    let gap: DraftGap | null = null;
    if (!route) {
      gap = (await draftGap(tx, kase, task)) ?? draftGapFor("ROUTE", await gapContext(tx, kase.id, task.requestCategory, subject));
      if (reroute?.unaddressed && !adopt) {
        if (opts.withoutAddressee) return getRequestState(tx, reroute.id);
        throw new AppError(`${gap.missing} Record it first; the draft is kept as it is.`, "PRECONDITION");
      }
      // A preservation draft being taken over is rewritten even without an addressee: it says whom it is for.
      if (!adopt && (!opts.withoutAddressee || !gap.canDraftWithout)) throw new AppError(gap.message, "PRECONDITION");
      route = { rule: null, recipient: await unaddressedRecipient(tx) };
    }
    const incoming = await tx.transaction.findMany({ where: { caseId: kase.id, toEntityId: subject.id }, orderBy: { occurredAt: "asc" }, include: { fromEntity: true } });
    const hold = await tx.hold.findFirst({ where: { caseId: kase.id, accountEntityId: subject.id, status: "CONFIRMED_HELD" } });
    // A number the caller used is asked for its call records as well as its subscriber form.
    let items = task.ruleId === "IDENTITY_CALLER_NUMBER" ? CALLER_NUMBER_ITEMS : RULE_ITEMS[task.ruleId ?? ""] ?? defaultItemsFor(task.requestCategory, subject.kind);
    if (task.requestCategory === "INFORMATION" && subject.kind === "BANK_ACCOUNT" && task.scope?.startsWith("KYC only")) {
      items = items.filter((i) => i.itemType === "KYC" || i.itemType === "LINKED_CONTACTS");
    } else if (task.requestCategory === "INFORMATION" && subject.kind === "BANK_ACCOUNT" && task.ruleId !== "FUNDS_VICTIM_DEBITS") {
      // The balance is not asked for once a bank has confirmed the hold; each cash withdrawal asks for its ATM.
      if (hold) items = items.filter((i) => i.itemType !== "BALANCE_CONFIRMATION");
      const cash = await tx.transaction.findMany({ where: { caseId: kase.id, fromEntityId: subject.id, kind: "CASH_WITHDRAWAL" }, orderBy: { occurredAt: "asc" } });
      items = [...items, ...cash.map((c) => ({ label: `ATM ID, location and CCTV retention for the ${formatInr(c.amountMinor)} withdrawal on ${formatDateTimeIST(c.occurredAt, { label: false })}`, itemType: "ATM_DETAILS" }))];
    }
    // The complainant's own account is asked about the period of the offence: from its start to the day it was reported.
    const victimDebits = task.ruleId === "FUNDS_VICTIM_DEBITS";
    const reported = kase.reportedAt ?? kase.registeredAt ?? null;
    const fromDate = task.periodFrom ?? (victimDebits ? (kase.incidentStart ?? (reported ? new Date(reported.getTime() - 30 * 86400000) : null)) : null);
    const toDate = task.periodTo ?? (victimDebits ? (kase.incidentEnd ?? reported) : null);
    const periodFrom = fromDate ? startOfIstDay(fromDate) : null;
    const periodTo = toDate ? endOfIstDay(toDate) : null;
    const bank = gap ? `[${gap.addressee}: to be filled in]` : ((parseAttributes(subject.attributesJson).bank as string | undefined) ?? route.recipient.organisation);
    // The subject in full in the draft's subject line: the recipient needs the whole number to find it.
    const subjectShort = subject.kind === "PHONE" || subject.kind === "BANK_ACCOUNT" ? shownId(subject.value) : "";
    const moneyIn = incoming.length
      ? `${incoming
          .map((t) => {
            const verb = t.kind === "VICTIM_PAYMENT" ? "was paid" : "was transferred";
            const from = t.kind === "VICTIM_PAYMENT" ? "" : ` from ${t.fromEntity.label}${parseAttributes(t.fromEntity.attributesJson).bank ? ` (${parseAttributes(t.fromEntity.attributesJson).bank})` : ""}`;
            return `${formatInr(t.amountMinor)} ${verb} on ${formatDateIST(t.occurredAt)}${from}${t.reference && !t.reference.includes("?") ? ` (ref ${t.reference})` : ""}`;
          })
          .join("; ")} to account ${subject.value} with your bank.`
      : `account ${subject.value} with your bank is linked to the offence.`;
    const filled: Record<string, string> = {
      ...vars,
      subjectLabel: subject.label,
      subjectValue: subject.value,
      subjectShort,
      moneyIn,
      holdNote: hold?.bankReference ? ` A hold was confirmed under reference ${hold.bankReference}.` : "",
      sections: kase.legalSections ? formatSections(kase.legalSections) : "sections as registered",
      district: kase.station.district,
      bank,
      transactions: incoming.length ? incoming.map((t) => `- ${formatDateTimeIST(t.occurredAt)}: ${formatInr(t.amountMinor)}${t.reference ? ` (ref ${t.reference})` : ""}`).join("\n") : "- No transactions recorded yet",
      items: items.map((i) => `- ${i.label}`).join("\n"),
      periodFrom: periodFrom ? formatDateIST(periodFrom) : "",
      periodTo: periodTo ? formatDateIST(periodTo) : "",
      periodText: periodFrom && periodTo ? `, for ${formatDateIST(periodFrom)} to ${formatDateIST(periodTo)}` : periodFrom ? `, from ${formatDateIST(periodFrom)} to date` : "",
      scope: task.scope ?? "",
      lossNote: victimDebits ? `the complainant, who holds account ${subject.value} with your bank, reports ${lossText(await tx.victimClaim.findMany({ where: { caseId: kase.id } }))} lost to the fraud from it. The accounts the money went to are not yet known.` : "",
    };
    // The FIR copy goes with every first request; the letter says so only when there is one to attach.
    const firCopy = await tx.evidenceItem.findFirst({ where: { caseId: kase.id, category: "FIR_COPY", derivation: "ORIGINAL" }, orderBy: { receivedAt: "asc" } });
    filled.firCopyNote = firCopy ? "Signed FIR copy attached. " : "";
    if (reroute) {
      const key = RULE_TEMPLATES[task.ruleId ?? ""] ?? templateKey(task.requestCategory, subject.kind);
      const tpl = (RULE_TEMPLATES[task.ruleId ?? ""] ? null : route.rule?.template) ?? (await tx.template.findFirst({ where: { category: key, active: true } }));
      const withRef = { ...filled, requestReference: reroute.reference };
      const readdressed = await updateDraftTx(
        tx,
        user,
        reroute.id,
        {
          expectedVersion: reroute.version,
          recipientId: route.recipient.id,
          subject: renderSubject(tpl?.subjectTemplate ?? DEFAULT_TEMPLATES[key]!.subject, withRef),
          body: sign(renderTemplate(tpl?.bodyTemplate ?? DEFAULT_TEMPLATES[key]!.body, withRef)),
          scope: task.scope ?? task.title,
          periodFrom,
          periodTo,
          items,
          attachmentIds: firCopy ? [firCopy.id] : [],
          changeNote: adopt
            ? "Rewritten as a request for the account's details (who registered it, its phone numbers and login IPs); it was a preservation request."
            : reroute.unaddressed
              ? `Addressed to ${route.recipient.organisation} (${route.recipient.address}) now that the missing detail is recorded.`
              : `Re-addressed from the demonstration entry "${reroute.from}" to ${route.recipient.organisation} (${route.recipient.address}).`,
        },
        authorId ?? user.id,
      );
      if (adopt) {
        await tx.request.update({ where: { id: reroute.id }, data: { category: task.requestCategory, taskId: task.id, routeId: route.rule?.id ?? null, version: { increment: 1 } } });
        await tx.task.update({ where: { id: task.id }, data: { requestId: reroute.id, status: "DRAFT_PREPARED", version: { increment: 1 } } });
        await recordAudit(tx, { caseId: kase.id, actorId: authorId ?? user.id, action: "request.rewritten_as_details", objectType: "Request", objectId: reroute.id, summary: `${reroute.reference} rewritten from a preservation request into a request for the account's details` });
      }
      // Rewritten just now from the case as it stands, so an earlier "facts changed" flag no longer applies.
      if (readdressed.needsReview) {
        await tx.request.update({ where: { id: reroute.id }, data: { needsReview: false, needsReviewReason: null, version: { increment: 1 } } });
        await recordAudit(tx, { caseId: kase.id, actorId: user.id, action: "request.review_cleared", objectType: "Request", objectId: reroute.id, summary: `${reroute.reference} rewritten from the current case when it was addressed; the earlier review flag is cleared` });
      }
      return getRequestState(tx, reroute.id);
    }
    const key = RULE_TEMPLATES[task.ruleId ?? ""] ?? templateKey(task.requestCategory, subject.kind);
    const tpl = (RULE_TEMPLATES[task.ruleId ?? ""] ? null : route.rule?.template) ?? (await tx.template.findFirst({ where: { category: key, active: true } }));
    const created = await createDraftTx(tx, user, {
      caseId: kase.id,
      category: task.requestCategory,
      recipientId: route.recipient.id,
      routeId: route.rule?.id ?? null,
      subject: renderSubject(tpl?.subjectTemplate ?? DEFAULT_TEMPLATES[key]!.subject, filled),
      body: sign(renderTemplate(tpl?.bodyTemplate ?? DEFAULT_TEMPLATES[key]!.body, filled)),
      fromAddress,
      scope: task.scope ?? task.title,
      periodFrom,
      periodTo,
      items,
      // A site's request covers every address on it.
      subjectEntityIds: task.ruleId === "EVIDENCE_WEBSITE" ? subjectIds : [subject.id],
      attachmentIds: firCopy ? [firCopy.id] : [],
      taskId: task.id,
      authorId,
    });
    if (gap) {
      await recordAudit(tx, { caseId: kase.id, actorId: user.id, action: "request.drafted_without_addressee", objectType: "Request", objectId: created.id, summary: `${created.reference} drafted with the addressee left blank: ${gap.missing} It cannot be approved or sent until it is addressed.` });
    }
    return created;
  });
}
