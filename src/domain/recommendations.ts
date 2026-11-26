/**
 * Next-action engine. Pure and deterministic: given a snapshot of case facts it derives the
 * justified next actions, each stating the unresolved question, purpose, relevance, supporting
 * sources, intended recipient, scope, prerequisites and expected clarification.
 *
 * Each recommendation has a stable dedupeKey. The service layer reconciles these with stored
 * tasks: existing tasks are updated rather than duplicated, and tasks whose condition no longer
 * holds are closed with the reason returned by explainResolution().
 */
import { formatInr } from "./money";
import { formatDateIST, formatDayMonthIST, formatTimeIST } from "./time";
import { emailProvider, isVictimOwned, platformProvider, PLATFORM_HOSTS, providerByName, siteHost } from "./providers";

export type Objective = "FINANCIAL" | "IDENTITY" | "EVIDENCE";
export type TaskKind = "RECOMMENDATION" | "MISSING_INFORMATION" | "REVIEW" | "EXTERNAL_SUBMISSION" | "OFFICER_TASK" | "DECISION";
/** BLOCKED: cannot start until another action delivers what it needs (see the prerequisite's dependsOn). */
export type RecoStatus = "OPEN" | "WAITING" | "DRAFT_PREPARED" | "BLOCKED";

export interface FactEntity {
  id: string;
  kind: string;
  label: string;
  value: string;
  attributes: { bank?: string; ifsc?: string; [k: string]: unknown };
  caseRole: string | null;
  /** The officer's note of whose it is (VICTIM, SUSPECT …). */
  belongsTo?: string | null;
}

export interface RecoFacts {
  now: Date;
  /**
   * A demonstration case routes through the synthetic directory. A real case routes through the nodal officer list,
   * so its actions wait until the bank, platform, mail host or registrar is known. Absent means a demonstration case.
   */
  isDemo?: boolean;
  entities: FactEntity[];
  victimAccountIds: string[];
  transactions: { id: string; fromEntityId: string; toEntityId: string; amountMinor: bigint; layer: number; kind: string; occurredAt: Date; reference: string | null }[];
  holds: { id: string; accountEntityId: string; status: string; confirmedMinor: bigint | null }[];
  allocations: { holdId: string; amountMinor: bigint; status: string }[];
  refunds: { holdId: string | null; status: string }[];
  requests: {
    id: string;
    reference: string;
    category: string;
    status: string;
    recipientName: string;
    subjectEntityIds: string[];
    items: { itemType: string; status: string }[];
    followUpAt: Date | null;
    parentRequestId: string | null;
  }[];
  responses: { id: string; requestId: string | null; requestReference: string | null; recipientName: string; reviewStatus: string; matchStatus: string }[];
  relationships: { id: string; fromEntityId: string; toEntityId: string; type: string; statement: string }[];
  locations: { id: string; entityId: string | null; observationType: string; limitations: string | null; locationText?: string; eventAt?: Date | null; atmId?: string | null; description?: string }[];
  /** Victim claims (loss per victim). Optional for callers that do not need allocation rules. */
  claims?: { id: string; victimEntityId: string; lossMinor: bigint }[];
  /** Bases recorded for splitting held money between victims (newest last). */
  allocationDecisions?: { method: string; decidedAt: Date }[];
  sources: { subjectType: string; subjectId: string; evidenceId: string; locator: string; excerpt: string }[];
}

export interface Prerequisite {
  label: string;
  met: boolean;
  basis: string;
  /** dedupeKey of the action that will meet this prerequisite, when another action has to come first. */
  dependsOn?: string;
}

export interface Recommendation {
  dedupeKey: string;
  ruleId: string;
  kind: TaskKind;
  objective: Objective;
  title: string;
  question: string;
  purpose: string;
  relevance: string;
  recipientHint: string | null;
  requestCategory: "INFORMATION" | "PRESERVATION" | "HOLD" | "RESTORATION" | null;
  subjectEntityIds: string[];
  scope: string | null;
  periodFrom: Date | null;
  periodTo: Date | null;
  prerequisites: Prerequisite[];
  expectedClarification: string;
  priority: "HIGH" | "NORMAL" | "LOW";
  priorityReason: string;
  status: RecoStatus;
  requestId: string | null;
  responseId: string | null;
  supportingSources: { evidenceId: string; locator: string; excerpt: string }[];
}

const DRAFT_STAGE = ["DRAFT", "AWAITING_APPROVAL", "APPROVED", "SUBMISSION_FAILED"];
const AWAITING = ["SUBMITTED", "ACKNOWLEDGED", "PARTIAL_RESPONSE"];
const ANSWERED = ["COMPLETE_RESPONSE"];
const SENT = [...AWAITING, ...ANSWERED];
const DAY = 24 * 60 * 60 * 1000;

type Req = RecoFacts["requests"][number];

function statusFromRequest(req: Req | undefined): { status: RecoStatus; requestId: string | null } {
  if (!req) return { status: "OPEN", requestId: null };
  if (DRAFT_STAGE.includes(req.status)) return { status: "DRAFT_PREPARED", requestId: req.id };
  return { status: "WAITING", requestId: req.id };
}

/** The most relevant non-rejected request of a category concerning an entity. */
function coveringRequest(f: RecoFacts, category: string, entityId: string): Req | undefined {
  const rank = (s: string) => (ANSWERED.includes(s) ? 3 : AWAITING.includes(s) ? 2 : DRAFT_STAGE.includes(s) ? 1 : 0);
  return f.requests
    .filter((r) => r.category === category && r.subjectEntityIds.includes(entityId) && rank(r.status) > 0)
    .sort((a, b) => rank(b.status) - rank(a.status))[0];
}

