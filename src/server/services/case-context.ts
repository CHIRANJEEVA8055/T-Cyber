import type { Db } from "../db";
import type { SessionUser } from "../auth/session";
import { loadCaseForUser } from "../auth/access";
import { formatInr } from "@/domain/money";
import { formatDateIST, formatDayMonthIST } from "@/domain/time";
import { isVictimOwned } from "@/domain/providers";
import { now } from "../clock";
import { caseReference } from "./cases";
import { parseAttributes } from "./facts";
import { identifierName } from "./people-view";
import { formatSections } from "@/domain/legal-sections";

/**
 * Everything a case holds, in one place: the case as the FIR states it, the money trail level by level, who is on
 * which side, every mail sent and what came back to it (and what is still missing), replies not yet linked, the files
 * added, and what is pending. Built fresh from the records each time, so it is never out of date. The same text is
 * what the local model is given when it reads a reply or answers a question about the case.
 */

const UNSENT = ["DRAFT", "AWAITING_APPROVAL", "APPROVED", "SUBMISSION_FAILED"];
const AWAITING = ["SUBMITTED", "ACKNOWLEDGED", "PARTIAL_RESPONSE"];
const STATUS: Record<string, string> = { DRAFT: "draft, not sent", AWAITING_APPROVAL: "waiting for approval", APPROVED: "approved, not sent", SUBMISSION_FAILED: "send failed", SUBMITTED: "sent, no reply yet", ACKNOWLEDGED: "acknowledged, details awaited", PARTIAL_RESPONSE: "partly answered", COMPLETE_RESPONSE: "answered", REJECTED: "refused" };
const ITEM_STATE: Record<string, string> = { PENDING: "still awaited", RECEIVED: "received", PARTIAL: "partly received", NOT_PROVIDED: "not provided" };
const day = (d: Date) => formatDayMonthIST(d);

export interface ContextMail {
  id: string;
  label: string;
  to: string;
  subject: string;
  status: string;
  statusText: string;
  sent: string | null;
  followUp: string | null;
  overdue: boolean;
  asks: { label: string; state: string }[];
  body: string;
  replies: { id: string; from: string; received: string; kind: string; reviewed: boolean; findings: string[]; files: number }[];
  reminders: string[];
  /** Why it was sent: the next action it answers, when the rules proposed it. */
  why: string | null;
}

export interface CaseContextView {
  caseId: string;
  ref: string;
  asOf: string;
  facts: { label: string; value: string }[];
  trail: { level: number; rows: { name: string; got: string; from: string; onward: string; hold: string | null }[] }[];
  sides: { accused: string[]; victim: string[]; other: string[] };
  mails: ContextMail[];
  unlinked: { from: string; received: string; subject: string; where: string }[];
  pending: string[];
  files: { title: string; what: string; when: string }[];
  next: string[];
  /** The whole context as plain text (what the local model is given). */
  text: string;
}

