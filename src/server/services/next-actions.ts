import { draftGap } from "./drafting";
import { gmailDraftView, type GmailDraftView } from "../gmail/view";
import { plainLine } from "@/domain/plain-line";
import { deliverySettings, getAppConfig } from "../config";
import type { DraftGap } from "./draft-gaps";
import { formatDateIST, formatDayMonthIST } from "@/domain/time";
import { canWriteCase } from "@/domain/permissions";
import { shortRank } from "@/lib/cn";
import { now } from "../clock";
import type { Tone } from "@/domain/standing";
import type { Db } from "../db";
import type { SessionUser } from "../auth/session";
import { loadCaseForUser } from "../auth/access";
import { assistantAuthorId } from "../assistant-identity";
import { calendarDays, shortOrg } from "./dashboard";
import { nodalFor, type NodalRow } from "./nodal";
import { addressProblem, splitAddresses } from "@/domain/mail-check";
import { gmailSettings } from "../gmail/oauth";
import { approvalRoleOf } from "./requests";
import { shownId } from "@/domain/identifiers";

/**
 * A case's next actions, ranked by what unblocks the most: drafts that other actions wait on, the other drafts,
 * then what is blocked (just after what it waits on), decisions, requests not yet drafted, and leads that need
 * evidence. Each carries its draft request when there is one, so it can be approved and sent from the list.
 */

export type ActionKind = "DRAFT" | "REMINDER" | "BLOCKED" | "DECISION" | "REQUEST" | "LEAD" | "SENT" | "DECIDED";

/** What the officer looking at a draft can do with it. */
export type SendMode = "APPROVE_AND_SEND" | "SEND" | "ASK_APPROVAL" | "WAITING_APPROVAL" | "VIEW" | "DONE";

export interface NextAction {
  taskId: string;
  taskVersion: number;
  rank: number;
  kind: ActionKind;
  title: string;
  why: string;
  route: string;
  objective: "Recovery" | "Identity" | "Evidence";
  status: { text: string; tone: Tone };
  deferred: boolean;
  deferredNote: string | null;
  prerequisites: { label: string; met: boolean; basis: string; dependsOnRank: number | null }[];
  blockedBy: { rank: number; title: string } | null;
  ruleId: string | null;
  /** For an action that is not ready: what has to happen first, in order. */
  chain: { text: string; sub: string; state: "done" | "now" | "todo" }[];
  /** A plain note on timing or risk, from the records (e.g. how long CCTV is kept). */
  note: string | null;
  /** The action in one or two plain sentences: what to do, about which identifier, and why. */
  line: string;
  /** A proposed request whose addressee cannot be found yet: what is missing and how to find it. */
  gap: DraftGap | null;
  question: string;
  request: null | {
    id: string;
    reference: string;
    status: string;
    version: number;
    recipient: { id: string; canVerify: boolean; org: string; name: string; type: string; address: string; channel: string; verified: boolean; verifiedOn: string | null; nodal: { officer: string | null; emails: string[] }[] };
    /** The mailbox it is sent from, and whether that is the station mailbox. */
    from: { address: string; station: boolean };
    subject: string;
    body: string;
    items: { id: string; label: string; itemType: string }[];
    attachments: { id: string; title: string; fileName: string }[];
    authoredByAssistant: boolean;
    author: string;
    mode: SendMode;
    /** Kept for callers that only need a yes/no. */
    canApproveAndSend: boolean;
    /** A real case's draft still addressed to the demonstration directory. */
    demoAddress: boolean;
    /** A draft written before its addressee was known: whom it is for, and what is still missing (null once recorded). */
    unaddressed: { addressee: string; gap: DraftGap | null } | null;
    approvalNote: string;
    needsReview: string | null;
    sent: null | { at: string; receipt: string | null; followUpAt: string | null; channel: string; how: string | null };
    /** v1 delivery: approved requests go to the PS IO's mailbox and the IO forwards them. */
    delivery: { viaIo: boolean; ioMailbox: string; handedOverAt: string | null; handedOverTo: string | null };
    /** Gmail link (prototype): the draft's copy in the linked Gmail account and the To address to offer. */
    gmail: GmailDraftView;
  };
}

export interface SetAside {
  id: string | null;
  title: string;
  reason: string;
  label: "Closed" | "Duplicate" | "Unsupported" | "Reopened";
  /** For a reopened lead, its place in the ranked list. */
  rankNow?: number | null;
  canReopen: boolean;
  taskVersion: number | null;
}

