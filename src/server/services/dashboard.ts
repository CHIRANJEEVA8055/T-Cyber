import { caseStanding, type StandingAction, type StandingFacts, type StandingStatus, type Tone } from "@/domain/standing";
import { caseMo, classifyMo, MO_VERTICALS, type MoKey } from "@/domain/mo-verticals";
import { formatDateIST, formatDayMonthIST, utcToIstDateInput } from "@/domain/time";
import { formatInr, formatLakh } from "@/domain/money";
import { canReadCase } from "@/domain/permissions";
import { shortRank } from "@/lib/cn";
import type { Db } from "../db";
import type { SessionUser } from "../auth/session";
import { now as clockNow } from "../clock";
import { getAppConfig } from "../config";
import { assistantAuthorId } from "../assistant-identity";
import { assertCaseWorker } from "../auth/access";
import { formatSections } from "@/domain/legal-sections";

/**
 * The station dashboard: every figure is counted from the records. Officers see the station's register (so they
 * know the workload and what is lapsing) but only open, and only see complainants of, the cases assigned to them;
 * supervisors see everything. Actions are listed only for cases the viewer can open.
 */

const AWAITING = ["SUBMITTED", "ACKNOWLEDGED", "PARTIAL_RESPONSE"];
const NOT_SENT = ["DRAFT", "AWAITING_APPROVAL", "APPROVED", "SUBMISSION_FAILED"];
const DAY = 24 * 60 * 60 * 1000;

/** The station's investigation verticals (MO.docx), and "NONE" for a case whose FIR does not show one. */
export type FraudType = MoKey | "NONE";

// A register complaint not yet linked to a case: its own words decide first, then the portal's category.
const CATEGORY_VERTICAL: Record<string, MoKey> = { INVESTMENT: "INVESTMENT", OTP: "OTP", JOB: "JOB", LOAN: "MISC", COURIER: "MISC", SEXTORTION: "SOCIAL_MEDIA", UPI: "MISC" };
function complaintVertical(x: { category: string; categoryLabel: string; note: string | null; case: { moVertical: string | null; moSubtype: string | null; narrative: string; legalSections: string | null } | null }): FraudType {
  if (x.case) return caseMo(x.case).vertical?.key ?? "NONE";
  return classifyMo({ facts: `${x.categoryLabel}. ${x.note ?? ""}` }).vertical?.key ?? CATEGORY_VERTICAL[x.category] ?? "NONE";
}

/** "UNICROSS, Zonal ACP Madhapur" → "UNICROSS"; "Bank B" stays. */
export function shortOrg(org: string): string {
  return org.split(",")[0]!.trim();
}

/** The case's sections as shown on the dashboard: "318(4) BNS, 66D IT Act". */
export function shortSections(s: string | null): string {
  return formatSections(s);
}


/** Whole days between two instants as the calendar counts them in IST (yesterday 23:00 to today 01:00 is 1). */
export function calendarDays(from: Date, to: Date): number {
  const day = (d: Date) => Math.floor((d.getTime() + 330 * 60 * 1000) / DAY);
  return day(to) - day(from);
}

const ITEM_NAME: Record<string, string> = { KYC: "the KYC", STATEMENT: "the statement", HOLD_CONFIRMATION: "the hold confirmation", CDR: "the CDR", SUBSCRIBER_DETAILS: "the CAF", ACCOUNT_DETAILS: "the account details", BENEFICIARY_DETAILS: "the beneficiary details", IMEI: "the IMEI history", ATM_DETAILS: "the ATM details", LINKED_CONTACTS: "the linked contacts", BALANCE_CONFIRMATION: "the balance", PRESERVATION_CONFIRMATION: "the preservation confirmation" };
function missingItems(items: { itemType: string; label: string; status: string }[]): string {
  const names = items.filter((i) => i.status === "PENDING" || i.status === "NOT_PROVIDED").map((i) => ITEM_NAME[i.itemType] ?? i.label.toLowerCase());
  return names.length ? names.join(" and ") : "items";
}

function requestWhat(r: { category: string; parentRequestId: string | null; items: { itemType: string }[] }): string {
  if (r.parentRequestId) return "reminder";
  const types = new Set(r.items.map((i) => i.itemType));
  if (r.category === "HOLD") return types.has("STATEMENT") ? "statement, KYC, hold" : "hold";
  if (r.category === "PRESERVATION") return "preservation";
  if (r.category === "RESTORATION") return "restoration";
  if (types.has("CDR")) return "CDR";
  if (types.has("STATEMENT")) return "statement";
  if (types.has("KYC")) return "KYC";
  return "information";
}

export interface CaseRow {
  id: string;
  fir: string;
  kind: string;
  sections: string;
  complainant: string | null;
  extraVictims: number;
  officer: string;
  mine: boolean;
  canOpen: boolean;
  registeredAt: string | null;
  lostMinor: string;
  heldMinor: string;
  pill: { text: string; tone: Tone };
  status: StandingStatus;
  type: FraudType;
  ageDays: number;
  search: string;
}