export async function getCaseContext(db: Db, user: SessionUser, caseId: string): Promise<CaseContextView> {
  const kase = await loadCaseForUser(db, user, caseId, "read");
  const at = now();
  const [entities, roles, claims, txns, holds, requests, responses, inbox, evidence, readings, tasks, io] = await Promise.all([
    db.entity.findMany({ where: { caseId }, orderBy: { discoveredAt: "asc" } }),
    db.partyRole.findMany({ where: { caseId } }),
    db.victimClaim.findMany({ where: { caseId, status: "ACTIVE" } }),
    db.transaction.findMany({ where: { caseId }, orderBy: { occurredAt: "asc" } }),
    db.hold.findMany({ where: { caseId } }),
    db.request.findMany({ where: { caseId, status: { not: "DISCARDED" } }, include: { recipient: true, items: { orderBy: { sortOrder: "asc" } }, versions: { orderBy: { versionNo: "desc" }, take: 1 }, submissions: { where: { outcome: "SUCCEEDED" }, orderBy: { attemptedAt: "desc" }, take: 1 } }, orderBy: [{ createdAt: "asc" }] }),
    db.response.findMany({ where: { caseId }, include: { findings: { select: { summary: true, decision: true }, orderBy: { sortOrder: "asc" } }, attachments: { select: { id: true } } }, orderBy: { receivedAt: "asc" } }),
    db.inboxMessage.findMany({ where: { status: "UNREAD", suggestedRequestId: { not: null } }, select: { fromAddress: true, subject: true, receivedAt: true, suggestedRequestId: true } }),
    db.evidenceItem.findMany({ where: { caseId, derivation: { in: ["ORIGINAL", "PREPARED"] } }, orderBy: { receivedAt: "asc" }, select: { title: true, category: true, receivedAt: true, fileName: true } }),
    db.fileReading.findMany({ where: { caseId }, select: { status: true, kind: true, evidence: { select: { title: true } } } }),
    db.task.findMany({ where: { caseId, status: { in: ["OPEN", "DRAFT_PREPARED", "BLOCKED"] } }, orderBy: { createdAt: "asc" }, select: { id: true, title: true, status: true, requestId: true, priority: true } }),
    db.caseAssignment.findFirst({ where: { caseId, role: "INVESTIGATING_OFFICER" }, include: { user: { select: { displayName: true, rank: true } } } }),
  ]);
  const ref = caseReference(kase);
  const byId = new Map(entities.map((e) => [e.id, e]));
  const nameOf = (id: string) => {
    const e = byId.get(id);
    return e ? (["PERSON", "CASH"].includes(e.kind) ? e.label : identifierName(e)) : "an unknown account";
  };
  const complainant = entities.find((e) => roles.some((r) => r.entityId === e.id && r.role === "COMPLAINANT"));
  const loss = claims.reduce((s, c) => s + c.lossAmountMinor, 0n);

  const facts = [
    { label: "Case", value: `${ref}, ${kase.title}` },
    { label: "Registered", value: kase.registeredAt ? formatDateIST(kase.registeredAt) : "Not recorded" },
    { label: "Sections (as the FIR states them)", value: kase.legalSections ? formatSections(kase.legalSections) : "Not stated in the FIR" },
    { label: "Complainant", value: complainant?.label ?? "Not recorded" },
    { label: "Loss reported", value: loss > 0n ? formatInr(loss) : "Not recorded" },
    { label: "Offence period", value: kase.incidentStart ? `${formatDateIST(kase.incidentStart)}${kase.incidentEnd ? ` to ${formatDateIST(kase.incidentEnd)}` : ""}` : "Not recorded" },
    { label: "How it was done", value: kase.moSummary ?? "Not recorded" },
    { label: "Investigating officer", value: io ? `${io.user.rank} ${io.user.displayName}` : "Not assigned" },
  ];

  // The money trail, level by level (1 = paid by the victim directly).
  const victimOwn = (id: string) => {
    const e = byId.get(id);
    return !!e && isVictimOwned({ caseRole: e.caseRole, attributes: parseAttributes(e.attributesJson), belongsTo: e.belongsTo });
  };
  const levels = new Map<number, Map<string, { got: bigint; from: Set<string>; onward: bigint }>>();
  for (const t of txns) {
    if (victimOwn(t.toEntityId) || t.kind === "CASH_WITHDRAWAL") continue;
    const m = levels.get(t.layer) ?? new Map();
    const row = m.get(t.toEntityId) ?? { got: 0n, from: new Set<string>(), onward: 0n };
    row.got += t.amountMinor;
    row.from.add(nameOf(t.fromEntityId));
    m.set(t.toEntityId, row);
    levels.set(t.layer, m);
  }
  const trail = [...levels.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([level, m]) => ({
      level,
      rows: [...m.entries()].map(([id, r]) => {
        const out = txns.filter((t) => t.fromEntityId === id);
        const cash = out.filter((t) => t.kind === "CASH_WITHDRAWAL").reduce((s, t) => s + t.amountMinor, 0n);
        const moved = out.filter((t) => t.kind !== "CASH_WITHDRAWAL").reduce((s, t) => s + t.amountMinor, 0n);
        const h = holds.find((x) => x.accountEntityId === id);
        return {
          name: nameOf(id),
          got: formatInr(r.got),
          from: [...r.from].join(", "),
          onward: [moved ? `${formatInr(moved)} moved on` : null, cash ? `${formatInr(cash)} withdrawn in cash` : null].filter(Boolean).join(", ") || "nothing recorded as moved on",
          hold: h ? (h.status === "CONFIRMED_HELD" ? `${h.confirmedAmountMinor !== null ? formatInr(h.confirmedAmountMinor) : "an amount not yet confirmed"} held` : h.status === "REQUESTED" ? "freeze asked for" : h.status === "RESTRICTION_CONFIRMED" ? "restricted" : "released") : null,
        };
      }),
    }));

  const ids = entities.filter((e) => !["PERSON", "CASH"].includes(e.kind));
  const accusedRe = /beneficiar|fraudster|accused|suspect|mule|caller|scammer|impersonat|used by the|collection handle/i;
  const inTrail = new Set(txns.filter((t) => !victimOwn(t.toEntityId)).map((t) => t.toEntityId));
  const sides = {
    accused: ids.filter((e) => !victimOwn(e.id) && (e.belongsTo === "SUSPECT" || inTrail.has(e.id) || accusedRe.test(e.caseRole ?? ""))).map((e) => `${identifierName(e)}${e.caseRole ? `: ${e.caseRole}` : ""}`),
    victim: ids.filter((e) => victimOwn(e.id)).map((e) => `${identifierName(e)}${e.caseRole ? `: ${e.caseRole}` : ""}`),
    other: [] as string[],
  };
  sides.other = ids.filter((e) => !sides.accused.some((x) => x.startsWith(identifierName(e))) && !sides.victim.some((x) => x.startsWith(identifierName(e)))).map((e) => `${identifierName(e)}${e.caseRole ? `: ${e.caseRole}` : ""}`);

  // Every mail and what came back to it.
  const firsts = requests.filter((r) => !r.parentRequestId);
  const mails: ContextMail[] = firsts.map((r) => {
    const v = r.versions[0]!;
    const replies = responses.filter((x) => x.requestId === r.id);
    const kids = requests.filter((x) => x.parentRequestId === r.id);
    const sentTo = r.submissions[0]?.recipientAddress ?? r.gmailTo ?? (["UNADDRESSED", "MANUAL"].includes(r.recipient.organisationType) ? "" : r.recipient.address);
    const task = tasks.find((t) => t.requestId === r.id);
    return {
      id: r.id,
      label: r.reference,
      to: [r.recipient.organisationType === "TYPED" || r.recipient.organisationType === "MANUAL" ? null : r.recipient.organisation, sentTo].filter(Boolean).join(" · ") || "Addressee not yet known",
      subject: v.subject,
      status: r.status,
      statusText: STATUS[r.status] ?? r.status.toLowerCase(),
      sent: r.submittedAt ? `${day(r.submittedAt)}${r.submissions[0]?.adapter ? ` (${r.submissions[0].adapter.replace(/ to .*$/, "")})` : ""}` : null,
      followUp: r.followUpAt && AWAITING.includes(r.status) ? day(r.followUpAt) : null,
      overdue: !!r.followUpAt && AWAITING.includes(r.status) && r.followUpAt < at,
      asks: r.items.map((i) => ({ label: i.label, state: ITEM_STATE[i.status] ?? i.status.toLowerCase() })),
      body: v.body,
      replies: replies.map((x) => ({ id: x.id, from: x.fromAddress, received: day(x.receivedAt), kind: x.suggestedType ? x.suggestedType.toLowerCase().replace(/_/g, " ") : "reply", reviewed: x.reviewStatus === "APPLIED", findings: x.findings.filter((f) => f.decision !== "REJECTED").slice(0, 6).map((f) => f.summary), files: Math.max(0, x.attachments.length - 1) })),
      reminders: kids.map((k) => `${k.reference}: ${STATUS[k.status] ?? k.status}${k.submittedAt ? `, sent ${day(k.submittedAt)}` : ""}`),
      why: task?.title ?? (r.writtenByOfficer ? "Written by an officer" : null),
    };
  });

  const unlinked = [
    ...responses.filter((x) => !x.requestId).map((x) => ({ from: x.fromAddress, received: day(x.receivedAt), subject: x.subject, where: "In the case, not matched to a request yet" })),
    ...inbox.filter((m) => requests.some((r) => r.id === m.suggestedRequestId)).map((m) => ({ from: m.fromAddress, received: day(m.receivedAt), subject: m.subject, where: `In the station inbox, probably for ${requests.find((r) => r.id === m.suggestedRequestId)!.reference}` })),
  ];

  const pending: string[] = [];
  for (const m of mails) {
    if (UNSENT.includes(m.status)) pending.push(`${m.label} to ${m.to}: ${m.statusText}`);
    if (AWAITING.includes(m.status)) {
      const missing = m.asks.filter((a) => a.state === "still awaited" || a.state === "partly received").map((a) => a.label);
      pending.push(`${m.label} to ${m.to}: ${m.statusText}${m.sent ? `, sent ${m.sent}` : ""}${m.overdue ? `; follow-up was due ${m.followUp}` : m.followUp ? `; follow-up ${m.followUp}` : ""}${missing.length ? `; still awaited: ${missing.join("; ")}` : ""}`);
    }
    for (const r of m.replies) if (!r.reviewed) pending.push(`The reply to ${m.label} from ${r.from} (${r.received}) is not reviewed yet`);
  }
  for (const u of unlinked) pending.push(`A reply from ${u.from} (${u.received}) is not linked to its request: ${u.where.toLowerCase()}`);

  const files = evidence.map((e) => {
    const r = readings.find((x) => x.evidence.title === e.title);
    return { title: e.title, what: `${e.category.replace(/_/g, " ").toLowerCase()}${r ? ` · read: ${r.status === "APPLIED" ? "added to the case" : r.status === "KEPT" ? "kept as a file only" : "waiting for review"}` : ""}`, when: day(e.receivedAt) };
  });
  const rank = (p: string) => (p === "HIGH" ? 0 : p === "NORMAL" ? 1 : 2);
  const next = [...tasks].sort((a, b) => rank(a.priority) - rank(b.priority)).slice(0, 8).map((t) => `${t.title}${t.status === "BLOCKED" ? " (waits for something first)" : t.status === "DRAFT_PREPARED" ? " (drafted)" : ""}`);

  const lines: string[] = [];
  lines.push(`CASE CONTEXT: ${ref} (as of ${formatDateIST(at)})`);
  for (const f of facts) lines.push(`${f.label}: ${f.value}`);
  lines.push("", "MONEY TRAIL");
  if (!trail.length) lines.push("No payment or transfer recorded yet.");
  for (const l of trail) for (const r of l.rows) lines.push(`Level ${l.level}: ${r.name} got ${r.got} from ${r.from}; ${r.onward}${r.hold ? `; ${r.hold}` : ""}`);
  lines.push("", "ACCUSED'S SIDE", ...(sides.accused.length ? sides.accused : ["None recorded."]), "", "VICTIM'S SIDE", ...(sides.victim.length ? sides.victim : ["None recorded."]));
  if (sides.other.length) lines.push("", "OTHER IDENTIFIERS", ...sides.other);
  lines.push("", "MAILS SENT AND WHAT CAME BACK");
  if (!mails.length) lines.push("No mail yet.");
  for (const m of mails) {
    lines.push(`${m.label} to ${m.to}: ${m.statusText}${m.sent ? `, sent ${m.sent}` : ""}. Subject: ${m.subject}`);
    if (m.why) lines.push(`  Why: ${m.why}`);
    for (const a of m.asks) lines.push(`  Asked for: ${a.label} (${a.state})`);
    for (const r of m.replies) lines.push(`  Reply from ${r.from} on ${r.received} (${r.kind}${r.reviewed ? ", reviewed" : ", not reviewed yet"}${r.files ? `, ${r.files} file${r.files === 1 ? "" : "s"}` : ""})${r.findings.length ? `: ${r.findings.join("; ")}` : ""}`);
    for (const k of m.reminders) lines.push(`  Reminder ${k}`);
  }
  if (unlinked.length) lines.push("", "REPLIES NOT LINKED YET", ...unlinked.map((u) => `${u.from} on ${u.received}: ${u.subject} (${u.where})`));
  lines.push("", "PENDING", ...(pending.length ? pending : ["Nothing pending."]));
  lines.push("", "FILES IN THE CASE", ...(files.length ? files.map((f) => `${f.title} (${f.what}, ${f.when})`) : ["None."]));
  lines.push("", "OPEN NEXT ACTIONS", ...(next.length ? next : ["None."]));
  const text = lines.join("\n");
  return { caseId, ref, asOf: at.toISOString(), facts, trail, sides, mails, unlinked, pending, files, next, text: text.length > 24_000 ? `${text.slice(0, 24_000)}\n[… shortened]` : text };
}