const ACTIVE = ["OPEN", "DRAFT_PREPARED", "BLOCKED", "DEFERRED"];
const OBJ: Record<string, NextAction["objective"]> = { FINANCIAL: "Recovery", IDENTITY: "Identity", EVIDENCE: "Evidence" };
const WHAT: Record<string, string> = { STATEMENT: "statement", KYC: "KYC", ATM_DETAILS: "ATM details", CDR: "CDR", SUBSCRIBER_DETAILS: "CAF", ACCOUNT_DETAILS: "account details", BENEFICIARY_DETAILS: "beneficiary details", IMEI: "IMEI", HOLD_CONFIRMATION: "hold", PRESERVATION_CONFIRMATION: "preservation", BALANCE_CONFIRMATION: "balance", IP_LOGS: "session details", OTHER: "records", RESTORATION_CONFIRMATION: "restoration" };
/** Joins two sentences, adding the full stop the first one may lack. */
const join = (a: string, b: string) => [a.trim(), b.trim()].filter(Boolean).map((x) => (/[.!?”]$/.test(x) ? x : `${x}.`)).join(" ");
const list = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

function askTitle(org: string, entity: { kind: string; label: string; value: string } | null, items: { itemType: string }[]) {
  const types = new Set(items.map((i) => i.itemType));
  if (types.has("CDR")) types.delete("IMEI");
  const what = list([...new Set([...types].map((t) => WHAT[t]).filter((x): x is string => !!x))]);
  if (!entity) return `Ask ${org} for the ${what}`;
  if (entity.kind === "PHONE") return `Ask ${org} for the ${what} of mobile ${shownId(entity.value)}`;
  if (entity.kind === "BANK_ACCOUNT") return `Ask ${org} for ${entity.label}’s ${what}`;
  if (entity.kind === "PLATFORM_PROFILE") return `Ask ${org} for the ${what} of ${entity.label}`;
  return `Ask ${org} for the ${what} of ${entity.label}`;
}