export interface ActionRow extends StandingAction {
  caseId: string;
  fir: string;
  kindLabel: string;
  href: string;
}

export interface DrillRow {
  a: string;
  sub: string;
  b: string;
  c: string;
  d: string;
  href: string | null;
  /** What columns c and d sort by when they show a date or an amount (an instant, or paise). */
  cs?: string | number | null;
  ds?: string | number | null;
}

export interface DrillGroup {
  key: string;
  label: string;
  count: string;
  sub: string;
  value: number;
  rows: DrillRow[];
}

function hrefFor(kind: "ACTION" | "CASE", a: StandingAction | null, caseId: string) {
  if (kind === "CASE" || !a) return `/cases/${caseId}`;
  // A reminder is drafted in Next actions (by the case upkeep, once the follow-up date passes), where it is checked and sent.
  if (a.kind === "APPROVE" || a.kind === "SEND_AGAIN" || a.kind === "DECIDE" || a.kind === "REMIND") return `/cases/${caseId}/next-actions`;
  if (a.kind === "MATCH" || a.kind === "CHECK") return `/cases/${caseId}/requests`;
  if (a.kind === "HOLD") return `/cases/${caseId}/recovery`;
  return `/cases/${caseId}/recovery#contacts`;
}

/** A date filter from the dashboard: IST calendar days, both included. */
export interface DayRange {
  from: string;
  to: string;
}
const DAYS = /^\d{4}-\d{2}-\d{2}$/;
/** The instants a range covers (start included, end excluded), or null for a range that is not one. */
export function rangeBounds(r: DayRange | null | undefined): { start: Date; end: Date; days: number } | null {
  if (!r || !DAYS.test(r.from) || !DAYS.test(r.to) || r.from > r.to) return null;
  const start = new Date(Date.parse(`${r.from}T00:00:00Z`) - 330 * 60 * 1000);
  const end = new Date(Date.parse(`${r.to}T00:00:00Z`) - 330 * 60 * 1000 + DAY);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  const days = Math.round((end.getTime() - start.getTime()) / DAY);
  return days > 0 && days <= 366 * 10 ? { start, end, days } : null;
}

