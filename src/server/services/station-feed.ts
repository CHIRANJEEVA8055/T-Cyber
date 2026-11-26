import { formatDateIST, formatDayMonthIST } from "@/domain/time";
import { formatInr } from "@/domain/money";
import { AUTO_MATCH_SCORE } from "@/domain/reply-match";
import type { Db } from "../db";
import type { SessionUser } from "../auth/session";
import { assertCaseWorker, caseAccessWhere } from "../auth/access";
import { now as clockNow } from "../clock";
import { rankRequestsFor } from "./inbox";
import { calendarDays, shortOrg } from "./dashboard";
import { shownId } from "@/domain/identifiers";
import { responseRefsFor } from "./correspondence";

/**
 * The replies inbox and the notifications, both derived from records of the cases the viewer may open. Reading a
 * notification is the only thing stored about them (NotificationRead).
 */

const DAY = 24 * 60 * 60 * 1000;

export interface ReplyItem {
  id: string;
  kind: "REPLY" | "UNREAD";
  from: string;
  about: string;
  identifier: string | null;
  receivedAt: string;
  match: number | null;
  needs: { text: string; tone: "wait" | "info" | "ok" | "neutral" | "gap" };
  href: string;
}

export interface ReplyGroup {
  caseId: string;
  fir: string;
  kind: string;
  items: ReplyItem[];
}

const short = (value: string | null | undefined) => (value ? shownId(value) : null);

export async function getRepliesInbox(db: Db, user: SessionUser, at = clockNow()) {
  assertCaseWorker(user);
  const cases = await db.case.findMany({ where: { ...caseAccessWhere(user), status: "OPEN" }, select: { id: true, firNumber: true, firYear: true, fraudCategory: true, title: true } });
  const ids = cases.map((c) => c.id);
  const responses = await db.response.findMany({
    where: { caseId: { in: ids }, reviewStatus: { not: "APPLIED" } },
    include: { request: { include: { recipient: true, items: true, subjects: { include: { entity: true } } } }, findings: { select: { requestItemId: true } } },
    orderBy: { receivedAt: "desc" },
  });
  const resRefs = await responseRefsFor(db, responses.filter((r) => r.matchStatus === "MATCHED"));
  const groups = new Map<string, ReplyGroup>();
  const group = (caseId: string) => {
    if (!groups.has(caseId)) {
      const c = cases.find((x) => x.id === caseId)!;
      groups.set(caseId, { caseId, fir: `${c.firNumber}/${c.firYear}`, kind: c.fraudCategory ?? c.title, items: [] });
    }
    return groups.get(caseId)!;
  };
  for (const r of responses) {
    const req = r.request;
    const items = req?.items.length ?? 0;
    const answered = new Set(r.findings.map((f) => f.requestItemId).filter(Boolean)).size;
    const needsMatch = r.matchStatus !== "MATCHED";
    group(r.caseId!).items.push({
      id: r.id,
      kind: "REPLY",
      from: req ? `${shortOrg(req.recipient.organisation)}${req.recipient.organisationType === "BANK" ? " nodal officer" : ""}` : r.fromAddress,
      about: needsMatch ? (r.firCount && r.firCount > 1 ? `${r.subject} · one message, ${r.firCount} FIRs` : r.subject) : `${resRefs.get(r.id) ? `${resRefs.get(r.id)}, reply to` : "Reply to"} ${req?.reference ?? "a request"}${req ? ` · ${req.items.map((i) => i.label.split(/[,(]/)[0]!.toLowerCase()).slice(0, 3).join(", ")}` : ""}`,
      identifier: req?.subjects[0] ? `${req.subjects[0].entity.kind === "PHONE" ? "Mobile" : req.subjects[0].entity.kind === "UPI_ID" ? "VPA" : "Account"} ${short(req.subjects[0].entity.value)}` : null,
      receivedAt: r.receivedAt.toISOString(),
      match: r.matchScore,
      needs: needsMatch ? { text: "Pick the request", tone: "wait" } : items ? { text: `Check it · answers ${answered} of ${items}`, tone: "info" } : { text: "Check it", tone: "info" },
      href: `/cases/${r.caseId}/requests?reply=${r.id}`,
    });
  }
  // Unread mailbox messages that clearly answer a request in one of the viewer's cases.
  const unread = await db.inboxMessage.findMany({ where: { status: "UNREAD" }, orderBy: { receivedAt: "desc" } });
  for (const m of unread) {
    let best: { caseId: string; score: number; ref: string; org: string; subject: string | null } | null = null;
    for (const c of cases) {
      const ranked = await rankRequestsFor(db, c.id, m);
      const top = ranked[0];
      if (top && top.score >= AUTO_MATCH_SCORE && (!best || top.score > best.score)) {
        best = { caseId: c.id, score: top.score, ref: top.request.reference, org: shortOrg(top.request.recipient.organisation), subject: null };
      }
    }
    if (!best) continue;
    const ack = /acknowledg|under process/i.test(`${m.subject} ${m.bodyText}`);
    const files = (JSON.parse(m.attachmentsJson) as unknown[]).length;
    group(best.caseId).items.push({
      id: m.id,
      kind: "UNREAD",
      from: m.fromAddress.startsWith("dd.") ? `${best.org}, via DD` : best.org,
      about: `${ack ? "Acknowledgement of" : "Reply to"} ${best.ref}${files ? ` · ${files} attachment${files === 1 ? "" : "s"}` : ""}`,
      identifier: null,
      receivedAt: m.receivedAt.toISOString(),
      match: best.score,
      needs: { text: "Read it in", tone: "info" },
      href: `/cases/${best.caseId}/requests?import=${m.id}`,
    });
  }
  const out = [...groups.values()].map((g) => ({ ...g, items: g.items.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)) })).sort((a, b) => (b.items[0]?.receivedAt ?? "").localeCompare(a.items[0]?.receivedAt ?? ""));
  const all = out.flatMap((g) => g.items);
  const since = new Date(at.getTime() - 18 * 3600 * 1000);
  return {
    groups: out,
    total: all.length,
    needYou: all.filter((i) => i.needs.text === "Pick the request" || i.kind === "UNREAD").length,
    overnight: all.filter((i) => new Date(i.receivedAt) >= since).length,
  };
}

