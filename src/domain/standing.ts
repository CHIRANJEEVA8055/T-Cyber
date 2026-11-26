import { formatInr } from "./money";
import { formatDayMonthIST } from "./time";

/**
 * Where a case stands, in one pill, and what it needs from its officer, as rows of the dashboard's "Need action"
 * list. Pure: the service gathers the facts; the order below is the order of urgency.
 */
export type Tone = "wait" | "gap" | "info" | "ok" | "neutral";
export type StandingStatus = "action" | "waiting" | "hold" | "done";

export interface StandingFacts {
  /** Drafts the officer can approve and send (prepared by the assistant), in request order. */
  drafts: { ref: string | null; short: string }[];
  /** Requests waiting for a supervisor's approval. */
  awaitingSupervisor: number;
  failedSends: { ref: string | null; org: string }[];
  decisions: { kind: "ALLOC" | "RESTORE"; title: string; why: string }[];
  repliesToMatch: { org: string; firCount: number }[];
  repliesToCheck: { org: string; answers: string | null }[];
  holdsExpiring: { amountMinor: bigint; org: string; expiresAt: Date }[];
  /** Requests past their follow-up date, or answered in part with items still missing. */
  remindersDue: { ref: string | null; org: string; what: string; days: number; drafted: boolean; missing: string | null }[];
  waitingOn: { org: string }[];
  /** Calls from the complainant since the officer last called back. */
  callbacks: { count: number; lastChangeAt: Date | null } | null;
  refunds: { creditedMinor: bigint; pipelineMinor: bigint };
  /** Short titles of actions blocked until a draft goes out (e.g. CCTV). */
  blockedTitles: string[];
}

export interface StandingAction {
  kind: "SEND_AGAIN" | "APPROVE" | "MATCH" | "CHECK" | "HOLD" | "REMIND" | "DECIDE" | "CALL";
  what: string;
  why: string;
  when: { text: string; tone: Tone };
}

const DAY = 24 * 60 * 60 * 1000;
const seq = (ref: string | null) => ref ?? "the request";
const times = (n: number) => (n === 1 ? "once" : n === 2 ? "twice" : `${n} times`);

function daysUntil(at: Date, now: Date) {
  const istDay = (d: Date) => Math.floor((d.getTime() + 330 * 60 * 1000) / DAY);
  return istDay(at) - istDay(now);
}

function inDays(n: number) {
  return n <= 0 ? "today" : n === 1 ? "tomorrow" : `in ${n} days`;
}

