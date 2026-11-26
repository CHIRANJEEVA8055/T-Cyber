import { formatDayMonthIST } from "@/domain/time";
import type { Tone } from "@/domain/standing";
import { canWriteCase } from "@/domain/permissions";
import type { Db } from "../db";
import type { SessionUser } from "../auth/session";
import { loadCaseForUser } from "../auth/access";
import { now } from "../clock";
import { calendarDays, shortOrg } from "./dashboard";
import { listInboxForCase } from "./inbox";
import { getAppConfig } from "../config";
import { coreRef, responseRef } from "@/domain/request-ref";
import { shownId } from "@/domain/identifiers";

/**
 * Requests & responses (design: Requests artboard): replies waiting for the officer's check first, then every
 * request with where it stands. Status words come from the request workflow; nothing is inferred.
 */

const ITEM: Record<string, string> = { STATEMENT: "Statement", KYC: "KYC", ATM_DETAILS: "ATM details", CDR: "CDR", SUBSCRIBER_DETAILS: "CAF", ACCOUNT_DETAILS: "account details", BENEFICIARY_DETAILS: "beneficiary details", IMEI: "IMEI", HOLD_CONFIRMATION: "hold", PRESERVATION_CONFIRMATION: "Preservation", BALANCE_CONFIRMATION: "balance", IP_LOGS: "session logs", LINKED_CONTACTS: "linked contacts", RESTORATION_CONFIRMATION: "Restoration", OTHER: "records" };
const UNSENT = ["DRAFT", "AWAITING_APPROVAL", "APPROVED", "SUBMISSION_FAILED"];
const listItems = (xs: string[]) => {
  const u = [...new Set(xs)];
  const s = u.length <= 1 ? (u[0] ?? "") : `${u.slice(0, -1).join(", ")} and ${u.at(-1)}`;
  return s.charAt(0).toUpperCase() + s.slice(1);
};

export type ReqTab = "needs" | "waiting" | "answered";