export async function getDashboard(db: Db, user: SessionUser, at = clockNow(), opts: { kpi?: DayRange | null; trends?: DayRange | null } = {}) {
  assertCaseWorker(user);
  const assistantId = await assistantAuthorId(db, user.stationId);
  const users = await db.user.findMany({ where: { stationId: user.stationId }, select: { id: true, displayName: true, rank: true } });
  const nameOf = (id: string | undefined) => {
    if (id === user.id) return "You";
    const u = users.find((x) => x.id === id);
    return u ? `${shortRank(u.rank)} ${u.displayName}` : "—";
  };
  const cases = await db.case.findMany({
    where: { stationId: user.stationId, referenceType: "FIR" },
    include: {
      assignments: true,
      claims: { include: { victim: true }, orderBy: { createdAt: "asc" } },
      holds: { include: { account: true } },
      refunds: true,
      requests: { include: { recipient: true, items: true } },
      responses: { where: { reviewStatus: { not: "APPLIED" } }, include: { request: { include: { recipient: true, items: true } }, findings: { select: { requestItemId: true } } } },
      tasks: { where: { status: { in: ["OPEN", "BLOCKED", "DRAFT_PREPARED"] } } },
      contactLogs: { orderBy: { at: "asc" } },
      allocations: { where: { status: "PROPOSED" } },
    },
    orderBy: [{ registeredAt: "desc" }, { firNumber: "desc" }],
  });
  const lastChange = await db.auditEvent.groupBy({
    by: ["caseId"],
    where: { case: { stationId: user.stationId }, NOT: [{ action: { startsWith: "contact." } }, { action: { startsWith: "assistant." } }, { action: { startsWith: "task." } }, { action: { startsWith: "view" } }] },
    _max: { at: true },
  });
  const closedAt = await db.auditEvent.groupBy({ by: ["caseId"], where: { action: "case.closed", case: { stationId: user.stationId } }, _max: { at: true } });

  const rows: CaseRow[] = [];
  const closed: (CaseRow & { closedAt: string | null; returnedMinor: string; outcome: { text: string; tone: Tone } })[] = [];
  const actions: ActionRow[] = [];
  for (const c of cases) {
    const io = c.assignments.find((a) => a.role === "INVESTIGATING_OFFICER") ?? c.assignments[0];
    const canOpen = canReadCase(user, { stationId: c.stationId, assignedUserIds: c.assignments.map((a) => a.userId) });
    const mine = io?.userId === user.id;
    const victims = c.claims.map((cl) => cl.victim.label);
    const lost = c.claims.reduce((s, cl) => s + cl.lossAmountMinor, 0n);
    const held = c.holds.filter((h) => h.status === "CONFIRMED_HELD").reduce((s, h) => s + (h.confirmedAmountMinor ?? 0n), 0n);
    const credited = c.refunds.filter((r) => r.status === "CREDIT_CONFIRMED").reduce((s, r) => s + r.amountMinor, 0n);
    const pipeline = c.refunds.filter((r) => r.status === "AUTHORISED" || r.status === "INITIATED").reduce((s, r) => s + r.amountMinor, 0n);
    const awaiting = c.requests.filter((r) => AWAITING.includes(r.status));
    const childDraft = (id: string) => c.requests.some((r) => r.parentRequestId === id && NOT_SENT.includes(r.status));
    const drafts = c.requests
      .filter((r) => r.status === "DRAFT" && r.createdById === assistantId && !r.needsReview && !r.parentRequestId)
      .sort((a, b) => (a.caseSeq ?? 999) - (b.caseSeq ?? 999))
      .map((r) => ({ ref: r.reference, short: `${shortOrg(r.recipient.organisation)} ${requestWhat(r)}`, subjectIds: [] as string[], id: r.id }));
    const draftEntity = new Set(
      (await db.requestSubject.findMany({ where: { requestId: { in: drafts.map((d) => d.id) } } })).map((s) => s.entityId),
    );
    const blockedTitles = c.tasks
      .filter((t) => t.status === "BLOCKED")
      .filter((t) => (JSON.parse(t.prerequisitesJson) as { dependsOn?: string }[]).some((p) => p.dependsOn && draftEntity.has(p.dependsOn.split(":")[1] ?? "")))
      .map((t) => (t.ruleId === "EVIDENCE_ATM_CCTV" ? "CCTV" : t.title));
    const facts: StandingFacts = {
      drafts: drafts.map((d) => ({ ref: d.ref, short: d.short })),
      awaitingSupervisor: c.requests.filter((r) => r.status === "AWAITING_APPROVAL").length,
      failedSends: c.requests.filter((r) => r.status === "SUBMISSION_FAILED").map((r) => ({ ref: r.reference, org: shortOrg(r.recipient.organisation) })),
      decisions: c.tasks
        .filter((t) => t.status === "OPEN" && (t.ruleId === "FUNDS_ALLOCATION_BASIS" || t.ruleId === "FUNDS_RESTORATION"))
        .map((t) =>
          t.ruleId === "FUNDS_ALLOCATION_BASIS"
            ? { kind: "ALLOC" as const, title: t.title, why: "More than one victim's money went into the same account, so you must decide each victim's share before anything is returned." }
            : { kind: "RESTORE" as const, title: `Decide how to return the ${formatInr(held)} that is frozen`, why: `It is held for ${c.claims.length === 1 ? "one victim" : `${c.claims.length} victims`}; choose the route (bank or court) to give it back.` },
        ),
      repliesToMatch: c.responses.filter((r) => r.matchStatus === "NEEDS_MATCH_REVIEW").map((r) => ({ org: shortOrg(r.request?.recipient.organisation ?? r.fromAddress), firCount: r.firCount ?? 1 })),
      repliesToCheck: c.responses
        .filter((r) => r.matchStatus === "MATCHED")
        .map((r) => {
          const items = r.request?.items.length ?? 0;
          const answered = new Set(r.findings.map((f) => f.requestItemId).filter(Boolean)).size;
          return { org: shortOrg(r.request?.recipient.organisation ?? r.fromAddress), answers: items ? `Answers ${answered} of ${items}` : null };
        }),
      holdsExpiring: c.holds.filter((h) => h.status === "CONFIRMED_HELD" && h.expiresAt && h.expiresAt.getTime() - at.getTime() < 7 * DAY && (h.confirmedAmountMinor ?? 0n) > 0n).map((h) => ({ amountMinor: h.confirmedAmountMinor!, org: (JSON.parse(h.account.attributesJson) as { bank?: string }).bank ?? "the bank", expiresAt: h.expiresAt! })),
      remindersDue: awaiting
        .filter((r) => !r.parentRequestId && ((r.followUpAt && r.followUpAt < at) || childDraft(r.id)))
        .map((r) => ({
          ref: r.reference,
          org: shortOrg(r.recipient.organisation),
          what: requestWhat(r),
          days: calendarDays(r.submittedAt ?? r.createdAt, at),
          drafted: childDraft(r.id),
          missing: r.status === "PARTIAL_RESPONSE" ? missingItems(r.items) : null,
        })),
      waitingOn: awaiting.map((r) => ({ org: shortOrg(r.recipient.organisation) })),
      callbacks: (() => {
        const lastOut = [...c.contactLogs].reverse().find((l) => l.channel !== "CALL_IN");
        const ins = c.contactLogs.filter((l) => l.channel === "CALL_IN" && (!lastOut || l.at > lastOut.at));
        if (!ins.length) return null;
        const lc = lastChange.find((x) => x.caseId === c.id)?._max.at ?? null;
        return { count: ins.length, lastChangeAt: lc };
      })(),
      refunds: { creditedMinor: credited, pipelineMinor: pipeline },
      blockedTitles,
    };
    const s = caseStanding(facts, at);
    const fir = `${c.firNumber}/${c.firYear}`;
    const kind = c.fraudCategory ?? c.title;
    const row: CaseRow = {
      id: c.id,
      fir,
      kind,
      sections: shortSections(c.legalSections),
      complainant: canOpen ? (victims[0] ?? null) : null,
      extraVictims: canOpen ? Math.max(0, victims.length - 1) : 0,
      officer: nameOf(io?.userId),
      mine,
      canOpen,
      registeredAt: c.registeredAt?.toISOString() ?? null,
      lostMinor: lost.toString(),
      heldMinor: held.toString(),
      pill: s.pill,
      status: s.status,
      type: caseMo(c).vertical?.key ?? "NONE",
      ageDays: c.registeredAt ? Math.floor((at.getTime() - c.registeredAt.getTime()) / DAY) : 0,
      search: [fir, kind, shortSections(c.legalSections), canOpen ? victims.join(" ") : "", nameOf(io?.userId)].join(" ").toLowerCase(),
    };
    if (c.status === "CLOSED") {
      closed.push({
        ...row,
        closedAt: closedAt.find((x) => x.caseId === c.id)?._max.at?.toISOString() ?? null,
        returnedMinor: credited.toString(),
        outcome: c.chargeSheetedAt ? { text: "Charge sheet filed", tone: "neutral" } : credited >= lost && lost > 0n ? { text: "Fully returned", tone: "ok" } : credited > 0n ? { text: `${formatInr(credited)} returned`, tone: "ok" } : { text: c.closureReason?.split(";")[0]?.replace(/\.$/, "") ?? "Closed", tone: "neutral" },
      });
      continue;
    }
    rows.push(row);
    if (canOpen && mine) {
      for (const a of s.actions) actions.push({ ...a, caseId: c.id, fir, kindLabel: kind, href: hrefFor("ACTION", a, c.id) });
    } else if (canOpen && user.role === "SUPERVISOR") {
      // On other officers' cases a supervisor is needed only for what the routes reserve to supervisors.
      const forMe = c.requests.filter((r) => r.status === "AWAITING_APPROVAL");
      if (forMe.length) {
        const a: StandingAction = { kind: "APPROVE", what: forMe.length === 1 ? `Approve ${forMe[0]!.reference} written by ${nameOf(io?.userId)}` : `Approve ${forMe.length} requests written by ${nameOf(io?.userId)}`, why: `${forMe.map((r) => `${shortOrg(r.recipient.organisation)} ${requestWhat(r)}`).join(", ")}. They wait for your approval before they can go out.`, when: { text: "Today", tone: "wait" } };
        actions.push({ ...a, caseId: c.id, fir, kindLabel: kind, href: `/cases/${c.id}/requests` });
      }
      const proposed = c.allocations.reduce((sum, al) => sum + al.amountMinor, 0n);
      if (proposed > 0n) {
        const a: StandingAction = { kind: "DECIDE", what: `Confirm how ${formatInr(proposed)} is shared between the victims`, why: `${nameOf(c.allocations[0]!.createdById)} proposed ${c.allocations.length} ${c.allocations.length === 1 ? "share" : "shares"}; nothing is returned until you confirm.`, when: { text: "Decide", tone: "wait" } };
        actions.push({ ...a, caseId: c.id, fir, kindLabel: kind, href: `/cases/${c.id}/recovery` });
      }
    }
  }

  // Station figures, from the complaint register and the ledger.
  const anchorMonth = utcToIstDateInput(at).slice(0, 7);
  const monthStart = (back: number) => {
    const [y, m] = anchorMonth.split("-").map(Number) as [number, number];
    return new Date(Date.UTC(y, m - 1 - back, 1) - 330 * 60 * 1000);
  };
  const MONTH = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const monthName = (back: number) => MONTH[new Date(monthStart(back).getTime() + 330 * 60 * 1000).getUTCMonth()]!;
  const complaints = await db.complaint.findMany({ where: { receivedAt: { gte: monthStart(5) } }, include: { case: { include: { assignments: true, holds: true } } }, orderBy: { lossAmountMinor: "desc" } });
  const inMonth = (back: number) => complaints.filter((x) => x.receivedAt >= monthStart(back) && (back === 0 || x.receivedAt < monthStart(back - 1)));
  const sum = (xs: { lossAmountMinor: bigint }[]) => xs.reduce((s, x) => s + x.lossAmountMinor, 0n);
  const FAR = new Date(8.64e15);
  const months = [5, 4, 3, 2, 1, 0].map((back) => ({ back, name: monthName(back), list: inMonth(back), start: monthStart(back), end: back === 0 ? FAR : monthStart(back - 1) }));
  // The FIRs whose investigating officer is the viewer (as in My cases: the IO, or the first officer assigned).
  const ioOf = (c: (typeof cases)[number]) => (c.assignments.find((a) => a.role === "INVESTIGATING_OFFICER") ?? c.assignments[0])?.userId;
  const myFirs = cases.filter((c) => ioOf(c) === user.id);
  const openHolds = cases.filter((c) => c.status === "OPEN").flatMap((c) => c.holds.filter((h) => h.status === "CONFIRMED_HELD" && (h.confirmedAmountMinor ?? 0n) > 0n));
  const heldTotal = openHolds.reduce((s, h) => s + (h.confirmedAmountMinor ?? 0n), 0n);
  const lost6 = sum(complaints);

  const complaintRow = (x: (typeof complaints)[number]): DrillRow => {
    const kase = x.case;
    const open = kase ? canReadCase(user, { stationId: kase.stationId, assignedUserIds: kase.assignments.map((a) => a.userId) }) : false;
    return {
      a: kase ? `${kase.firNumber}/${kase.firYear}` : x.ackNumber,
      sub: kase ? `FIR · ${x.categoryLabel}` : x.status === "AWAITING_FIR" ? "NCRP · awaiting FIR" : `${x.channel === "HELPLINE_1930" ? "1930" : "NCRP"} · handled without an FIR`,
      b: kase && !open ? "—" : (x.complainantName ?? "Withheld"),
      c: formatDateIST(x.receivedAt),
      d: formatInr(x.lossAmountMinor),
      href: kase && open ? `/cases/${kase.id}` : null,
      cs: x.receivedAt.toISOString(),
      ds: Number(x.lossAmountMinor),
    };
  };

  // The money card for a chosen period: what complaints received in it lost, and what is held for them.
  const kb = rangeBounds(opts.kpi);
  const kpiRange = kb
    ? await (async () => {
        const list = await db.complaint.findMany({ where: { receivedAt: { gte: kb.start, lt: kb.end } }, include: { case: { include: { holds: true } } } });
        const seen = new Set<string>();
        let heldSum = 0n;
        let accounts = 0;
        for (const x of list) {
          if (x.case) {
            if (seen.has(x.case.id)) continue;
            seen.add(x.case.id);
            for (const h of x.case.holds.filter((h) => h.status === "CONFIRMED_HELD" && (h.confirmedAmountMinor ?? 0n) > 0n)) {
              heldSum += h.confirmedAmountMinor!;
              accounts++;
            }
          } else if (x.heldAmountMinor > 0n) {
            heldSum += x.heldAmountMinor;
            accounts++;
          }
        }
        const firs = myFirs.filter((c) => c.registeredAt && c.registeredAt >= kb.start && c.registeredAt < kb.end);
        return { range: opts.kpi!, lost: formatLakh(sum(list)), cases: list.length, held: formatLakh(heldSum), accounts, firs: firs.length, firsOpen: firs.filter((c) => c.status === "OPEN").length };
      })()
    : null;

  // Requests across the station's open cases (or those made in the chosen period).
  const tb = rangeBounds(opts.trends);
  const openCases = cases.filter((c) => c.status === "OPEN");
  const allReq = tb ? cases.flatMap((c) => c.requests.filter((r) => r.createdAt >= tb.start && r.createdAt < tb.end).map((r) => ({ r, c }))) : openCases.flatMap((c) => c.requests.map((r) => ({ r, c })));
  const canOpenCase = (c: (typeof cases)[number]) => canReadCase(user, { stationId: c.stationId, assignedUserIds: c.assignments.map((a) => a.userId) });
  const reqRow = ({ r, c }: (typeof allReq)[number], d: string): DrillRow => ({
    a: r.reference,
    sub: `FIR ${c.firNumber}/${c.firYear}`,
    b: c.fraudCategory ?? c.title,
    c: `${shortOrg(r.recipient.organisation)} · ${requestWhat(r)}`,
    d,
    href: canOpenCase(c) ? `/cases/${c.id}/requests` : null,
  });
  const notSent = allReq.filter(({ r }) => NOT_SENT.includes(r.status));
  const pending = (status: string) => status === "SUBMITTED" || status === "ACKNOWLEDGED";
  const due = allReq.filter(({ r }) => pending(r.status) && r.followUpAt && r.followUpAt < at);
  const waiting = allReq.filter(({ r }) => pending(r.status) && !(r.followUpAt && r.followUpAt < at));
  const answered = allReq.filter(({ r }) => r.status === "COMPLETE_RESPONSE" || r.status === "PARTIAL_RESPONSE" || r.status === "REJECTED");
  const days = (d: Date | null) => (d ? Math.max(0, calendarDays(d, at)) : 0);
  const requestGroups: DrillGroup[] = [
    { key: "rs_new", label: "Not yet sent", count: `${notSent.length} requests`, sub: "Drafted or waiting for approval; not yet sent.", value: notSent.length, rows: notSent.map((x) => reqRow(x, x.r.status === "DRAFT" ? "Draft · waiting for approval" : x.r.status === "SUBMISSION_FAILED" ? "Send failed" : "Waiting for a supervisor")) },
    { key: "rs_wait", label: "Waiting for Reply", count: `${waiting.length} requests`, sub: "Sent, acknowledged or not, and nothing back yet.", value: waiting.length, rows: waiting.sort((a, b) => (a.r.submittedAt?.getTime() ?? 0) - (b.r.submittedAt?.getTime() ?? 0)).map((x) => reqRow(x, `${days(x.r.submittedAt)} days`)) },
    { key: "rs_rem", label: "Reminder draft", count: `${due.length} requests`, sub: "Past the usual turnaround with no reply. A reminder is drafted for each, for its officer to check and send; nothing is sent by itself.", value: due.length, rows: due.map((x) => reqRow(x, x.c.requests.some((p) => p.parentRequestId === x.r.id && NOT_SENT.includes(p.status)) ? `${days(x.r.submittedAt)} days · reminder drafted` : `${days(x.r.submittedAt)} days · reminder being drafted`)) },
    { key: "rs_ans", label: "Answered", count: `${answered.length} requests`, sub: "A reply came back and was matched to the request.", value: answered.length, rows: answered.sort((a, b) => b.r.updatedAt.getTime() - a.r.updatedAt.getTime()).map((x) => reqRow(x, x.r.status === "PARTIAL_RESPONSE" ? "Partly answered" : x.r.status === "REJECTED" ? "Refused" : "Answered")) },
  ];

  // Complaints for the trends: this month as usual, or those received in the chosen period.
  const rangeComplaints = tb ? await db.complaint.findMany({ where: { receivedAt: { gte: tb.start, lt: tb.end } }, include: { case: { include: { assignments: true, holds: true } } }, orderBy: { lossAmountMinor: "desc" } }) : null;
  const thisMonth = rangeComplaints ?? inMonth(0);
  // Grouped by the station's investigation verticals (MO.docx).
  const kindGroups: DrillGroup[] = [...MO_VERTICALS.map((v) => ({ key: v.key as FraudType, label: v.label, sub: `Covers ${v.covers.charAt(0).toLowerCase()}${v.covers.slice(1)}.` })), { key: "NONE" as FraudType, label: "Not classified", sub: "The complaint does not show which vertical it belongs to." }]
    .map((k) => {
      const list = thisMonth.filter((x) => complaintVertical(x) === k.key);
      return { key: `kf_${k.key.toLowerCase()}`, label: k.label, count: `${list.length} complaints`, sub: k.sub, value: list.length, rows: list.map(complaintRow) };
    })
    .filter((g) => g.value > 0)
    .sort((a, b) => b.value - a.value);

  const yearStart = new Date(Date.UTC(Number(anchorMonth.slice(0, 4)), 0, 1) - 330 * 60 * 1000);
  const thisYear = tb ? cases.filter((c) => c.registeredAt && c.registeredAt >= tb.start && c.registeredAt < tb.end) : cases.filter((c) => c.registeredAt && c.registeredAt >= yearStart);
  const caseRow = (c: (typeof cases)[number], d: string): DrillRow => {
    const open = canOpenCase(c);
    return { a: `${c.firNumber}/${c.firYear}`, sub: c.fraudCategory ?? c.title, b: open ? (c.claims[0]?.victim.label ?? "—") + (c.claims.length > 1 ? ` +${c.claims.length - 1}` : "") : "—", c: c.registeredAt ? formatDateIST(c.registeredAt) : "—", d, href: open ? `/cases/${c.id}` : null, cs: c.registeredAt?.toISOString() ?? null };
  };
  const pillOf = (id: string) => rows.find((r) => r.id === id)?.pill.text ?? closed.find((r) => r.id === id)?.outcome.text ?? "";
  const stOpen = thisYear.filter((c) => c.status === "OPEN");
  const stInv = stOpen.filter((c) => c.requests.some((r) => !NOT_SENT.includes(r.status)));
  const stCs = thisYear.filter((c) => c.chargeSheetedAt);
  const stClosed = thisYear.filter((c) => c.status === "CLOSED");
  const stageGroups: DrillGroup[] = [
    { key: "st_open", label: "Open", count: `${stOpen.length} cases`, sub: "Every FIR of this year that is not closed.", value: stOpen.length, rows: stOpen.map((c) => caseRow(c, pillOf(c.id))) },
    { key: "st_inv", label: "Under investigation", count: `${stInv.length} cases`, sub: "Open cases with at least one request sent; the rest are awaiting their first step.", value: stInv.length, rows: stInv.map((c) => caseRow(c, pillOf(c.id))) },
    { key: "st_cs", label: "Charge sheet filed", count: `${stCs.length} cases`, sub: "Investigation complete and the charge sheet is with the court.", value: stCs.length, rows: stCs.map((c) => caseRow(c, `Charge sheet filed ${formatDayMonthIST(c.chargeSheetedAt!)}`)) },
    { key: "st_closed", label: "Closed", count: `${stClosed.length} cases`, sub: "Closed this year, with the outcome recorded.", value: stClosed.length, rows: stClosed.map((c) => caseRow(c, pillOf(c.id))) },
  ];

  // Money lost over the chosen period: by day for up to two months, else by month.
  const buckets: { back: number; name: string; list: typeof complaints; start: Date; end: Date }[] = (() => {
    if (!tb || !rangeComplaints) return months;
    const istDay = (d: Date) => utcToIstDateInput(d);
    if (tb.days <= 62) {
      return Array.from({ length: tb.days }, (_, i) => {
        const dayStart = new Date(tb.start.getTime() + i * DAY);
        const key = istDay(dayStart);
        return { back: tb.days - 1 - i, name: formatDayMonthIST(dayStart), list: rangeComplaints.filter((x) => istDay(x.receivedAt) === key), start: dayStart, end: new Date(dayStart.getTime() + DAY) };
      });
    }
    const first = istDay(tb.start).slice(0, 7);
    const last = istDay(new Date(tb.end.getTime() - 1)).slice(0, 7);
    const out: { back: number; name: string; list: typeof complaints; start: Date; end: Date }[] = [];
    let [y, m] = first.split("-").map(Number) as [number, number];
    const MON3 = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    for (let guard = 0; guard < 120; guard++) {
      const key = `${y}-${String(m).padStart(2, "0")}`;
      out.push({ back: 0, name: `${MON3[m - 1]} ${y}`, list: rangeComplaints.filter((x) => istDay(x.receivedAt).slice(0, 7) === key), start: new Date(Math.max(tb.start.getTime(), Date.UTC(y, m - 1, 1) - 330 * 60 * 1000)), end: new Date(Math.min(tb.end.getTime(), Date.UTC(y, m, 1) - 330 * 60 * 1000)) });
      if (key >= last) break;
      m++;
      if (m > 12) {
        m = 1;
        y++;
      }
    }
    return out.map((b, i) => ({ ...b, back: out.length - 1 - i }));
  })();
  const monthGroups: DrillGroup[] = buckets.map((m) => {
    const lost = sum(m.list);
    const label = tb ? m.name : m.back === 0 ? `${m.name} so far` : m.name;
    return {
      key: `mo_${m.back}`,
      label,
      count: `${formatLakh(lost)} lost`,
      sub: `${m.list.length} ${m.list.length === 1 ? "complaint" : "complaints and cases"} received ${tb ? `on or in ${m.name}` : `in ${m.back === 0 ? `${m.name}, so far` : m.name}`}.`,
      value: Number(lost / 100n),
      rows: m.list.map((x) => {
        const r = complaintRow(x);
        const heldHere = (x.case?.holds ?? []).filter((h) => h.status === "CONFIRMED_HELD").reduce((s, h) => s + (h.confirmedAmountMinor ?? 0n), 0n) + x.heldAmountMinor;
        return { ...r, c: r.d, d: formatInr(heldHere), cs: Number(x.lossAmountMinor), ds: Number(heldHere) };
      }),
    };
  });

  // Put on hold (POH) in each period: amounts a bank confirmed as held then, and holds placed through 1930 on
  // complaints that have no FIR yet. And the FIRs registered in each period. Drawn as lines beside the money lost.
  const firstStart = buckets[0]?.start ?? monthStart(5);
  const holdEvents = await db.holdEvent.findMany({
    where: { type: "AMOUNT_CONFIRMED", at: { gte: firstStart }, case: { stationId: user.stationId }, amountMinor: { gt: 0n } },
    include: { hold: { include: { account: true } }, case: { include: { assignments: true } } },
    orderBy: { at: "asc" },
  });
  const pohGroups: DrillGroup[] = buckets.map((m) => {
    const ev = holdEvents.filter((e) => e.at >= m.start && e.at < m.end);
    const early = m.list.filter((x) => !x.caseId && x.heldAmountMinor > 0n);
    const total = ev.reduce((s, e) => s + (e.amountMinor ?? 0n), 0n) + early.reduce((s, x) => s + x.heldAmountMinor, 0n);
    const label = tb ? m.name : m.back === 0 ? `${m.name} so far` : m.name;
    return {
      key: `poh_${m.back}`,
      label,
      count: `${formatLakh(total)} put on hold`,
      sub: `Amounts banks confirmed as held ${tb ? `on or in ${m.name}` : `in ${m.back === 0 ? `${m.name}, so far` : m.name}`}, with holds placed through 1930 before an FIR.`,
      value: Number(total / 100n),
      rows: [
        ...ev.map((e) => {
          const open = canReadCase(user, { stationId: e.case.stationId, assignedUserIds: e.case.assignments.map((a) => a.userId) });
          return { a: `${e.case.firNumber}/${e.case.firYear}`, sub: e.hold.account.label.replace(/\s*\(synthetic\)$/, ""), b: e.hold.bankReference ?? "Bank hold", c: formatDateIST(e.at), d: formatInr(e.amountMinor ?? 0n), href: open ? `/cases/${e.caseId}/recovery` : null, cs: e.at.toISOString(), ds: Number(e.amountMinor ?? 0n) };
        }),
        ...early.map((x) => ({ a: x.ackNumber, sub: "NCRP · held through 1930, no FIR yet", b: "1930 helpline", c: formatDateIST(x.receivedAt), d: formatInr(x.heldAmountMinor), href: null, cs: x.receivedAt.toISOString(), ds: Number(x.heldAmountMinor) })),
      ],
    };
  });
  const firGroups: DrillGroup[] = buckets.map((m) => {
    const list = cases.filter((c) => c.registeredAt && c.registeredAt >= m.start && c.registeredAt < m.end);
    const label = tb ? m.name : m.back === 0 ? `${m.name} so far` : m.name;
    return {
      key: `fir_${m.back}`,
      label,
      count: `${list.length} ${list.length === 1 ? "FIR" : "FIRs"}`,
      sub: `FIRs registered at the station ${tb ? `on or in ${m.name}` : `in ${m.back === 0 ? `${m.name}, so far` : m.name}`}.`,
      value: list.length,
      rows: list.map((c) => caseRow(c, pillOf(c.id))),
    };
  });

  const myOpen = rows.filter((r) => r.mine);
  const actionCases = new Set(actions.map((a) => a.caseId)).size;
  // A supervisor also has actions on other officers' cases (approvals, a split to confirm): counted apart, so "your
  // cases" always means the cases in My cases.
  const mineIds = new Set(myOpen.map((r) => r.id));
  const ownActions = actions.filter((a) => mineIds.has(a.caseId));
  const otherActions = actions.filter((a) => !mineIds.has(a.caseId));
  const hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hour12: false, timeZone: "Asia/Kolkata" }).format(at));
  return {
    viewer: { name: `${shortRank(user.rank)} ${user.displayName}`, isSupervisor: user.role === "SUPERVISOR", partOfDay: hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening" },
    station: { name: user.stationName, district: getAppConfig().station.district },
    counts: {
      mine: myOpen.length,
      station: rows.length,
      action: actions.length,
      actionCases,
      /** The actions in the viewer's own cases (My cases), and in how many of them. */
      own: { actions: ownActions.length, cases: new Set(ownActions.map((a) => a.caseId)).size },
      /** The actions on other officers' cases (a supervisor's approvals and decisions), and in how many. */
      other: { actions: otherActions.length, cases: new Set(otherActions.map((a) => a.caseId)).size },
      closed: closed.length,
    },
    kpi: {
      needAction: actions.length,
      /** The viewer's own FIRs (as IO): open now, and closed. */
      firs: { open: myFirs.filter((c) => c.status === "OPEN").length, closed: myFirs.filter((c) => c.status === "CLOSED").length },
      lost6: { label: formatLakh(lost6), cases: complaints.length, from: monthName(5), to: monthName(0) },
      held: { label: formatLakh(heldTotal), accounts: openHolds.length },
      /** The money card for a chosen period (null: the usual last 6 months, and what is held now). */
      range: kpiRange,
    },
    rows,
    actions,
    closed: closed.sort((a, b) => (b.closedAt ?? "").localeCompare(a.closedAt ?? "")),
    trends: {
      /** The period the trends are for (null: the usual one for each chart). */
      range: tb ? opts.trends! : null,
      requests: { total: allReq.length, groups: requestGroups },
      kinds: { total: thisMonth.length, monthName: monthName(0), groups: kindGroups },
      stages: { groups: stageGroups },
      months: {
        lost6: formatLakh(tb ? sum(rangeComplaints ?? []) : lost6),
        held: formatLakh(heldTotal),
        from: monthName(5),
        byDay: !!tb && tb.days <= 62,
        groups: monthGroups,
        /** Put on hold in each period, and FIRs registered in it (the same periods as groups). */
        poh: pohGroups,
        firs: firGroups,
        pohTotal: formatLakh(holdEvents.filter((e) => !tb || (e.at >= tb.start && e.at < tb.end)).reduce((s, e) => s + (e.amountMinor ?? 0n), 0n) + buckets.flatMap((m) => m.list).filter((x) => !x.caseId && x.heldAmountMinor > 0n).reduce((s, x) => s + x.heldAmountMinor, 0n)),
        firTotal: firGroups.reduce((s, g) => s + g.value, 0),
      },
    },
  };
}

export type DashboardData = Awaited<ReturnType<typeof getDashboard>>;