function sourcesFor(f: RecoFacts, subjects: { type: string; id: string }[]) {
  const seen = new Set<string>();
  const out: Recommendation["supportingSources"] = [];
  for (const s of f.sources) {
    if (!subjects.some((x) => x.type === s.subjectType && x.id === s.subjectId)) continue;
    const key = `${s.evidenceId}|${s.locator}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ evidenceId: s.evidenceId, locator: s.locator, excerpt: s.excerpt });
  }
  return out;
}

function bankOf(e: FactEntity): string {
  return typeof e.attributes.bank === "string" ? e.attributes.bank : "the account-holding bank";
}
const bankKnown = (e: FactEntity) => typeof e.attributes.bank === "string" && e.attributes.bank.trim() !== "";
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
/** What the officer recorded as the provider (platform, mail host, registrar) of an identifier. */
const recordedProvider = (e: FactEntity) => str(e.attributes.provider) ?? str(e.attributes.registrar);
const LIST = "(from the nodal officer list)";
/** Who holds the records about an identifier, for a real case: null until it is known. */
function providerOf(e: FactEntity): string | null {
  const recorded = recordedProvider(e);
  if (recorded) return providerByName(recorded).name;
  if (e.kind === "EMAIL") return emailProvider(e.value)?.name ?? null;
  if (e.kind === "PLATFORM_PROFILE") return platformProvider(str(e.attributes.platform) ?? e.caseRole)?.name ?? null;
  return null;
}
/** A number written with a country code other than India's. UNICROSS cannot get CDR or CAF for it. */
const foreignNumber = (value: string) => /^\s*\+(?!\s*91)/.test(value);
const onWhatsApp = (e: FactEntity) => /whats\s*app/i.test(`${e.caseRole ?? ""} ${str(e.attributes.platform) ?? ""}`);
/** Roles that say the money went to an identifier, or that it belongs to the other side. */
const AGAINST = /beneficiar|fraudster|accused|suspect|mule|credited|received the|paid to|collection handle/i;

const isConfirmedHold = (s: string) => s === "CONFIRMED_HELD" || s === "RELEASED";

export function deriveRecommendations(f: RecoFacts): Recommendation[] {
  const out: Recommendation[] = [];
  const demo = f.isDemo !== false;
  const entity = new Map(f.entities.map((e) => [e.id, e]));
  const victimAccounts = new Set([...f.victimAccountIds, ...f.entities.filter((e) => isVictimOwned(e)).map((e) => e.id)]);
  const payable = new Set(["BANK_ACCOUNT", "UPI_ID", "WALLET"]);
  const bankHint = (acct: FactEntity) => `${bankOf(acct)}: nodal officer ${demo ? "(from the routing directory)" : LIST}`;
  /** A request that needs the bank: open once it is known, waiting until then. */
  const bankPrereq = (acct: FactEntity): Prerequisite =>
    bankKnown(acct) || demo
      ? { label: "Account number and bank identified", met: true, basis: `${acct.value} at ${bankOf(acct)}` }
      : { label: "Bank identified", met: false, basis: `Record the bank or IFSC of ${acct.value} on the identifier (People & identifiers); the complainant's statement or the NCRP record gives it.` };
  const gated = (prereq: Prerequisite, cover: Req | undefined) => (prereq.met || cover ? statusFromRequest(cover) : { status: "BLOCKED" as const, requestId: null });

  // Accounts that received money in this case (first beneficiaries and onward recipients).
  const recipients = [...new Set(f.transactions.map((t) => t.toEntityId))]
    .map((id) => entity.get(id))
    .filter((e): e is FactEntity => !!e && payable.has(e.kind) && !victimAccounts.has(e.id));

  for (const acct of recipients) {
    const incoming = f.transactions.filter((t) => t.toEntityId === acct.id);
    const outgoing = f.transactions.filter((t) => t.fromEntityId === acct.id);
    const received = incoming.reduce((s, t) => s + t.amountMinor, 0n);
    const onward = outgoing.reduce((s, t) => s + t.amountMinor, 0n);
    const holds = f.holds.filter((h) => h.accountEntityId === acct.id);
    const confirmedHold = holds.find((h) => isConfirmedHold(h.status));
    const heldKnown = holds.reduce((s, h) => s + (h.status === "CONFIRMED_HELD" && h.confirmedMinor !== null ? h.confirmedMinor : 0n), 0n);
    const firstIn = incoming.reduce((m, t) => (t.occurredAt < m ? t.occurredAt : m), incoming[0]!.occurredAt);
    const lastIn = incoming.reduce((m, t) => (t.occurredAt > m ? t.occurredAt : m), incoming[0]!.occurredAt);
    const layer = Math.min(...incoming.map((t) => t.layer));
    const layerText = layer === 1 ? "directly from the victim" : `as an onward transfer (layer ${layer})`;
    const srcs = sourcesFor(f, [...incoming.map((t) => ({ type: "TRANSACTION", id: t.id })), { type: "ENTITY", id: acct.id }]);
    const hasRef = incoming.some((t) => !!t.reference);
    const baseRelevance = `${acct.label} received ${formatInr(received)} ${layerText}, first on ${formatDateIST(firstIn)}.`;
    const recipientHint = acct.kind === "UPI_ID" && !bankKnown(acct) ? `NPCI and the UPI app's bank ${demo ? "(from the routing directory)" : LIST}` : bankHint(acct);
    const bankReq = bankPrereq(acct);

    // Hold.
    if (!confirmedHold) {
      const cover = coveringRequest(f, "HOLD", acct.id);
      if (!cover || !ANSWERED.includes(cover.status)) {
        out.push({
          dedupeKey: `HOLD:${acct.id}`,
          ruleId: "FUNDS_HOLD",
          kind: "RECOMMENDATION",
          objective: "FINANCIAL",
          title: `Request a debit freeze on ${acct.label}`,
          question: `Is any of the ${formatInr(received)} received by ${acct.label} still available to be held?`,
          purpose: "Secure remaining funds before they move further.",
          relevance: `${baseRelevance} Funds in a mule account can be withdrawn at any time.`,
          recipientHint,
          requestCategory: "HOLD",
          subjectEntityIds: [acct.id],
          scope: `Debit freeze on ${acct.value}. Confirm the balance available at the time the freeze is applied.`,
          periodFrom: null,
          periodTo: null,
          prerequisites: [bankReq, { label: "Transaction reference quoted", met: hasRef, basis: hasRef ? "UTR/RRN recorded on the incoming transaction" : "No UTR/RRN recorded yet" }],
          expectedClarification: "Whether a hold was applied, the amount held, and the time the balance was taken.",
          priority: "HIGH",
          priorityReason: "Holds are time-sensitive: the balance can be withdrawn until the bank applies the freeze.",
          ...(acct.kind === "BANK_ACCOUNT" ? gated(bankReq, cover) : statusFromRequest(cover)),
          responseId: null,
          supportingSources: srcs,
        });
      }
    }

    // Statement and KYC.
    const infoCover = coveringRequest(f, "INFORMATION", acct.id);
    const infoAnswered = !!infoCover && (ANSWERED.includes(infoCover.status) || infoCover.status === "PARTIAL_RESPONSE");
    // Money fully held and nothing moved on: there is no onward trail to follow, only the holder to identify.
    const fullyHeld = !!confirmedHold && (confirmedHold.confirmedMinor ?? 0n) >= received && outgoing.length === 0;
    if (!infoAnswered && fullyHeld) {
      out.push({
        dedupeKey: `INFO:${acct.id}`,
        ruleId: "FUNDS_TRACE",
        kind: "RECOMMENDATION",
        objective: "IDENTITY",
        title: `Request KYC from ${bankOf(acct)} for ${acct.label}`,
        question: `Who is recorded as the holder of ${acct.label}?`,
        purpose: "Identify the account holder on record. Nothing moved out of the account, so no statement is needed to follow the money.",
        relevance: `${baseRelevance} The bank holds all of it (${formatInr(confirmedHold!.confirmedMinor ?? 0n)}) and no onward movement is recorded.`,
        recipientHint,
        requestCategory: "INFORMATION",
        subjectEntityIds: [acct.id],
        scope: `KYC only: account-opening documents with photo ID and the registered contact details for ${acct.value}.`,
        periodFrom: null,
        periodTo: null,
        prerequisites: [bankReq],
        expectedClarification: "The KYC holder on record, with photo ID, address and registered contacts.",
        priority: "LOW",
        priorityReason: "The money here is secured; identifying the holder can follow the urgent steps.",
        ...(acct.kind === "BANK_ACCOUNT" ? gated(bankReq, infoCover) : statusFromRequest(infoCover)),
        responseId: null,
        supportingSources: srcs,
      });
    } else if (!infoAnswered) {
      out.push({
        dedupeKey: `INFO:${acct.id}`,
        ruleId: "FUNDS_TRACE",
        kind: "RECOMMENDATION",
        objective: "FINANCIAL",
        title: `Request the statement and KYC for ${acct.label}`,
        question: `Where did the ${formatInr(received)} credited to ${acct.label} go next, and who is recorded as the account holder?`,
        purpose: "Continue the money trail and identify the account holder on record.",
        relevance: `${baseRelevance} No statement has been received for this account yet.`,
        recipientHint,
        requestCategory: "INFORMATION",
        subjectEntityIds: [acct.id],
        scope: `Statement of account, KYC/account-opening details and registered contact details for ${acct.value}.`,
        periodFrom: new Date(firstIn.getTime() - 2 * DAY),
        periodTo: new Date(lastIn.getTime() + 14 * DAY),
        prerequisites: [acct.kind === "BANK_ACCOUNT" ? bankReq : { label: "UPI ID recorded", met: true, basis: acct.value }, { label: "Relevant period known", met: true, basis: `Credits recorded from ${formatDateIST(firstIn)}` }],
        expectedClarification: "Onward transfers with references, cash withdrawals, the remaining balance, and the KYC holder on record.",
        priority: layer === 1 ? "HIGH" : "NORMAL",
        priorityReason: layer === 1 ? "First-layer account: the trail cannot continue without it." : "Onward recipient: extends the trail one layer further.",
        ...(acct.kind === "BANK_ACCOUNT" ? gated(bankReq, infoCover) : statusFromRequest(infoCover)),
        responseId: null,
        supportingSources: srcs,
      });
    }

    // Missing balance / hold status once something has been sent to the bank.
    const sentForAcct = f.requests.filter((r) => r.subjectEntityIds.includes(acct.id) && SENT.includes(r.status) && (r.category === "HOLD" || r.category === "INFORMATION"));
    const balanceAnswered = sentForAcct.some((r) => r.items.some((i) => i.itemType === "BALANCE_CONFIRMATION" && i.status === "RECEIVED"));
    if (!confirmedHold && !balanceAnswered && sentForAcct.length > 0) {
      const remaining = received - onward - heldKnown;
      const child = f.requests.find((r) => r.parentRequestId !== null && sentForAcct.some((s) => s.id === r.parentRequestId) && !["REJECTED", "COMPLETE_RESPONSE"].includes(r.status));
      const waitingOn = sentForAcct.find((r) => AWAITING.includes(r.status));
      const statusInfo = child ? statusFromRequest(child) : waitingOn ? { status: "WAITING" as const, requestId: waitingOn.id } : { status: "OPEN" as const, requestId: null };
      out.push({
        dedupeKey: `BALANCE:${acct.id}`,
        ruleId: "FUNDS_BALANCE_GAP",
        kind: "MISSING_INFORMATION",
        objective: "FINANCIAL",
        title: `Obtain the balance and hold status for ${acct.label}`,
        question: `How much of the ${formatInr(received)} credited to ${acct.label} remains, and is any of it held?${onward > 0n ? ` ${formatInr(onward)} has been traced onward; ${formatInr(remaining > 0n ? remaining : 0n)} is not yet accounted for.` : ""}`,
        purpose: "Establish whether funds can still be secured. Unknown is not zero.",
        relevance: `${baseRelevance} The bank has not confirmed a held amount for this account.`,
        recipientHint,
        requestCategory: "INFORMATION",
        subjectEntityIds: [acct.id],
        scope: `Current balance and lien/hold status for ${acct.value}.`,
        periodFrom: null,
        periodTo: null,
        prerequisites: [{ label: "Request already sent to the bank", met: true, basis: sentForAcct.map((r) => r.reference).join(", ") }],
        expectedClarification: "The balance at the time of the freeze and whether a hold is in place.",
        priority: "HIGH",
        priorityReason: "The amount that can still be secured is unknown until the bank confirms it.",
        ...statusInfo,
        responseId: null,
        supportingSources: srcs,
      });
    }
  }

  // Accounts the FIR or the officer names as receiving the money (or as the other side's) before any bank record shows
  // a payment into them: freeze them and ask for their statement and KYC at once.
  const traced = new Set(recipients.map((a) => a.id));
  for (const acct of f.entities.filter((e) => payable.has(e.kind) && !victimAccounts.has(e.id) && !traced.has(e.id) && (AGAINST.test(e.caseRole ?? "") || e.belongsTo === "SUSPECT"))) {
    const srcs = sourcesFor(f, [{ type: "ENTITY", id: acct.id }]);
    const bankReq = bankPrereq(acct);
    const upi = acct.kind === "UPI_ID";
    const why = `${acct.label} is recorded as: ${acct.caseRole ?? "belonging to the other side (officer's note)"}. No bank record of the payments into it has been received yet.`;
    const holdCover = coveringRequest(f, "HOLD", acct.id);
    // A freeze is placed on the bank account behind a UPI ID, which NPCI's reply names first.
    if (!upi && (!holdCover || !ANSWERED.includes(holdCover.status))) {
      if (!f.holds.some((h) => h.accountEntityId === acct.id && isConfirmedHold(h.status))) {
        out.push({
          dedupeKey: `HOLD:${acct.id}`,
          ruleId: "FUNDS_HOLD",
          kind: "RECOMMENDATION",
          objective: "FINANCIAL",
          title: `Request a debit freeze on ${acct.label}`,
          question: `Is any of the complainant's money still in ${acct.label}?`,
          purpose: "Secure remaining funds before they move further.",
          relevance: `${why} Funds in a mule account can be withdrawn at any time.`,
          recipientHint: bankHint(acct),
          requestCategory: "HOLD",
          subjectEntityIds: [acct.id],
          scope: `Debit freeze on ${acct.value}. Confirm the balance available at the time the freeze is applied.`,
          periodFrom: null,
          periodTo: null,
          prerequisites: [bankReq],
          expectedClarification: "Whether a hold was applied, the amount held, and the time the balance was taken.",
          priority: "HIGH",
          priorityReason: "Holds are time-sensitive: the balance can be withdrawn until the bank applies the freeze.",
          ...gated(bankReq, holdCover),
          responseId: null,
          supportingSources: srcs,
        });
      }
    }
    const infoCover = coveringRequest(f, "INFORMATION", acct.id);
    if (!infoCover || !(ANSWERED.includes(infoCover.status) || infoCover.status === "PARTIAL_RESPONSE")) {
      out.push({
        dedupeKey: `INFO:${acct.id}`,
        ruleId: "FUNDS_TRACE",
        kind: "RECOMMENDATION",
        objective: "FINANCIAL",
        title: upi ? `Ask NPCI which account ${acct.label} is linked to` : `Request the statement and KYC for ${acct.label}`,
        question: upi ? `Which bank account and holder is ${acct.label} linked to?` : `Who holds ${acct.label}, and where did the complainant's money go from it?`,
        purpose: "Identify the account holder on record and continue the money trail.",
        relevance: why,
        recipientHint: upi ? `NPCI ${demo ? "(from the routing directory)" : LIST}` : bankHint(acct),
        requestCategory: "INFORMATION",
        subjectEntityIds: [acct.id],
        scope: upi ? `The bank account, holder and registered mobile linked to ${acct.value}.` : `Statement of account, KYC/account-opening details and registered contact details for ${acct.value}.`,
        periodFrom: null,
        periodTo: null,
        prerequisites: upi ? [{ label: "UPI ID recorded", met: true, basis: acct.value }] : [bankReq],
        expectedClarification: "The holder on record, the credits from the complainant and where the money went next.",
        priority: "HIGH",
        priorityReason: "The first account the money reached: the trail cannot continue without it.",
        ...(upi ? statusFromRequest(infoCover) : gated(bankReq, infoCover)),
        responseId: null,
        supportingSources: srcs,
      });
    }
  }

  // Money lost but not yet traced to any account: start from the complainant's side.
  const lostClaim = (f.claims ?? []).find((c) => c.lossMinor > 0n);
  const victimPaid = f.transactions.some((t) => t.kind === "VICTIM_PAYMENT");
  if (lostClaim && !victimPaid) {
    const own = f.entities.filter((e) => e.kind === "BANK_ACCOUNT" && victimAccounts.has(e.id) && e.attributes.numberNotStated !== true);
    for (const acct of own) {
      const cover = coveringRequest(f, "INFORMATION", acct.id);
      if (cover && (ANSWERED.includes(cover.status) || cover.status === "PARTIAL_RESPONSE")) continue;
      const bankReq = bankPrereq(acct);
      out.push({
        dedupeKey: `DEBITS:${acct.id}`,
        ruleId: "FUNDS_VICTIM_DEBITS",
        kind: "RECOMMENDATION",
        objective: "FINANCIAL",
        title: `Find the accused's accounts: ask ${bankKnown(acct) ? bankOf(acct) : "the complainant's bank"} which accounts got the money from ${acct.label}`,
        question: `To which accounts, with which references, did the ${formatInr(lostClaim.lossMinor)} the complainant lost leave ${acct.label}?`,
        purpose: "Name the accused's accounts that received the money, so they can be frozen and traced. The complainant's account is only where the trail starts.",
        relevance: `The complainant reports a loss of ${formatInr(lostClaim.lossMinor)} from ${acct.label}; none of the accused's receiving accounts is recorded yet.`,
        recipientHint: bankHint(acct),
        requestCategory: "INFORMATION",
        subjectEntityIds: [acct.id],
        scope: `Debit details for ${acct.value}: date, time, amount, UTR/RRN, and the beneficiary account, IFSC and bank of each debit to the fraudsters; and the status of any recall or chargeback.`,
        periodFrom: null,
        periodTo: null,
        prerequisites: [bankReq],
        expectedClarification: "Each debit with its UTR and the receiving account and bank, which become the next freeze requests.",
        priority: "HIGH",
        priorityReason: "Until the receiving accounts are known, nothing can be frozen.",
        ...gated(bankReq, cover),
        responseId: null,
        supportingSources: sourcesFor(f, [{ type: "ENTITY", id: acct.id }]),
      });
    }
    if (!own.length) {
      out.push({
        dedupeKey: `STATEMENT:${lostClaim.victimEntityId}`,
        ruleId: "FUNDS_VICTIM_STATEMENT",
        kind: "MISSING_INFORMATION",
        objective: "FINANCIAL",
        title: "Find the accused's accounts the money went to",
        question: `To which of the accused's accounts did the complainant's ${formatInr(lostClaim.lossMinor)} go?`,
        purpose: "The NCRP trail, or the complainant's statement or payment screenshots, names each receiving account with its UTR; added to the case, each becomes one of the accused's level-1 accounts, to be frozen and traced.",
        relevance: `The complainant reports a loss of ${formatInr(lostClaim.lossMinor)}, but none of the accused's receiving accounts is recorded yet.`,
        recipientHint: "The complainant",
        requestCategory: null,
        subjectEntityIds: [lostClaim.victimEntityId],
        scope: "The NCRP trail export, or the complainant's statement or payment screenshots covering every payment, added with “Add files” on the case card.",
        periodFrom: null,
        periodTo: null,
        prerequisites: [{ label: "The receiving accounts on record", met: false, basis: "Add the NCRP trail, or the complainant's statement or screenshots, with “Add files” on the case card: the accounts the money reached are read in as the accused's." }],
        expectedClarification: "Each payment with its date, amount, UTR and the receiving account and IFSC.",
        priority: "HIGH",
        priorityReason: "Until the receiving accounts are known, nothing can be frozen.",
        status: "OPEN",
        requestId: null,
        responseId: null,
        supportingSources: [],
      });
    }
  }

  // Overdue follow-ups (dates come from routing configuration, not legal deadlines).
  for (const req of f.requests) {
    if (!AWAITING.includes(req.status) || !req.followUpAt || req.followUpAt > f.now) continue;
    const pendingReview = f.responses.some((r) => r.requestId === req.id && (r.reviewStatus === "UNREVIEWED" || r.reviewStatus === "IN_REVIEW"));
    const child = f.requests.some((r) => r.parentRequestId === req.id && !["REJECTED"].includes(r.status));
    if (pendingReview || child) continue;
    out.push({
      dedupeKey: `FOLLOWUP:${req.id}`,
      ruleId: "FOLLOW_UP_DUE",
      kind: "RECOMMENDATION",
      objective: req.category === "PRESERVATION" ? "EVIDENCE" : "FINANCIAL",
      title: `Follow up with ${req.recipientName} on ${req.reference}`,
      question: `${req.recipientName} has not answered ${req.reference} in full. What is outstanding?`,
      purpose: "Obtain the outstanding items without duplicating the original request.",
      relevance: `The follow-up date configured for this route (${formatDateIST(req.followUpAt)}) has passed. Status: ${req.status.replace(/_/g, " ").toLowerCase()}.`,
      recipientHint: req.recipientName,
      requestCategory: req.category === "HOLD" ? "HOLD" : req.category === "PRESERVATION" ? "PRESERVATION" : "INFORMATION",
      subjectEntityIds: req.subjectEntityIds,
      scope: `Reminder referencing ${req.reference}; list the items still pending.`,
      periodFrom: null,
      periodTo: null,
      prerequisites: [{ label: "Original request submitted", met: true, basis: req.reference }],
      expectedClarification: "A substantive reply or a date by which the items will be provided.",
      priority: "NORMAL",
      priorityReason: "Configured follow-up date passed (department setting, not a legal deadline).",
      status: "OPEN",
      requestId: req.id,
      responseId: null,
      supportingSources: [],
    });
  }

  // Phones linked to accounts by a record → subscriber details.
  for (const e of f.entities.filter((x) => x.kind === "PHONE" && !victimAccounts.has(x.id))) {
    // A WhatsApp account on the number: the platform holds its registration and login records (real cases).
    if (!demo && onWhatsApp(e) && /caller|fraudster|accused|suspect|used to contact/i.test(e.caseRole ?? "")) {
      const cover = coveringRequest(f, "INFORMATION", e.id);
      if (!cover || !ANSWERED.includes(cover.status)) {
        out.push({
          dedupeKey: `WHATSAPP:${e.id}`,
          ruleId: "IDENTITY_WHATSAPP",
          kind: "RECOMMENDATION",
          objective: "IDENTITY",
          title: `Ask WhatsApp for the account details of ${e.label}`,
          question: `Who registered the WhatsApp account on ${e.label}, and from where was it used?`,
          purpose: "Identify the person behind the WhatsApp account and preserve its records. A foreign number can only be traced this way.",
          relevance: `Recorded as: ${e.caseRole}.`,
          recipientHint: `WhatsApp: law-enforcement team ${LIST}`,
          requestCategory: "INFORMATION",
          subjectEntityIds: [e.id],
          scope: `Basic subscriber information for the WhatsApp account on ${e.value}: registration details, device, email, IP addresses with timestamps, and preservation of the account's records.`,
          periodFrom: null,
          periodTo: null,
          prerequisites: [{ label: "Number recorded as used on WhatsApp", met: true, basis: `Recorded as: ${e.caseRole}` }],
          expectedClarification: "Registration details and login IP addresses with timestamps, which lead to an internet provider or a phone number.",
          priority: foreignNumber(e.value) ? "HIGH" : "NORMAL",
          priorityReason: foreignNumber(e.value) ? "A foreign number: WhatsApp's records are the only route to whoever used it." : "Corroborates the CDR and CAF from the telecom operator.",
          ...statusFromRequest(cover),
          responseId: null,
          supportingSources: sourcesFor(f, [{ type: "ENTITY", id: e.id }]),
        });
      }
    }
    const links = f.relationships.filter((r) => r.type === "LINKED_IDENTIFIER" && (r.fromEntityId === e.id || r.toEntityId === e.id));
    const linkedToAccount = links.find((r) => {
      const other = entity.get(r.fromEntityId === e.id ? r.toEntityId : r.fromEntityId);
      return !!other && payable.has(other.kind) && !victimAccounts.has(other.id);
    });
    // The complaint itself may name the number the caller used: that goes to UNICROSS for CDR and CAF.
    // UNICROSS gets CDR and CAF from Indian operators only: a number with another country code is not sent there.
    const usedByCaller = !linkedToAccount && !foreignNumber(e.value) && /caller|fraudster|accused|suspect|used to contact/i.test(e.caseRole ?? "");
    if (!linkedToAccount && !usedByCaller) continue;
    const cover = coveringRequest(f, "INFORMATION", e.id);
    if (cover && ANSWERED.includes(cover.status)) continue;
    if (!linkedToAccount) {
      const paid = f.transactions.filter((t) => t.kind === "VICTIM_PAYMENT").map((t) => t.occurredAt.getTime());
      out.push({
        dedupeKey: `SUBSCRIBER:${e.id}`,
        ruleId: "IDENTITY_CALLER_NUMBER",
        kind: "RECOMMENDATION",
        objective: "IDENTITY",
        title: `Request CDR and subscriber details (CAF) for ${e.label}`,
        question: `Who is the subscriber of the number the caller used, and where and with whom was it used during the offence?`,
        purpose: "Identify and locate the person who used the number. Call records and the CAF are leads to corroborate: registration alone does not show who used the number.",
        relevance: `Recorded as: ${e.caseRole}.`,
        recipientHint: "Telecom service provider via the department's UNICROSS / zonal ACP route",
        requestCategory: "INFORMATION",
        subjectEntityIds: [e.id],
        scope: `Call detail records (CDR) for the period of the offence and the Customer Acquisition Form (CAF) for ${e.value}.`,
        // The period the victim's payments span, when recorded; the officer widens it as needed.
        periodFrom: paid.length ? new Date(Math.min(...paid)) : null,
        periodTo: paid.length ? new Date(Math.max(...paid)) : null,
        prerequisites: [{ label: "Number recorded as used by the caller", met: true, basis: `Recorded as: ${e.caseRole}` }],
        expectedClarification: "CDR with cell locations for the period, subscriber name and address, activation date and the documents submitted (CAF).",
        priority: "HIGH",
        priorityReason: "The most direct lead to who used the number and where it was used.",
        ...statusFromRequest(cover),
        responseId: null,
        supportingSources: sourcesFor(f, [{ type: "ENTITY", id: e.id }]),
      });
      continue;
    }
    out.push({
      dedupeKey: `SUBSCRIBER:${e.id}`,
      ruleId: "IDENTITY_SUBSCRIBER",
      kind: "RECOMMENDATION",
      objective: "IDENTITY",
      title: `Request subscriber details for ${e.label}`,
      question: `Who is the registered subscriber of ${e.label}, and do the subscriber details match the account holder on record?`,
      purpose: "Test who controls the account through an independent record. Registration alone does not establish use or control.",
      relevance: linkedToAccount.statement,
      recipientHint: "Telecom service provider via the department's UNICROSS / zonal ACP route",
      requestCategory: "INFORMATION",
      subjectEntityIds: [e.id],
      scope: `Subscriber details and Customer Acquisition Form (CAF) for ${e.value}.`,
      periodFrom: null,
      periodTo: null,
      prerequisites: [{ label: "Number linked to the case by a record", met: true, basis: linkedToAccount.statement }],
      expectedClarification: "Subscriber name and address on record, activation date and documents submitted.",
      priority: "NORMAL",
      priorityReason: "Identity lead from a bank record; not time-critical for fund recovery.",
      ...statusFromRequest(cover),
      responseId: null,
      supportingSources: sourcesFor(f, [{ type: "RELATIONSHIP", id: linkedToAccount.id }]),
    });
  }

  // IP observations missing correlation data.
  for (const loc of f.locations) {
    if (!loc.entityId || !loc.limitations || !/port/i.test(loc.limitations)) continue;
    const ip = entity.get(loc.entityId);
    if (!ip || ip.kind !== "IP_ADDRESS") continue;
    const cover = coveringRequest(f, "INFORMATION", ip.id);
    if (cover && ANSWERED.includes(cover.status)) continue;
    out.push({
      dedupeKey: `IPPORT:${ip.id}`,
      ruleId: "IDENTITY_IP_CORRELATION",
      kind: "RECOMMENDATION",
      objective: "IDENTITY",
      title: `Ask for the source port and exact time of the login from ${ip.label}`,
      question: `Can the login from ${ip.label} be attributed to a subscriber, given that the source port was not provided?`,
      purpose: "Collect the data an internet service provider needs before a subscriber request is meaningful.",
      relevance: `${loc.limitations} Shared public IPv4 addresses often need the source port and an exact timestamp to identify a subscriber.`,
      recipientHint: "The bank that supplied the login record",
      requestCategory: "INFORMATION",
      subjectEntityIds: [ip.id],
      scope: `Source port, timestamp with seconds and time zone for the session from ${ip.value}.`,
      periodFrom: null,
      periodTo: null,
      prerequisites: [{ label: "Login record received", met: true, basis: "Bank login record (see sources)" }],
      expectedClarification: "Source port and precise timestamp, enabling a subscriber request to the internet service provider.",
      priority: "NORMAL",
      priorityReason: "Prerequisite for any internet service provider request.",
      ...statusFromRequest(cover),
      responseId: null,
      supportingSources: sourcesFor(f, [{ type: "LOCATION", id: loc.id }, { type: "ENTITY", id: ip.id }]),
    });
  }

  // Email addresses and online profiles (never the complainant's own): ask the provider who is behind them. A freeze
  // is only ever asked of an account the money reached (above); an email or profile is asked for its details, with
  // the records kept meanwhile. (The demonstration directory's platform portals take a preservation request first,
  // so a demonstration case's profiles keep that step, below.)
  for (const e of f.entities.filter((x) => (x.kind === "EMAIL" || (x.kind === "PLATFORM_PROFILE" && !demo)) && !victimAccounts.has(x.id))) {
    const cover = coveringRequest(f, "INFORMATION", e.id);
    if (cover && ANSWERED.includes(cover.status)) continue;
    // A real case writes to the provider on the nodal officer list, so the provider has to be known first.
    const provider = demo ? null : providerOf(e);
    const known: Prerequisite | null = demo
      ? null
      : provider
        ? { label: e.kind === "EMAIL" ? "Mail provider identified" : "Platform identified", met: true, basis: provider }
        : e.kind === "EMAIL"
          ? { label: "Mail host identified", met: false, basis: `Who runs the mail of ${e.value.split("@")[1] ?? "this domain"} is not known. Find it from the domain's MX record or WHOIS and record it as the identifier's mail provider (People & identifiers).` }
          : { label: "Platform identified", met: false, basis: "Record which platform the account is on (People & identifiers)." };
    const what = e.kind === "EMAIL" ? "email address" : "profile";
    const role = e.caseRole?.trim() ? e.caseRole.trim().replace(/\.$/, "") : null;
    out.push({
      dedupeKey: `DETAILS:${e.id}`,
      ruleId: "IDENTITY_ACCOUNT_DETAILS",
      kind: "RECOMMENDATION",
      objective: "IDENTITY",
      title: `Ask for the account details of ${e.label}`,
      question: `Who registered the ${what} ${e.label}, with which phone numbers and recovery email, and from which IP addresses was it used?`,
      purpose: "Find who created and used the account: the registered phone and recovery email, and the IP addresses of its logins, lead to a person.",
      relevance: `${e.value} ${role ? `is recorded in the case as: ${role.charAt(0).toLowerCase()}${role.slice(1)}` : "is named in the complaint"}.`,
      recipientHint: demo ? "Provider's law-enforcement team (from the routing directory)" : provider ? `${provider}: law-enforcement team ${LIST}` : e.kind === "EMAIL" ? "The domain's mail host, once identified" : "The platform, once identified",
      requestCategory: "INFORMATION",
      subjectEntityIds: [e.id],
      scope: `Registration details, linked phone numbers and recovery email, and login IP addresses of ${e.value}.`,
      periodFrom: null,
      periodTo: null,
      prerequisites: [{ label: "Identifier recorded in the case", met: true, basis: e.caseRole ?? "Recorded identifier" }, ...(known ? [known] : [])],
      expectedClarification: "Name and date of registration, registered phone numbers and recovery email, and IP addresses with times of registration and logins.",
      priority: "NORMAL",
      priorityReason: "The most direct lead to who is behind the account; records may be deleted over time.",
      ...(known ? gated(known, cover) : statusFromRequest(cover)),
      responseId: null,
      supportingSources: sourcesFor(f, [{ type: "ENTITY", id: e.id }]),
    });
  }

  // A demonstration case's profiles: the configured platform portal takes a preservation request first.
  for (const e of f.entities.filter((x) => demo && x.kind === "PLATFORM_PROFILE" && !victimAccounts.has(x.id))) {
    const cover = coveringRequest(f, "PRESERVATION", e.id);
    if (cover && ANSWERED.includes(cover.status)) continue;
    out.push({
      dedupeKey: `PRESERVE:${e.id}`,
      ruleId: "EVIDENCE_PRESERVATION",
      kind: "RECOMMENDATION",
      objective: "EVIDENCE",
      title: `Send a preservation request for ${e.label}`,
      question: `Will the provider retain the records for ${e.label} while the disclosure process is pursued?`,
      purpose: "Prevent loss of account records. Preservation is separate from disclosure and does not by itself provide data.",
      relevance: `${e.label} appears in the complaint. Providers may delete inactive records.`,
      recipientHint: "Provider's law-enforcement portal (from the routing directory)",
      requestCategory: "PRESERVATION",
      subjectEntityIds: [e.id],
      scope: `Preserve available account records for ${e.value}.`,
      periodFrom: null,
      periodTo: null,
      prerequisites: [{ label: "Identifier recorded in the case", met: true, basis: e.caseRole ?? "Recorded identifier" }],
      expectedClarification: "Confirmation that records are preserved and the retention period.",
      priority: "NORMAL",
      priorityReason: "Records may be lost over time; preservation does not depend on recovery progress.",
      ...statusFromRequest(cover),
      responseId: null,
      supportingSources: sourcesFor(f, [{ type: "ENTITY", id: e.id }]),
    });
  }

  // Websites used in the fraud (real cases): one request per site to its registrar, for the registrant and host.
  if (!demo) {
    const sites = new Map<string, FactEntity[]>();
    for (const e of f.entities.filter((x) => x.kind === "WEBSITE" && !victimAccounts.has(x.id))) {
      const host = siteHost(e.value);
      if (!host || PLATFORM_HOSTS.test(host)) continue;
      sites.set(host, [...(sites.get(host) ?? []), e]);
    }
    for (const [host, pages] of sites) {
      const registrar = pages.map(recordedProvider).find((x): x is string => !!x) ?? null;
      const cover = pages.map((p) => coveringRequest(f, "INFORMATION", p.id)).find(Boolean);
      if (cover && ANSWERED.includes(cover.status)) continue;
      const known: Prerequisite = registrar
        ? { label: "Registrar identified", met: true, basis: registrar }
        : { label: "Registrar identified", met: false, basis: `Look up ${host} on a WHOIS service and record its registrar on the identifier (People & identifiers).` };
      out.push({
        dedupeKey: `SITE:${host}`,
        ruleId: "EVIDENCE_WEBSITE",
        kind: "RECOMMENDATION",
        objective: "IDENTITY",
        title: `Ask the registrar of ${host} who registered it and where it is hosted`,
        question: `Who registered ${host}, how did they pay, and which company hosts it?`,
        purpose: "Identify who runs the site and preserve its records before it disappears.",
        relevance: `${pages.length === 1 ? pages[0]!.label : `${pages.length} addresses on ${host}`} recorded as: ${pages[0]!.caseRole ?? "a website in the case"}.`,
        recipientHint: registrar ? `${providerByName(registrar).name}: law-enforcement team ${LIST}` : "The domain registrar, once identified from WHOIS",
        requestCategory: "INFORMATION",
        subjectEntityIds: pages.map((p) => p.id),
        scope: `Registrant details, payment details, registration and login IP addresses, the hosting provider and name servers for ${host}, and preservation of its records.`,
        periodFrom: null,
        periodTo: null,
        prerequisites: [known],
        expectedClarification: "The registrant's details, payment trail and IP logs, and the hosting provider to write to next.",
        priority: "NORMAL",
        priorityReason: "Fraud sites are taken down or moved quickly; their records may be lost.",
        ...gated(known, cover),
        responseId: null,
        supportingSources: sourcesFor(f, pages.map((p) => ({ type: "ENTITY", id: p.id }))),
      });
    }
  }

  // Responses to review and messages to match.
  for (const r of f.responses) {
    if (r.matchStatus === "MATCHED" && (r.reviewStatus === "UNREVIEWED" || r.reviewStatus === "IN_REVIEW")) {
      out.push({
        dedupeKey: `REVIEW:${r.id}`,
        ruleId: "REVIEW_RESPONSE",
        kind: "REVIEW",
        objective: "FINANCIAL",
        title: `Review the response from ${r.recipientName}${r.requestReference ? ` to ${r.requestReference}` : ""}`,
        question: "What does this response establish, and what is still missing?",
        purpose: "Turn the response into reviewed case facts. Nothing is applied until you accept it.",
        relevance: "A response has been received and matched to a request but not yet reviewed.",
        recipientHint: null,
        requestCategory: null,
        subjectEntityIds: [],
        scope: null,
        periodFrom: null,
        periodTo: null,
        prerequisites: [],
        expectedClarification: "Accepted facts update the ledger, graph and tasks; missing items stay open.",
        priority: "HIGH",
        priorityReason: "New information may change what can still be secured.",
        status: "OPEN",
        requestId: r.requestId,
        responseId: r.id,
        supportingSources: [],
      });
    } else if (r.matchStatus === "NEEDS_MATCH_REVIEW") {
      out.push({
        dedupeKey: `MATCH:${r.id}`,
        ruleId: "MATCH_RESPONSE",
        kind: "REVIEW",
        objective: "FINANCIAL",
        title: `Confirm which request the message from ${r.recipientName} answers`,
        question: "Which request does this incoming message relate to?",
        purpose: "Uncertain matches are never applied automatically.",
        relevance: "The message could not be matched to a request with certainty.",
        recipientHint: null,
        requestCategory: null,
        subjectEntityIds: [],
        scope: null,
        periodFrom: null,
        periodTo: null,
        prerequisites: [],
        expectedClarification: "Once matched, the message can be reviewed like any other response.",
        priority: "NORMAL",
        priorityReason: "Unmatched correspondence may contain outstanding items.",
        status: "OPEN",
        requestId: null,
        responseId: r.id,
        supportingSources: [],
      });
    }
  }

  // Restoration for held, allocated funds.
  for (const h of f.holds.filter((x) => x.status === "CONFIRMED_HELD")) {
    const allocated = f.allocations.filter((a) => a.holdId === h.id && a.status === "CONFIRMED").reduce((s, a) => s + a.amountMinor, 0n);
    if (allocated === 0n) continue;
    if (f.refunds.some((r) => r.holdId === h.id && r.status !== "CANCELLED" && r.status !== "FAILED")) continue;
    const acct = entity.get(h.accountEntityId);
    const cover = coveringRequest(f, "RESTORATION", h.accountEntityId);
    if (cover && ANSWERED.includes(cover.status)) continue;
    out.push({
      dedupeKey: `RESTORE:${h.id}`,
      ruleId: "FUNDS_RESTORATION",
      kind: "RECOMMENDATION",
      objective: "FINANCIAL",
      title: `Prepare restoration of ${formatInr(allocated)} held in ${acct?.label ?? "the account"}`,
      question: `What is still required before the ${formatInr(allocated)} allocated to the victim can be returned?`,
      purpose: "Move secured funds back to the victim through the applicable approved procedure.",
      relevance: `The bank has confirmed ${formatInr(h.confirmedMinor ?? 0n)} held, and ${formatInr(allocated)} is allocated to a victim claim.`,
      recipientHint: acct ? `${bankOf(acct)}: nodal officer` : null,
      requestCategory: "RESTORATION",
      subjectEntityIds: [h.accountEntityId],
      scope: "Restoration of allocated held funds to the victim's account, per the applicable departmental procedure.",
      periodFrom: null,
      periodTo: null,
      prerequisites: [
        { label: "Allocation to a victim claim confirmed", met: true, basis: `${formatInr(allocated)} confirmed` },
        { label: "Restoration order or approval reference recorded", met: false, basis: "Record the order or approval reference before submitting." },
      ],
      expectedClarification: "Confirmation of credit to the victim's account. Only a confirmed credit counts as money returned.",
      priority: "NORMAL",
      priorityReason: "Funds are secured. The remaining steps depend on the approval being obtained.",
      ...statusFromRequest(cover),
      responseId: null,
      supportingSources: sourcesFor(f, [{ type: "HOLD", id: h.id }]),
    });
  }

  // Held money that more than one victim's payments passed through: the officer records the basis for the split.
  const claims = f.claims ?? [];
  const heldConfirmed = f.holds.filter((h) => h.status === "CONFIRMED_HELD" && (h.confirmedMinor ?? 0n) > 0n);
  const heldTotal = heldConfirmed.reduce((s, h) => s + (h.confirmedMinor ?? 0n), 0n);
  if (claims.length >= 2 && heldTotal > 0n && (f.allocationDecisions ?? []).length === 0) {
    const payments = f.transactions.filter((t) => t.kind === "VICTIM_PAYMENT");
    const intoBoth = [...new Set(payments.map((t) => t.toEntityId))].find((id) => new Set(payments.filter((t) => t.toEntityId === id).map((t) => t.fromEntityId)).size >= 2);
    const mixedIn = intoBoth ? entity.get(intoBoth) : undefined;
    const heldIn = heldConfirmed.map((h) => entity.get(h.accountEntityId)?.label).filter(Boolean);
    const count = claims.length === 2 ? "the two victims" : `the ${claims.length} victims`;
    out.push({
      dedupeKey: "ALLOC:basis",
      ruleId: "FUNDS_ALLOCATION_BASIS",
      kind: "DECISION",
      objective: "FINANCIAL",
      title: `Decide how the ${formatInr(heldTotal)} is split between ${count}`,
      question: `Whose money is the ${formatInr(heldTotal)} held in ${heldIn.join(" and ") || "the held accounts"}?`,
      purpose: "The ledger needs a recorded basis before anything can be returned.",
      relevance: mixedIn
        ? `Both victims paid into ${mixedIn.label} before the money moved on, so the records cannot say whose money is held.`
        : "More than one victim claims money in the held accounts.",
      recipientHint: "Your decision",
      requestCategory: null,
      subjectEntityIds: heldConfirmed.map((h) => h.accountEntityId),
      scope: "Split in proportion to what each victim paid, first in first out, or leave it to the court under the multiple-victim route.",
      periodFrom: null,
      periodTo: null,
      prerequisites: [
        { label: "Holds confirmed by the banks", met: true, basis: `${formatInr(heldTotal)} confirmed held` },
        { label: "Every victim's claim recorded", met: true, basis: `${claims.length} claims recorded` },
      ],
      expectedClarification: "A recorded basis lets the restoration filing be drafted. The assistant never chooses one.",
      priority: "HIGH",
      priorityReason: "Nothing can be returned to the victims until a basis is recorded.",
      status: "OPEN",
      requestId: null,
      responseId: null,
      supportingSources: [],
    });
  }

  // CCTV footage of a cash withdrawal: needs the ATM ID, which the bank's statement or ATM details will give.
  for (const loc of f.locations.filter((l) => l.observationType === "ATM_WITHDRAWAL")) {
    const atmKnown = !!loc.atmId;
    const place = loc.locationText?.replace(/^ATM,\s*/, "") ?? "the ATM";
    const infoKey = loc.entityId ? `INFO:${loc.entityId}` : undefined;
    const info = loc.entityId ? coveringRequest(f, "INFORMATION", loc.entityId) : undefined;
    out.push({
      dedupeKey: `CCTV:${loc.id}`,
      ruleId: "EVIDENCE_ATM_CCTV",
      kind: "RECOMMENDATION",
      objective: "IDENTITY",
      title: `Get the ATM CCTV footage from ${loc.eventAt ? `${formatDayMonthIST(loc.eventAt)}, ` : ""}${place}`,
      question: "Who withdrew the cash?",
      purpose: "Footage of the withdrawal can show who used the card.",
      relevance: `Cash was withdrawn at ${loc.locationText ?? "an ATM"}${loc.eventAt ? ` on ${formatDateIST(loc.eventAt)}` : ""}. Footage is usually kept 30 to 90 days.`,
      recipientHint: atmKnown ? "ATM operator" : "ATM operator, not yet known",
      requestCategory: null,
      subjectEntityIds: loc.entityId ? [loc.entityId] : [],
      scope: "CCTV footage at the ATM for the time of the withdrawal, with the camera's own clock offset.",
      periodFrom: loc.eventAt ?? null,
      periodTo: loc.eventAt ?? null,
      prerequisites: [
        {
          label: "Cash withdrawal recorded",
          met: true,
          basis: [loc.eventAt ? `${formatDayMonthIST(loc.eventAt)}, ${formatTimeIST(loc.eventAt).replace(" IST", "")}` : null, loc.description].filter(Boolean).join(" · ") || "From the bank's records",
        },
        {
          label: "ATM ID known",
          met: atmKnown,
          basis: atmKnown ? `ATM ID ${loc.atmId}` : `The bank's statement or ATM details will give it${info ? ` (${info.reference})` : ""}.`,
          ...(atmKnown || !infoKey ? {} : { dependsOn: infoKey }),
        },
      ],
      expectedClarification: "Footage of the person at the ATM at the time of the withdrawal.",
      priority: "HIGH",
      priorityReason: "Footage is overwritten after the operator's retention period.",
      status: atmKnown ? "OPEN" : "BLOCKED",
      requestId: null,
      responseId: null,
      supportingSources: sourcesFor(f, [{ type: "LOCATION", id: loc.id }]),
    });
  }

  return out;
}

export interface Resolution {
  outcome: "COMPLETED" | "SUPERSEDED";
  reason: string;
  requestId?: string;
}

/** Explains why a previously recommended action is no longer needed. */
export function explainResolution(dedupeKey: string, f: RecoFacts): Resolution {
  const [type, id = ""] = dedupeKey.split(":");
  const req = (rid: string | null) => f.requests.find((r) => r.id === rid);
  switch (type) {
    case "REVIEW":
    case "MATCH": {
      const resp = f.responses.find((r) => r.id === id);
      if (resp?.reviewStatus === "APPLIED") return { outcome: "COMPLETED", reason: "The response was reviewed and the accepted results applied." };
      if (resp && type === "MATCH" && resp.matchStatus === "MATCHED") return { outcome: "COMPLETED", reason: "The message was matched to a request." };
      return { outcome: "SUPERSEDED", reason: "The response is no longer pending review." };
    }
    case "FOLLOWUP": {
      const child = f.requests.find((r) => r.parentRequestId === id);
      if (child) return { outcome: "SUPERSEDED", reason: `Replaced by the more specific follow-up request ${child.reference}.`, requestId: child.id };
      const original = req(id);
      if (original && !AWAITING.includes(original.status)) return { outcome: "COMPLETED", reason: `${original.reference} is now ${original.status.replace(/_/g, " ").toLowerCase()}.` };
      return { outcome: "SUPERSEDED", reason: "A response is waiting for review, so a reminder is not needed now." };
    }
    case "HOLD":
    case "BALANCE": {
      const hold = f.holds.find((h) => h.accountEntityId === id && isConfirmedHold(h.status));
      if (hold) {
        return {
          outcome: "COMPLETED",
          reason: hold.confirmedMinor !== null ? `The bank confirmed ${formatInr(hold.confirmedMinor)} held.` : "The bank confirmed the hold.",
        };
      }
      const cover = coveringRequest(f, "HOLD", id);
      if (cover && ANSWERED.includes(cover.status)) return { outcome: "COMPLETED", reason: `${cover.reference} was answered.`, requestId: cover.id };
      return { outcome: "SUPERSEDED", reason: "No longer supported by the current case facts." };
    }
    case "INFO": {
      const cover = coveringRequest(f, "INFORMATION", id);
      if (cover && (ANSWERED.includes(cover.status) || cover.status === "PARTIAL_RESPONSE")) {
        return { outcome: "COMPLETED", reason: `A statement was received in response to ${cover.reference}.`, requestId: cover.id };
      }
      return { outcome: "SUPERSEDED", reason: "No longer supported by the current case facts." };
    }
    case "ALLOC":
      return (f.allocationDecisions ?? []).length > 0
        ? { outcome: "COMPLETED", reason: "A basis for splitting the held money was recorded." }
        : { outcome: "SUPERSEDED", reason: "No held money is shared between victims any more." };
    case "CCTV":
      return { outcome: "SUPERSEDED", reason: "The withdrawal is no longer recorded in the case." };
    case "PRESERVE": {
      const cover = coveringRequest(f, "PRESERVATION", id);
      if (cover && ANSWERED.includes(cover.status)) return { outcome: "COMPLETED", reason: `${cover.reference} was answered.`, requestId: cover.id };
      return { outcome: "SUPERSEDED", reason: "Replaced by asking the provider for the account's details (who registered it, its phone numbers and login IPs), which also asks it to keep the records." };
    }
    case "DETAILS": {
      const cover = coveringRequest(f, "INFORMATION", id);
      if (cover && ANSWERED.includes(cover.status)) return { outcome: "COMPLETED", reason: `${cover.reference} was answered.`, requestId: cover.id };
      return { outcome: "SUPERSEDED", reason: "No longer supported by the current case facts." };
    }
    case "RESTORE":
      return f.refunds.some((r) => r.holdId === id)
        ? { outcome: "COMPLETED", reason: "A restoration has been recorded for these funds." }
        : { outcome: "SUPERSEDED", reason: "The held funds are no longer allocated or held." };
    default:
      return { outcome: "SUPERSEDED", reason: "No longer supported by the current case facts." };
  }
}