export function caseStanding(f: StandingFacts, now: Date): { pill: { text: string; tone: Tone }; status: StandingStatus; actions: StandingAction[] } {
  const actions: StandingAction[] = [];
  // Each line says, in plain words, what to do, about what, and why.
  for (const s of f.failedSends) actions.push({ kind: "SEND_AGAIN", what: `Send ${seq(s.ref)} to ${s.org} again`, why: "The last try did not go through, so it has not reached them yet.", when: { text: "Today", tone: "gap" } });
  if (f.drafts.length) {
    const blocked = f.blockedTitles.length ? ` ${f.blockedTitles.join(", ")} can only start after this.` : "";
    actions.push(
      f.drafts.length === 1
        ? { kind: "APPROVE", what: `Check and approve ${seq(f.drafts[0]!.ref)}: ${f.drafts[0]!.short}`, why: `It is written and waiting for you; nothing goes out until you approve it.${blocked}`, when: { text: "Today", tone: "wait" } }
        : { kind: "APPROVE", what: `Check and approve ${f.drafts.length} requests`, why: `${f.drafts.map((d) => `${seq(d.ref)} ${d.short}`).join(", ")}. They are written and waiting for you.${blocked}`, when: { text: "Today", tone: "wait" } },
    );
  }
  for (const r of f.repliesToMatch) actions.push({ kind: "MATCH", what: `Say which request a reply from ${r.org} answers`, why: r.firCount > 1 ? `It mentions ${r.firCount} FIRs, so it cannot be filed on its own.` : "It does not say clearly which request it is for.", when: { text: "Reply", tone: "info" } });
  for (const r of f.repliesToCheck) actions.push({ kind: "CHECK", what: `Read and confirm the reply from ${r.org}`, why: `${r.answers ? `${r.answers}. ` : ""}Nothing from it is added to the case until you confirm it.`, when: { text: "Reply", tone: "info" } });
  for (const h of f.holdsExpiring) {
    const d = daysUntil(h.expiresAt, now);
    actions.push({ kind: "HOLD", what: `The freeze on ${formatInr(h.amountMinor)} at ${h.org} ends ${inDays(d)}`, why: "Ask the court or the bank to extend it, or start returning the money to the victim.", when: { text: d <= 0 ? "Today" : d === 1 ? "1 day" : `${d} days`, tone: "gap" } });
  }
  for (const r of f.remindersDue) {
    const next = r.drafted ? "A reminder is written for you: check and send it." : "Send them a reminder.";
    actions.push(
      r.missing
        ? { kind: "REMIND", what: `Ask ${r.org} again for the ${r.missing.replace(/^the\s+/i, "")}`, why: `They answered ${seq(r.ref)} but left this out. ${next}`, when: { text: "Remind", tone: "wait" } }
        : { kind: "REMIND", what: `${r.org} has not answered ${seq(r.ref)} for ${r.days} days`, why: `It asked for the ${r.what}. ${next}`, when: { text: "Remind", tone: "wait" } },
    );
  }
  for (const d of f.decisions) actions.push({ kind: "DECIDE", what: d.title, why: d.why, when: { text: "Decide", tone: "wait" } });
  if (f.callbacks && f.callbacks.count > 0) {
    actions.push({ kind: "CALL", what: "Call the complainant back", why: `They called ${times(f.callbacks.count)} asking for an update${f.callbacks.lastChangeAt ? `; the case last changed on ${formatDayMonthIST(f.callbacks.lastChangeAt)}` : ""}.`, when: { text: "Call", tone: "neutral" } });
  }

  const approvals = f.drafts.length + f.awaitingSupervisor;
  const soonest = f.holdsExpiring.map((h) => daysUntil(h.expiresAt, now)).sort((a, b) => a - b)[0];
  let pill: { text: string; tone: Tone };
  let status: StandingStatus;
  if (f.failedSends.length) [pill, status] = [{ text: "Send failed", tone: "gap" }, "action"];
  else if (approvals) [pill, status] = [{ text: approvals === 1 ? "1 approval waiting" : `${approvals} approvals waiting`, tone: "wait" }, "action"];
  else if (f.decisions.length) [pill, status] = [{ text: "Your decision", tone: "wait" }, "action"];
  else if (soonest !== undefined && soonest <= 3) [pill, status] = [{ text: `Hold expires ${inDays(soonest)}`, tone: "gap" }, "hold"];
  else if (f.repliesToMatch.length || f.repliesToCheck.length) [pill, status] = [{ text: "Reply to check", tone: "info" }, "action"];
  else if (f.remindersDue.length) [pill, status] = [{ text: "Reminder due", tone: "wait" }, "action"];
  else if (f.refunds.creditedMinor > 0n) [pill, status] = [{ text: `${formatInr(f.refunds.creditedMinor)} returned`, tone: "ok" }, "done"];
  else if (f.refunds.pipelineMinor > 0n) [pill, status] = [{ text: "Restoration filed", tone: "ok" }, "done"];
  else if (f.waitingOn.length) {
    const orgs = [...new Set(f.waitingOn.map((w) => w.org))];
    pill = { text: f.waitingOn.length === 1 || orgs.length === 1 ? `Waiting on ${orgs[0]}` : `Waiting on ${f.waitingOn.length} replies`, tone: "neutral" };
    status = "waiting";
  } else [pill, status] = [{ text: "No open requests", tone: "neutral" }, "waiting"];
  return { pill, status, actions };
}