export async function getNextActions(db: Db, user: SessionUser, caseId: string, at = now()) {
  const kase = await loadCaseForUser(db, user, caseId, "read");
  const writer = canWriteCase(user, { stationId: kase.stationId, assignedUserIds: kase.assignments.map((a) => a.userId) });
  const assistantId = await assistantAuthorId(db, kase.stationId);
  const [tasks, requests, entities, taskAudits, locations, users] = await Promise.all([
    db.task.findMany({ where: { caseId }, orderBy: { createdAt: "asc" } }),
    db.request.findMany({
      where: { caseId },
      include: { recipient: true, items: { orderBy: { sortOrder: "asc" } }, subjects: { include: { entity: true } }, versions: { orderBy: { versionNo: "desc" }, take: 1 }, submissions: { where: { outcome: "SUCCEEDED" }, orderBy: { attemptedAt: "desc" }, take: 1, select: { adapter: true } } },
    }),
    db.entity.findMany({ where: { caseId } }),
    db.auditEvent.findMany({ where: { caseId, objectType: "Task", action: { in: ["task.dismissed", "task.reopened", "task.completed_by_facts", "task.completed"] } }, orderBy: { at: "asc" }, select: { objectId: true, action: true, detailJson: true, at: true } }),
    db.locationObservation.findMany({ where: { caseId }, select: { id: true, eventAt: true, description: true, locationText: true } }),
    db.user.findMany({ where: { stationId: kase.stationId }, select: { id: true, displayName: true, rank: true } }),
  ]);
  // Who approves each request (see approvalRoleOf): its route's role, or for one without a route yet, its kind's.
  const roleOf = new Map<string, string>();
  for (const r of requests) roleOf.set(r.id, await approvalRoleOf(db, r));
  const today = formatDateIST(at);
  const userName = (id: string) => {
    const u = users.find((x) => x.id === id);
    return u ? `${shortRank(u.rank)} ${u.displayName}` : "another officer";
  };
  // Reopening clears a task's reason, so the audit trail is what says a lead was set aside and reopened.
  const reopened = new Map<string, string>();
  const lastDismissal = new Map<string, string>();
  const completedAt = new Map<string, Date>();
  for (const e of taskAudits) {
    if (!e.objectId) continue;
    if (e.action === "task.completed_by_facts" || e.action === "task.completed") completedAt.set(e.objectId, e.at);
    else if (e.action === "task.dismissed") lastDismissal.set(e.objectId, (JSON.parse(e.detailJson || "{}") as { reason?: string }).reason ?? "Set aside");
    else reopened.set(e.objectId, lastDismissal.get(e.objectId) ?? "Set aside");
  }
  const attachments = new Map((await db.evidenceItem.findMany({ where: { caseId }, select: { id: true, title: true, fileName: true } })).map((e) => [e.id, e]));
  // The nodal officers on the CrimeOS list for each recipient organisation, so the To address can be checked.
  const nodal = new Map<string, NodalRow[]>();
  for (const org of new Set(requests.filter((r) => r.recipient.organisationType !== "UNADDRESSED").map((r) => r.recipient.organisation))) nodal.set(org, await nodalFor(db, org.replace(/\s*\(synthetic\)$/i, ""), 4));
  const entity = new Map(entities.map((e) => [e.id, e]));
  const requestById = new Map(requests.map((r) => [r.id, r]));
  const active = tasks.filter((t) => ACTIVE.includes(t.status) && !t.dedupeKey.startsWith("REVIEW:") && !t.dedupeKey.startsWith("MATCH:"));

  type Draft = (typeof requests)[number];
  const drafted = (t: (typeof tasks)[number]): Draft | null => {
    const r = t.requestId ? requestById.get(t.requestId) : undefined;
    return r && ["DRAFT", "AWAITING_APPROVAL", "APPROVED", "SUBMISSION_FAILED"].includes(r.status) ? r : null;
  };
  // Follow-ups that are already drafted as reminders appear as their own actions.
  const reminders = requests.filter((r) => r.parentRequestId && ["DRAFT", "AWAITING_APPROVAL", "APPROVED", "SUBMISSION_FAILED"].includes(r.status));

  const raw: { a: Omit<NextAction, "rank" | "blockedBy" | "prerequisites">; prereqs: { label: string; met: boolean; basis: string; dependsOn?: string }[]; order: number; dedupeKey: string }[] = [];

  // Drafts written before their addressee was known: what is still missing (null once it has been recorded).
  const unaddressedGap = new Map<string, DraftGap | null>();
  for (const r of requests.filter((x) => x.recipient.organisationType === "UNADDRESSED" && ["DRAFT", "AWAITING_APPROVAL", "APPROVED", "SUBMISSION_FAILED"].includes(x.status))) {
    const t = tasks.find((x) => x.id === r.taskId);
    unaddressedGap.set(r.id, t && writer ? await draftGap(db, kase, t) : null);
  }

  const delivery = deliverySettings();
  const requestView = (r: Draft): NextAction["request"] => {
    const v = r.versions[0]!;
    const un = unaddressedGap.has(r.id) ? { addressee: /\[([^\]]+): to be filled in\]/.exec(v.body)?.[1] ?? "the recipient", gap: unaddressedGap.get(r.id) ?? null } : null;
    const byAssistant = !!assistantId && v.createdById === assistantId;
    const verified = r.recipient.verificationStatus === "VERIFIED";
    const needsSupervisor = roleOf.get(r.id) !== "INVESTIGATING_OFFICER";
    // With Gmail and gmail.senderApproves, the officer who sends a version they wrote approves it by sending it.
    const senderMay = delivery.mode === "gmail" && gmailSettings().senderApproves && writer && v.createdById === user.id && (!needsSupervisor || user.role === "SUPERVISOR");
    const canApprove = (writer && v.createdById !== user.id && (!needsSupervisor || user.role === "SUPERVISOR")) || senderMay;
    const unsent = ["DRAFT", "AWAITING_APPROVAL"].includes(r.status);
    const mode: SendMode = !["DRAFT", "AWAITING_APPROVAL", "APPROVED", "SUBMISSION_FAILED"].includes(r.status)
      ? "DONE"
      : !writer
        ? "VIEW"
        : !unsent
          ? "SEND"
          : canApprove
            ? "APPROVE_AND_SEND"
            : r.status === "DRAFT"
              ? "ASK_APPROVAL"
              : "WAITING_APPROVAL";
    const author = byAssistant ? "the assistant" : v.createdById === user.id ? "you" : userName(v.createdById);
    const viaIo = delivery.mode === "via-io" && r.channel !== "PORTAL";
    const gmail = gmailDraftView(r, kase.isDemo);
    const approvalNote = {
      APPROVE_AND_SEND: gmail.on
        ? `${byAssistant ? "Prepared by the assistant from the case record" : `Written by ${author}`}. Approve the wording, type the address, and it is sent from Gmail (${gmail.account ?? "the linked account"}); all of it is logged.`
        : viaIo
        ? `${byAssistant ? "Prepared by the assistant from the case record" : `Written by ${author}`}. You approve the wording and it is mailed to the IO (${delivery.ioMailbox}) to forward; both are logged.`
        : byAssistant ? "Prepared by the assistant from the case record. You approve the wording and send it; both are logged." : `Written by ${author}. You approve it and send it; both are logged.`,
      SEND: gmail.on
        ? r.status === "SUBMISSION_FAILED" ? "The last send from Gmail failed; nothing was sent. Check the address and send it again." : "Approved. Type the address and send it from Gmail."
        : viaIo
        ? r.status === "SUBMISSION_FAILED" ? "The last mail to the IO failed; nothing was sent. Mail it again." : r.handedOverAt ? "Approved and mailed to the IO. Forward it from your mailbox, then mark it as forwarded." : "Approved. Mail it to the IO to forward, or send it from your mail program; then mark it as forwarded."
        : r.status === "SUBMISSION_FAILED" ? "The last simulated send failed and nothing left the station. Send it again." : "Approved. Send it when ready.",
      ASK_APPROVAL: v.createdById === user.id ? "You wrote this version, so another officer or the supervisor approves it." : "This route needs the supervisor’s approval.",
      WAITING_APPROVAL: needsSupervisor ? "Waiting for the supervisor’s approval." : "Waiting for another officer’s approval.",
      VIEW: "You can read this case but not act on its requests.",
      DONE: "Sent.",
    }[mode];
    // Nothing goes to an address a supervisor has not verified: the officer sees why, the supervisor can verify it here.
    // A real case's draft still addressed to the demonstration directory is re-addressed, never verified or sent.
    const demoAddress = !kase.isDemo && r.recipient.isSynthetic && !["POLICE_UNIT", "NPCI"].includes(r.recipient.organisationType) && ["DRAFT", "AWAITING_APPROVAL", "APPROVED", "SUBMISSION_FAILED"].includes(r.status);
    const canVerify = !verified && !demoAddress && !un && user.role === "SUPERVISOR" && writer && r.recipient.active;
    const unverifiedNote = !gmail.on && !verified && !un && ["APPROVE_AND_SEND", "SEND", "ASK_APPROVAL", "WAITING_APPROVAL"].includes(mode)
      ? canVerify
        ? `${r.recipient.address} is not verified yet${r.recipient.isSynthetic ? "" : " (it comes from the nodal officer list)"}. Check it, verify it, then approve and send.`
        : `${r.recipient.address} is not verified yet${r.recipient.isSynthetic ? "" : " (it comes from the nodal officer list)"}, so it cannot be sent. A supervisor verifies it, from this draft or Settings → Recipients.`
      : null;
    // With Gmail the officer types the address, so the directory entry need not be verified, and a draft whose
    // addressee was not known (or that names a demonstration entry) is sent to the address typed.
    const typedOk = gmail.on && splitAddresses(gmail.to).length > 0 && splitAddresses(gmail.to).every((x) => !addressProblem(x));
    const canApproveAndSend = gmail.on ? (mode === "APPROVE_AND_SEND" || mode === "SEND") && typedOk : (mode === "APPROVE_AND_SEND" || mode === "SEND") && verified && !demoAddress && !un && !r.needsReview;
    return {
      id: r.id,
      reference: r.reference,
      status: r.status,
      version: r.version,
      recipient: { id: r.recipient.id, canVerify, org: r.recipient.organisation, name: r.recipient.name, type: r.recipient.organisationType, address: r.recipient.address, channel: r.recipient.channel, verified, verifiedOn: r.recipient.verifiedAt ? formatDayMonthIST(r.recipient.verifiedAt) : null, nodal: (nodal.get(r.recipient.organisation) ?? []).map((n) => ({ officer: n.officerName, emails: n.emails })) },
      from: { address: v.fromAddress ?? getAppConfig().mailbox.fromAddress, station: !v.fromAddress },
      subject: v.subject,
      body: v.body,
      items: r.items.map((i) => ({ id: i.id, label: i.label, itemType: i.itemType })),
      attachments: (JSON.parse(v.attachmentIdsJson) as string[]).map((id) => attachments.get(id)).filter((x): x is { id: string; title: string; fileName: string } => !!x),
      authoredByAssistant: byAssistant,
      author,
      mode,
      canApproveAndSend,
      approvalNote: un
        ? un.gap
          ? `No addressee yet: ${un.gap.missing} The draft can be edited and printed now; it is approved and sent once it is addressed.`
          : "The missing detail is recorded now. Address the draft; it can then be approved and sent."
        : demoAddress && !gmail.on
        ? `${r.recipient.organisation} is a demonstration directory entry, and a real case's request is never sent to it. Re-address it: it goes to the provider on the nodal officer list, or says what has to be recorded first.`
        : unverifiedNote
          ? `${unverifiedNote} ${approvalNote}`
          : approvalNote,
      demoAddress,
      unaddressed: un,
      needsReview: r.needsReview ? (r.needsReviewReason ?? "Its sources changed after it was written.") : null,
      sent: r.submittedAt ? { at: r.submittedAt.toISOString(), receipt: r.externalReference, followUpAt: r.followUpAt?.toISOString() ?? null, channel: r.channel, how: r.submissions[0]?.adapter ?? null } : null,
      delivery: { viaIo, ioMailbox: delivery.ioMailbox, handedOverAt: r.handedOverAt?.toISOString() ?? null, handedOverTo: r.handedOverTo },
      gmail,
    };
  };

  // Requests sent today, or that another action waits on, stay in the list as "sent" so ranks stay put; a
  // decision recorded today stays as "decided".
  const dependedOn = new Set(active.flatMap((t) => (JSON.parse(t.prerequisitesJson) as { met: boolean; dependsOn?: string }[]).filter((p) => !p.met && p.dependsOn).map((p) => p.dependsOn!)));
  const sentToday = (r: Draft | undefined) => !!r?.submittedAt && formatDateIST(r.submittedAt) === today;
  const shown = [
    ...active,
    ...tasks.filter((t) => t.status === "WAITING" && t.requestId && (dependedOn.has(t.dedupeKey) || sentToday(requestById.get(t.requestId)))),
    ...tasks.filter((t) => t.status === "COMPLETED" && t.kind === "DECISION" && completedAt.has(t.id) && formatDateIST(completedAt.get(t.id)!) === today),
  ];
  const base = (t: (typeof tasks)[number]) => ({ taskId: t.id, taskVersion: t.version, question: t.question, chain: [] as NextAction["chain"], note: null as string | null, gap: null as DraftGap | null, line: "" });

  for (const t of shown) {
    const d = drafted(t);
    // A follow-up whose reminder is drafted is listed once, as that reminder (below), not also as a draft.
    if (t.dedupeKey.startsWith("FOLLOWUP:") && d?.parentRequestId) continue;
    const subjectIds = JSON.parse(t.subjectEntityIdsJson) as string[];
    const subject = subjectIds[0] ? (entity.get(subjectIds[0]) ?? null) : null;
    const prereqs = JSON.parse(t.prerequisitesJson) as { label: string; met: boolean; basis: string; dependsOn?: string }[];
    const objective = OBJ[t.objective] ?? "Evidence";
    const deferred = t.status === "DEFERRED";
    const why = join(t.relevance, t.purpose);
    const neutral = (text: string) => (deferred ? { text: "Deferred", tone: "neutral" as Tone } : { text, tone: "neutral" as Tone });
    let a: Omit<NextAction, "rank" | "blockedBy" | "prerequisites">;
    let order: number;
    const sentReq = t.status === "WAITING" && t.requestId ? requestById.get(t.requestId) : undefined;
    if (sentReq) {
      a = { ...base(t), kind: "SENT", title: askTitle(shortOrg(sentReq.recipient.organisation), subject, sentReq.items), why, route: `${objective} · ${sentReq.recipient.organisation}`, objective, status: { text: "Sent · awaiting reply", tone: "wait" }, deferred: false, deferredNote: null, ruleId: t.ruleId, request: requestView(sentReq) };
      order = 10;
    } else if (t.status === "COMPLETED") {
      a = { ...base(t), kind: "DECIDED", title: t.title, why, route: `${objective} · your decision`, objective, status: { text: "Decided", tone: "ok" }, deferred: false, deferredNote: null, ruleId: t.ruleId, request: null };
      order = 40;
    } else if (d) {
      const view = requestView(d)!;
      const org = view.unaddressed ? view.unaddressed.addressee : shortOrg(d.recipient.organisation);
      a = {
        ...base(t),
        kind: "DRAFT",
        title: askTitle(org, subject, d.items),
        why,
        route: view.unaddressed ? `${objective} · addressee not yet known` : `${objective} · ${d.recipient.organisation}${d.recipient.channel === "UNICROSS" ? " · reply comes back through DD" : d.recipient.organisationType === "BANK" ? " nodal officer" : ""}`,
        objective,
        status: deferred
          ? { text: "Deferred", tone: "neutral" }
          : d.status === "SUBMISSION_FAILED"
            ? { text: "Send failed", tone: "gap" }
            : view.gmail.on && view.mode !== "VIEW"
              ? view.mode === "WAITING_APPROVAL"
                ? { text: "Waiting for approval", tone: "wait" }
                : view.mode === "ASK_APPROVAL"
                  ? { text: "Needs approval", tone: "wait" }
                  : !view.canApproveAndSend
                    ? { text: "Type the address", tone: "gap" }
                    : d.needsReview
                      ? { text: "Check, then send", tone: "wait" }
                      : { text: "Ready to send", tone: "info" }
            : view.unaddressed
              ? { text: view.unaddressed.gap ? "No addressee yet" : "Ready to address", tone: "gap" }
            : view.demoAddress
              ? { text: "Demonstration address", tone: "gap" }
            : d.needsReview && view.mode !== "VIEW"
              ? { text: "Check before sending", tone: "gap" }
            : !view.recipient.verified && view.mode !== "VIEW"
              ? { text: "Address not verified", tone: "wait" }
            : view.mode === "WAITING_APPROVAL"
              ? { text: "Waiting for approval", tone: "wait" }
              : view.mode === "ASK_APPROVAL"
                ? { text: "Needs approval", tone: "wait" }
                : view.delivery.viaIo && view.delivery.handedOverAt && d.status === "APPROVED"
                  ? { text: "Mailed to the IO · forward it", tone: "wait" }
                  : d.status === "APPROVED"
                    ? { text: view.delivery.viaIo ? "Approved · mail it to the IO" : "Approved · ready to send", tone: "info" }
                    : { text: "Ready to send", tone: "info" },
        deferred,
        deferredNote: deferred ? t.statusReason : null,
        ruleId: t.ruleId,
        request: view,
      };
      order = 20;
    } else if (t.status === "BLOCKED") {
      a = { ...base(t), kind: "BLOCKED", title: t.title, why, route: `${objective} · ${t.recipientHint ?? "recipient not yet known"}`, objective, status: { text: "Waits", tone: "gap" }, deferred, deferredNote: null, ruleId: t.ruleId, request: null };
      // A request that waits only for its addressee: what is missing, how to find it, and drafting it without.
      if (t.requestCategory && writer) a.gap = await draftGap(db, kase, t);
      order = 30;
    } else if (t.kind === "DECISION" || t.ruleId === "FUNDS_RESTORATION") {
      a = {
        ...base(t),
        kind: "DECISION",
        title: t.ruleId === "FUNDS_RESTORATION" ? t.title.replace(/^Prepare restoration of/, "Decide how to restore") : t.title,
        why,
        route: `${objective} · your decision${t.ruleId === "FUNDS_ALLOCATION_BASIS" ? " · SOP 2026, §7.3" : " · SOP 2026, §7.1"}`,
        objective,
        status: deferred ? { text: "Deferred", tone: "neutral" } : { text: "Your decision", tone: "wait" },
        deferred,
        deferredNote: deferred ? t.statusReason : null,
        ruleId: t.ruleId,
        request: null,
      };
      order = 40;
    } else if (t.generatedBy === "OFFICER") {
      const wasSetAside = reopened.has(t.id);
      a = { ...base(t), kind: "LEAD", title: t.title, why: wasSetAside ? join("Reopened by you", t.purpose) : t.purpose, route: `${objective} · ${wasSetAside ? "reopened lead" : "your task"}`, objective, status: deferred ? { text: "Deferred", tone: "neutral" } : { text: "Needs evidence", tone: "gap" }, deferred, deferredNote: deferred ? t.statusReason : null, ruleId: null, request: null };
      order = 60;
    } else if (t.requestCategory) {
      // Said before the officer tries: a request whose recipient cannot be found yet.
      const gap = writer ? await draftGap(db, kase, t) : null;
      a = { ...base(t), kind: "REQUEST", title: t.title, why, route: `${objective} · ${t.recipientHint ?? "route not configured"}`, objective, status: gap && !deferred ? { text: "Missing a detail", tone: "gap" } : neutral("Not drafted"), deferred, deferredNote: deferred ? t.statusReason : null, ruleId: t.ruleId, request: null };
      a.note = gap?.message ?? null;
      a.gap = gap;
      order = t.priority === "LOW" ? 55 : 50;
    } else {
      a = { ...base(t), kind: "LEAD", title: t.title, why, route: objective, objective, status: neutral(t.kind === "MISSING_INFORMATION" ? "Missing" : "Open"), deferred, deferredNote: deferred ? t.statusReason : null, ruleId: t.ruleId, request: null };
      order = 58;
    }
    // CCTV footage is kept for a limited time: say how old the withdrawal is.
    if (t.ruleId === "EVIDENCE_ATM_CCTV") {
      const loc = locations.find((l) => t.dedupeKey === `CCTV:${l.id}`);
      if (loc?.eventAt) {
        const days = calendarDays(loc.eventAt, at);
        a.note = `Footage is usually kept 30 to 90 days. The withdrawal was ${days} ${days === 1 ? "day" : "days"} ago${days < 25 ? ", so there is time" : ", so the request should not wait"}.`;
      }
    }
    // Who it goes to, as a name: never a stand-in ("Addressee not yet known") or a hint ("…, once identified").
    const named = (org: string | null | undefined) => (org && !/not yet known|once identified|new mail|from the (?:routing directory|nodal officer list)/i.test(org) ? org : null);
    const sentOrg = sentReq && !["UNADDRESSED", "MANUAL"].includes(sentReq.recipient.organisationType) ? shortOrg(sentReq.recipient.organisation) : null;
    const draftOrg = d && !["UNADDRESSED", "MANUAL"].includes(d.recipient.organisationType) ? shortOrg(d.recipient.organisation) : null;
    a.line = plainLine({ ruleId: t.ruleId, title: a.title, why, subject: subject ? { kind: subject.kind, label: subject.label, value: subject.value } : null, org: named(draftOrg ?? sentOrg ?? t.recipientHint?.split(/[:(]/)[0]?.trim()) });
    raw.push({ a, prereqs, order, dedupeKey: t.dedupeKey });
  }
  for (const r of reminders) {
    const parent = requests.find((p) => p.id === r.parentRequestId)!;
    const view = requestView(r)!;
    raw.push({
      a: {
        taskId: r.taskId ?? `reminder:${r.id}`,
        taskVersion: 0,
        kind: "REMINDER",
        title: `Send the reminder to ${shortOrg(parent.recipient.organisation)} for ${parent.reference}`,
        why: `${parent.reference} is still missing ${list(r.items.map((i) => WHAT[i.itemType] ?? i.label.toLowerCase()))}. The reminder quotes the original request.`,
        route: `${OBJ.FINANCIAL} · ${parent.recipient.organisation}`,
        objective: "Recovery",
        status: r.status === "SUBMISSION_FAILED" ? { text: "Send failed", tone: "gap" } : view.mode === "APPROVE_AND_SEND" || view.mode === "SEND" ? { text: "Reminder ready", tone: "wait" } : { text: "Needs approval", tone: "wait" },
        deferred: false,
        deferredNote: null,
        gap: null,
        line: `Send ${shortOrg(parent.recipient.organisation)} a reminder for ${parent.reference}. They have not yet sent the ${list(r.items.map((i) => WHAT[i.itemType] ?? i.label.toLowerCase()))}.`,
        ruleId: "FOLLOW_UP_DUE",
        question: `Will ${shortOrg(parent.recipient.organisation)} send what ${parent.reference} is still missing?`,
        chain: [],
        note: null,
        request: view,
      },
      prereqs: [],
      order: 45,
      dedupeKey: `FOLLOWUP:${parent.id}`,
    });
  }

  // Drafts that a blocked action waits on come first.
  const blockers = new Set(raw.flatMap((x) => x.prereqs.filter((p) => !p.met && p.dependsOn).map((p) => p.dependsOn!)));
  for (const x of raw) if ((x.a.kind === "DRAFT" || x.a.kind === "SENT") && blockers.has(x.dedupeKey)) x.order = 10;
  for (const x of raw) if (x.a.kind === "SENT" && !blockers.has(x.dedupeKey)) x.order = 20;
  raw.sort((p, q) => Number(p.a.deferred) - Number(q.a.deferred) || p.order - q.order);
  const final = raw;
  const rankOf = new Map(final.map((x, i) => [x.dedupeKey, i + 1]));
  const actions: NextAction[] = final.map((x, i) => {
    const prerequisites = x.prereqs.map((p) => ({ label: p.label, met: p.met, basis: p.basis, dependsOnRank: p.dependsOn ? (rankOf.get(p.dependsOn) ?? null) : null }));
    const dep = prerequisites.find((p) => !p.met && p.dependsOnRank);
    const blocker = dep ? final[dep.dependsOnRank! - 1]! : null;
    const blockedBy = dep && blocker ? { rank: dep.dependsOnRank!, title: blocker.a.title } : null;
    const status = x.a.kind === "BLOCKED" ? (blockedBy ? { text: `Waits on ${blockedBy.rank}`, tone: "gap" as const } : { text: "Not ready", tone: "gap" as const }) : x.a.status;
    // What has to happen first: what is already known, the action it waits on, the reply, then this one.
    let chain = x.a.chain;
    if (x.a.kind === "BLOCKED") {
      const blockerSent = blocker?.a.kind === "SENT";
      const org = blocker?.a.request ? shortOrg(blocker.a.request.recipient.org) : "The recipient";
      chain = [
        ...prerequisites.filter((p) => p.met).map((p) => ({ text: p.label, sub: p.basis, state: "done" as const })),
        ...prerequisites
          .filter((p) => !p.met)
          .flatMap((p) =>
            blocker && p.dependsOnRank
              ? [
                  { text: blockerSent ? `${blocker.a.request?.reference ?? "The request"} sent to ${org}, waiting for the reply` : `${blocker.a.title}: waiting for your approval`, sub: `Action ${p.dependsOnRank} · ${p.basis.replace(/\s*\((?:[A-Z]\.)?(?:REQ|RES)-[\w/-]+\)\.?$/, ".")}`, state: blockerSent ? ("done" as const) : ("now" as const) },
                  { text: `${org} replies and the ${p.label.replace(/ known$/, "").replace(/^([A-Z])(?=[a-z])/, (c) => c.toLowerCase())} is read from it`, sub: "You confirm it when the reply arrives", state: blockerSent ? ("now" as const) : ("todo" as const) },
                ]
              : [{ text: p.label, sub: p.basis, state: "now" as const }],
          ),
        { text: x.a.ruleId === "EVIDENCE_ATM_CCTV" ? "The CCTV request is drafted to the operator" : "The request for this action is drafted", sub: "This action becomes ready and moves up", state: "todo" as const },
      ];
    }
    return { ...x.a, rank: i + 1, prerequisites, blockedBy, status, chain };
  });

  // Leads set aside, with why; derived "not a lead" entries for numbers whose role is known.
  const setAside: SetAside[] = [];
  for (const t of tasks.filter((x) => x.status === "DISMISSED")) {
    const reason = t.statusReason ?? "Set aside";
    setAside.push({ id: t.id, title: t.title, reason, label: /duplicate/i.test(reason) ? "Duplicate" : /not enough|unsupported/i.test(reason) ? "Unsupported" : "Closed", canReopen: true, taskVersion: t.version });
  }
  for (const t of tasks.filter((x) => reopened.has(x.id) && ACTIVE.includes(x.status))) {
    const rank = actions.find((a) => a.taskId === t.id)?.rank;
    setAside.push({ id: t.id, title: t.title, reason: reopened.get(t.id)!, label: "Reopened", rankNow: rank ?? null, canReopen: false, taskVersion: t.version });
  }
  for (const e of entities.filter((x) => x.kind === "PHONE" && /complainant'?s own number/i.test(x.caseRole ?? ""))) {
    setAside.push({ id: null, title: `Complainant’s own number ${shownId(e.value)}`, reason: "Not a lead: whose number it is is known", label: "Closed", canReopen: false, taskVersion: null });
  }
  const counts = {
    all: actions.length,
    ready: actions.filter(isReady).length,
    waiting: actions.filter(needsSomething).length,
    deferred: actions.filter((a) => a.deferred).length,
    open: actions.filter((a) => !a.deferred && a.kind !== "SENT" && a.kind !== "DECIDED").length,
  };
  return { caseId, actions, setAside, counts };
}

export type NextActionsData = Awaited<ReturnType<typeof getNextActions>>;

/** "Ready to send": a draft or reminder this officer can approve and send now. */
export const isReady = (a: Pick<NextAction, "kind" | "deferred" | "request">) => (a.kind === "DRAFT" || a.kind === "REMINDER") && !a.deferred && !!a.request?.canApproveAndSend;
/** "Needs something": waiting on another action, a decision, evidence or someone's approval. */
export const needsSomething = (a: Pick<NextAction, "kind" | "deferred" | "request">) =>
  !a.deferred && (a.kind === "BLOCKED" || a.kind === "DECISION" || a.kind === "LEAD" || a.kind === "REQUEST" || ((a.kind === "DRAFT" || a.kind === "REMINDER") && !a.request?.canApproveAndSend));