export type RepliesInbox = Awaited<ReturnType<typeof getRepliesInbox>>;

export interface Notification {
  key: string;
  title: string;
  body: string;
  at: string;
  href: string;
  tone: "gap" | "wait" | "info" | "ok";
  read: boolean;
}

/** What happened to the viewer's cases without them: sends that failed, holds about to lapse, replies needing a decision. */
export async function getNotifications(db: Db, user: SessionUser, at = clockNow()) {
  const cases = await db.case.findMany({
    where: { ...caseAccessWhere(user), status: "OPEN" },
    include: {
      holds: { include: { account: true } },
      requests: { include: { recipient: true, submissions: { orderBy: { attemptedAt: "desc" }, take: 1 }, subjects: { include: { entity: true } } } },
      responses: { where: { reviewStatus: { not: "APPLIED" } }, include: { request: { include: { recipient: true, items: true } } } },
    },
  });
  const list: Omit<Notification, "read">[] = [];
  for (const c of cases) {
    const fir = `FIR ${c.firNumber}/${c.firYear}`;
    for (const r of c.requests.filter((x) => x.status === "SUBMISSION_FAILED")) {
      const s = r.submissions[0];
      list.push({ key: `sendfail:${s?.id ?? r.id}`, title: `The message to ${shortOrg(r.recipient.organisation)} could not be sent`, body: `${r.reference} in ${fir}. ${s?.errorMessage ?? "The simulated channel refused it."} Check the address and send it again.`, at: (s?.attemptedAt ?? r.updatedAt).toISOString(), href: `/cases/${c.id}/next-actions`, tone: "gap" });
    }
    for (const h of c.holds.filter((x) => x.status === "CONFIRMED_HELD" && x.expiresAt && x.expiresAt.getTime() - at.getTime() < 7 * DAY && (x.confirmedAmountMinor ?? 0n) > 0n)) {
      const days = Math.max(0, calendarDays(at, h.expiresAt!));
      list.push({ key: `holdexp:${h.id}:${h.expiresAt!.toISOString().slice(0, 10)}`, title: `Hold on Account ${short(h.account.value)} ends ${days <= 1 ? (days === 0 ? "today" : "tomorrow") : `in ${days} days`}`, body: `${fir}. ${formatInr(h.confirmedAmountMinor!)} is held until ${formatDateIST(h.expiresAt!)}. File for an extension or restoration before then, or the money is released.`, at: (h.updatedAt ?? h.createdAt).toISOString(), href: `/cases/${c.id}/recovery`, tone: "gap" });
    }
    for (const r of c.responses) {
      if (r.matchStatus !== "MATCHED") {
        list.push({ key: `match:${r.id}`, title: r.firCount && r.firCount > 1 ? `A reply from ${shortOrg(r.request?.recipient.organisation ?? r.fromAddress)} covers ${r.firCount} FIRs` : `A reply needs you to pick its request`, body: `Pick which request it answers in ${fir}${r.firCount && r.firCount > 1 ? "; rows for the other FIRs are not read in" : ""}.`, at: r.receivedAt.toISOString(), href: `/cases/${c.id}/requests?reply=${r.id}`, tone: "wait" });
      } else {
        const items = r.request?.items.length ?? 0;
        list.push({ key: `matched:${r.id}`, title: `${shortOrg(r.request?.recipient.organisation ?? r.fromAddress)}'s reply was matched to ${r.request?.reference ?? "its request"}`, body: `In ${fir}.${items ? ` It is waiting for your check.` : ""}`, at: r.receivedAt.toISOString(), href: `/cases/${c.id}/requests?reply=${r.id}`, tone: "info" });
      }
    }
    for (const r of c.requests.filter((x) => x.preservedUntil)) {
      const subject = r.subjects[0]?.entity.label ?? "The profile";
      list.push({ key: `preserved:${r.id}`, title: `${subject} is preserved`, body: `${shortOrg(r.recipient.organisation)} confirmed preservation until ${formatDateIST(r.preservedUntil!)} for ${fir}. Disclosure is a separate request.`, at: r.updatedAt.toISOString(), href: `/cases/${c.id}/requests`, tone: "ok" });
    }
  }
  const reads = new Set((await db.notificationRead.findMany({ where: { userId: user.id } })).map((r) => r.key));
  const items: Notification[] = list.map((n) => ({ ...n, read: reads.has(n.key) })).sort((a, b) => b.at.localeCompare(a.at));
  return { items, unread: items.filter((n) => !n.read).length };
}

export type Notifications = Awaited<ReturnType<typeof getNotifications>>;

export async function markNotificationsRead(db: Db, user: SessionUser, keys: string[]) {
  const valid = new Set((await getNotifications(db, user)).items.map((n) => n.key));
  const own = keys.filter((k) => valid.has(k));
  for (const key of own) await db.notificationRead.upsert({ where: { userId_key: { userId: user.id, key } }, create: { userId: user.id, key }, update: {} });
  return own.length;
}

export function relativeDay(iso: string, at = clockNow()): string {
  const d = new Date(iso);
  const day = (x: Date) => Math.floor((x.getTime() + 330 * 60 * 1000) / DAY);
  const diff = day(at) - day(d);
  const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" }).format(d);
  if (diff === 0) return `Today ${time}`;
  if (diff === 1) return `Yesterday ${time}`;
  return `${formatDayMonthIST(d)} ${time}`;
}