export async function getRequestsView(db: Db, user: SessionUser, caseId: string, at = now()) {
  const kase = await loadCaseForUser(db, user, caseId, "read");
  const writer = canWriteCase(user, { stationId: kase.stationId, assignedUserIds: kase.assignments.map((a) => a.userId) });
  const [requests, responses] = await Promise.all([
    db.request.findMany({ where: { caseId, status: { not: "DISCARDED" } }, include: { recipient: true, items: { orderBy: { sortOrder: "asc" } }, subjects: { include: { entity: true } }, responses: { orderBy: { receivedAt: "desc" } } }, orderBy: [{ createdAt: "asc" }] }),
    db.response.findMany({ where: { caseId, OR: [{ reviewStatus: { not: "APPLIED" } }, { matchStatus: "NEEDS_MATCH_REVIEW" }] }, include: { findings: true, request: { include: { recipient: true, items: true, subjects: { include: { entity: true } } } }, attachments: { select: { id: true, category: true } } }, orderBy: { receivedAt: "desc" } }),
  ]);
  const about = (subjects: { entity: { kind: string; value: string; label: string } }[]) => {
    const e = subjects[0]?.entity;
    if (!e) return "The case";
    if (e.kind === "PHONE") return `Mobile ${shownId(e.value)}`;
    if (e.kind === "BANK_ACCOUNT") return `Account ${shownId(e.value)}`;
    if (e.kind === "PLATFORM_PROFILE") return `Profile “${e.value}”`;
    if (e.kind === "UPI_ID") return `UPI ${e.value}`;
    return e.label;
  };
  const party = (r: { recipient: { organisation: string; organisationType: string; channel: string } }) =>
    r.recipient.organisationType === "BANK" ? `${shortOrg(r.recipient.organisation)} nodal officer` : r.recipient.channel === "UNICROSS" ? `${shortOrg(r.recipient.organisation)}, Zonal ACP` : shortOrg(r.recipient.organisation);

  // Each reply's reference: RES- and its request's reference, "-2", "-3" for later replies to the same request.
  const resRef = new Map<string, string>();
  for (const r of requests) [...r.responses].sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime() || a.id.localeCompare(b.id)).forEach((x, i) => resRef.set(x.id, responseRef(r.reference, i + 1, getAppConfig().requests.referencePrefix)));

  // --- Replies waiting for a check ------------------------------------------------------------
  const replies = responses.map((x) => {
    const r = x.request;
    const needsMatch = x.matchStatus !== "MATCHED";
    const realAttachments = x.attachments.filter((a) => a.category !== "EMAIL_MESSAGE").length;
    const firs = x.firCount && x.firCount > 1 ? x.firCount : null;
    const answered = r ? r.items.filter((i) => x.findings.some((f) => f.requestItemId === i.id) || i.status === "RECEIVED").length : 0;
    const pending = x.findings.filter((f) => f.decision === "PENDING").length;
    return {
      id: x.id,
      kind: "reply" as const,
      ref: (!needsMatch && resRef.get(x.id)) || "Reply",
      refSub: needsMatch ? "not matched yet" : r ? `reply to ${r.reference}` : "",
      party: r ? `${party(r)}${x.channel === "PORTAL_DOWNLOAD" ? ", portal" : /dd\./i.test(x.fromAddress) ? ", via DD" : ""}` : x.fromAddress,
      about: r && !needsMatch ? about(r.subjects) : (x.subject.replace(/^(re|fwd?):\s*/i, "") || "Reply"),
      aboutSub: firs ? `${realAttachments === 1 ? "One attachment" : `${realAttachments} attachments`}, ${firs} FIRs` : r ? listItems(r.items.map((i) => ITEM[i.itemType] ?? i.label)) : `${realAttachments} ${realAttachments === 1 ? "attachment" : "attachments"}`,
      date: formatDayMonthIST(x.receivedAt),
      pill: needsMatch ? { text: "Needs a match", tone: "wait" as Tone } : { text: "Matched", tone: "ok" as Tone },
      latest: needsMatch
        ? `${firs ? `Covers ${firs} FIRs · ` : ""}pick the request it answers`
        : `${r ? `Answers ${answered} of ${r.items.length}` : "Reply"}${pending ? ` · ${pending} ${pending === 1 ? "fact" : "facts"} waiting for your check` : " · waiting for your check"}`,
      href: `/cases/${caseId}/responses/${x.id}`,
      tab: "needs" as ReqTab,
      at: x.receivedAt.toISOString(),
    };
  });

  // --- Requests -------------------------------------------------------------------------------
  const rows = requests.map((r) => {
    const parent = r.parentRequestId ? requests.find((p) => p.id === r.parentRequestId) : undefined;
    const days = r.submittedAt ? calendarDays(r.submittedAt, at) : null;
    const lastReply = r.responses[0];
    const got = r.items.filter((i) => i.status === "RECEIVED").length;
    const missing = r.items.filter((i) => i.status === "PENDING" || i.status === "NOT_PROVIDED");
    const reminder = requests.filter((x) => x.parentRequestId === r.id).at(-1);
    const followUpDue = !!r.followUpAt && r.followUpAt < at && ["SUBMITTED", "ACKNOWLEDGED", "PARTIAL_RESPONSE"].includes(r.status);
    let status: { text: string; tone: Tone };
    let latest: string;
    let tab: ReqTab;
    switch (r.status) {
      case "DRAFT":
        status = { text: "Draft", tone: "info" };
        latest = r.needsReview ? `Check first: ${r.needsReviewReason ?? "its sources changed"}` : "Ready for your approval";
        tab = "needs";
        break;
      case "AWAITING_APPROVAL":
        status = { text: "With the approver", tone: "wait" };
        latest = "Waiting for approval";
        tab = "needs";
        break;
      case "APPROVED":
        status = { text: "Approved", tone: "info" };
        latest = "Approved, not sent yet";
        tab = "needs";
        break;
      case "SUBMISSION_FAILED":
        status = { text: "Send failed", tone: "gap" };
        latest = "The simulated send failed; nothing left the station. Send it again.";
        tab = "needs";
        break;
      case "SUBMITTED":
        status = { text: `Sent · ${days ?? 0} ${days === 1 ? "day" : "days"}`, tone: followUpDue ? "gap" : "neutral" };
        latest = followUpDue ? `No reply; follow-up was due ${formatDayMonthIST(r.followUpAt!)}` : `No reply yet${r.followUpAt ? ` · follow up ${formatDayMonthIST(r.followUpAt)}` : ""}`;
        tab = followUpDue ? "needs" : "waiting";
        break;
      case "ACKNOWLEDGED":
        status = { text: "Acknowledged", tone: "neutral" };
        latest = `Received by ${shortOrg(r.recipient.organisation)}${lastReply ? ` ${formatDayMonthIST(lastReply.receivedAt)}` : ""}; no answer yet`;
        tab = followUpDue ? "needs" : "waiting";
        break;
      case "PARTIAL_RESPONSE":
        status = { text: `${got} of ${r.items.length} in`, tone: "wait" };
        latest = `${listItems(missing.map((i) => ITEM[i.itemType] ?? i.label))} missing${reminder ? (UNSENT.includes(reminder.status) ? " · reminder drafted" : ` · reminder sent ${reminder.submittedAt ? formatDayMonthIST(reminder.submittedAt) : ""}`) : ""}`;
        tab = reminder && UNSENT.includes(reminder.status) ? "needs" : "answered";
        break;
      case "COMPLETE_RESPONSE":
        status = { text: "Answered", tone: "ok" };
        latest = lastReply ? `Reply ${formatDayMonthIST(lastReply.receivedAt)}${r.preservedUntil ? ` · preserved until ${formatDayMonthIST(r.preservedUntil)}` : ""}` : "Answered";
        tab = "answered";
        break;
      case "REJECTED":
        status = { text: "Refused", tone: "gap" };
        latest = "The recipient refused; see the reply for the reason";
        tab = "answered";
        break;
      default:
        status = { text: r.status.toLowerCase(), tone: "neutral" };
        latest = "";
        tab = "waiting";
    }
    return {
      id: r.id,
      kind: "request" as const,
      ref: r.reference,
      refSub: parent ? `reminder for ${parent.reference}` : r.legacyReference ? `sent as ${r.legacyReference}` : "",
      party: party(r),
      about: about(r.subjects),
      aboutSub: r.parentRequestId ? `Missing: ${listItems(r.items.map((i) => ITEM[i.itemType] ?? i.label))}` : listItems(r.items.map((i) => ITEM[i.itemType] ?? i.label)),
      date: formatDayMonthIST(r.submittedAt ?? r.createdAt),
      pill: status,
      latest,
      href: UNSENT.includes(r.status) ? `/cases/${caseId}/actions?task=${r.taskId ?? ""}` : `/cases/${caseId}/requests/${r.id}`,
      detailHref: `/cases/${caseId}/requests/${r.id}`,
      tab,
      at: (r.submittedAt ?? r.createdAt).toISOString(),
    };
  });
  // Drafts are handled in Next actions when they have one; otherwise in the request itself.
  for (const row of rows) if (row.href.endsWith("?task=")) row.href = row.detailHref;

  const inbox = writer ? await listInboxForCase(db, user, caseId) : [];
  // In the order of their numbers in the case (001, 002 …, each reminder after its request), whatever their kind's letter.
  const all = [...replies, ...rows.sort((a, b) => coreRef(a.ref).localeCompare(coreRef(b.ref), undefined, { numeric: true }))];
  // Requests a reply can be filed against when it is imported from a file (sent, and not closed as rejected).
  const replyTargets = requests
    .filter((r) => ["SUBMITTED", "ACKNOWLEDGED", "PARTIAL_RESPONSE", "COMPLETE_RESPONSE"].includes(r.status))
    .sort((a, b) => (a.caseSeq ?? 0) - (b.caseSeq ?? 0))
    .map((r) => ({ id: r.id, label: `${r.reference} · ${shortOrg(r.recipient.organisation)} · ${about(r.subjects)}`, from: r.recipient.organisationType === "UNADDRESSED" ? "" : r.recipient.address }));
  return {
    caseId,
    canWrite: writer,
    replyTargets,
    rows: all,
    counts: { all: all.length, needs: all.filter((r) => r.tab === "needs").length, waiting: all.filter((r) => r.tab === "waiting").length, answered: all.filter((r) => r.tab === "answered").length },
    inbox: inbox.map((m) => ({
      id: m.id,
      from: m.fromLabel,
      subject: m.subject,
      when: `${calendarDays(m.receivedAt, at) === 0 ? "Today" : formatDayMonthIST(m.receivedAt)} ${new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(m.receivedAt)}`,
      attachments: m.attachments,
      score: m.score,
      looksLike: `${m.looksLike === "ACKNOWLEDGEMENT" ? "an acknowledgement of" : "a reply to"} ${m.requestReference}`,
      requestId: m.requestId,
      fromGmail: m.source === "GMAIL",
      suggestion: m.suggestion,
    })),
  };
}
export type RequestsViewData = Awaited<ReturnType<typeof getRequestsView>>;
