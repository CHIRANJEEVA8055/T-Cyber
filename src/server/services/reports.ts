import { z } from "zod";
import { isDiaryEvent } from "@/domain/activity";
import { formatInr } from "@/domain/money";
import { formatDateIST, formatDateTimeIST, formatTimeIST } from "@/domain/time";
import { statusDef } from "@/lib/labels";
import { shortRank } from "@/lib/cn";
import { citationLabel, evidenceHref } from "@/lib/evidence-href";
import type { Db } from "../db";
import type { SessionUser } from "../auth/session";
import { loadCaseForUser } from "../auth/access";
import { recordAudit } from "../audit";
import { now } from "../clock";
import { AppError, conflictError, notFoundError } from "../errors";
import { buildPdf, type PdfLine, type PdfPage } from "../documents/pdf-writer";
import { activityHref } from "./activity";
import { getCaseHeader, getCaseOverview, sortTasks } from "./overview";
import { ACTIVE_TASK_STATUSES } from "./tasks";
import { formatSections } from "@/domain/legal-sections";

export const REPORT_KINDS = {
  CASE_SUMMARY: "Case summary",
  CASE_DIARY: "Case diary draft",
  HANDOVER: "Handover note",
} as const;
export type ReportKind = keyof typeof REPORT_KINDS;
export const REPORT_KIND_DESCRIPTIONS: Record<ReportKind, string> = {
  CASE_SUMMARY: "Where the case stands: money, people and identifiers, requests, open questions and what is not yet known.",
  CASE_DIARY: "Officers' recorded steps, day by day, drafted from the activity record for the officer to complete.",
  HANDOVER: "Unresolved leads, pending requests and responses waiting for review, for an officer taking over.",
};

/** A numbered reference in a report body ("[S2]") to the record or document a statement comes from. */
export interface ReportSource {
  ref: string;
  label: string;
  href: string;
}

const PENDING_REQUEST_STATUSES = ["DRAFT", "AWAITING_APPROVAL", "APPROVED", "SUBMISSION_FAILED", "SUBMITTED", "ACKNOWLEDGED", "PARTIAL_RESPONSE"];
const LEAD_STATUS_ORDER: Record<string, number> = { OPEN: 0, DRAFT_PREPARED: 1, WAITING: 2, DEFERRED: 3 };

function sourceList() {
  const items: ReportSource[] = [];
  return {
    items,
    cite(label: string, href: string) {
      let s = items.find((i) => i.href === href);
      if (!s) {
        s = { ref: `S${items.length + 1}`, label, href };
        items.push(s);
      }
      return `[${s.ref}]`;
    },
  };
}

const inr = (minor: string) => formatInr(BigInt(minor));

// ---------------------------------------------------------------------------------------------------------
// Handover: a live view, and the source of the handover note.
// ---------------------------------------------------------------------------------------------------------

export async function getHandover(db: Db, user: SessionUser, caseId: string) {
  const header = await getCaseHeader(db, user, caseId);
  const overview = await getCaseOverview(db, user, caseId);
  const at = now();
  const [tasks, requests, responses, users] = await Promise.all([
    db.task.findMany({ where: { caseId, status: { in: ACTIVE_TASK_STATUSES } } }),
    db.request.findMany({ where: { caseId, status: { in: PENDING_REQUEST_STATUSES } }, include: { recipient: true, versions: { orderBy: { versionNo: "desc" }, take: 1 } }, orderBy: { reference: "asc" } }),
    db.response.findMany({ where: { caseId, OR: [{ matchStatus: "MATCHED", reviewStatus: { not: "APPLIED" } }, { matchStatus: "NEEDS_MATCH_REVIEW" }] }, orderBy: { receivedAt: "asc" } }),
    db.user.findMany({ select: { id: true, displayName: true, rank: true } }),
  ]);
  const name = (id: string | null) => {
    const u = users.find((x) => x.id === id);
    return u ? `${shortRank(u.rank)} ${u.displayName}` : null;
  };
  return {
    caseId,
    reference: header.reference,
    title: header.title,
    investigatingOfficer: header.investigatingOfficer,
    preparedAt: at.toISOString(),
    money: overview.ledger,
    unverifiedIdentifiers: overview.investigation.unverifiedIdentifiers,
    leads: sortTasks(tasks)
      .sort((a, b) => (LEAD_STATUS_ORDER[a.status] ?? 9) - (LEAD_STATUS_ORDER[b.status] ?? 9))
      .map((t) => ({
        id: t.id,
        kind: t.kind,
        title: t.title,
        question: t.question,
        objective: t.objective,
        status: t.status,
        requestId: t.requestId,
        responseId: t.responseId,
        priority: t.priority,
        assignee: name(t.assigneeId),
        deferredUntil: t.deferredUntil?.toISOString() ?? null,
      })),
    pendingRequests: requests.map((r) => ({
      id: r.id,
      reference: r.reference,
      status: r.status,
      category: r.category,
      recipient: r.recipient.organisation,
      subject: r.versions[0]?.subject ?? "",
      followUpAt: r.followUpAt?.toISOString() ?? null,
      followUpDue: !!r.followUpAt && r.followUpAt.getTime() < at.getTime(),
      needsReview: r.needsReview,
    })),
    responsesToReview: responses.map((r) => ({ id: r.id, from: r.fromAddress, subject: r.subject, receivedAt: r.receivedAt.toISOString(), needsMatch: r.matchStatus === "NEEDS_MATCH_REVIEW" })),
  };
}

export type HandoverData = Awaited<ReturnType<typeof getHandover>>;

function moneyLines(m: HandoverData["money"], cite: string): string[] {
  const lines = [
    `- Total reported loss ${inr(m.totalLossMinor)}; confirmed returned ${inr(m.confirmedRefundsMinor)}; outstanding ${inr(m.outstandingLossMinor)}. ${cite}`,
    m.neitherMinor !== null
      ? `- Confirmed held ${inr(m.confirmedHeldMinor)}; neither returned nor secured ${inr(m.neitherMinor)}.`
      : `- Confirmed held ${inr(m.confirmedHeldMinor)}; the amount neither returned nor secured cannot be stated until the ledger is reconciled.`,
  ];
  if (BigInt(m.refundsInPipelineMinor) > 0n) lines.push(`- Returns authorised or initiated but not yet credited: ${inr(m.refundsInPipelineMinor)}.`);
  if (m.unknownHolds.length) lines.push(`- Held amount not yet confirmed for ${m.unknownHolds.join(", ")}. An unknown amount is not counted as ₹0.`);
  for (const issue of m.issues) lines.push(`- Needs reconciliation: ${issue}`);
  return lines;
}

function composeHandover(h: HandoverData) {
  const src = sourceList();
  const base = `/cases/${h.caseId}`;
  const lines = [
    `Handover note for ${h.reference}: ${h.title}`,
    `Prepared from case records on ${formatDateTimeIST(new Date(h.preparedAt))}. Investigating officer: ${h.investigatingOfficer}. Check each item against the case before acting on it.`,
    "",
    "## Money position",
    ...moneyLines(h.money, src.cite("Funds ledger", `${base}/funds`)),
    "",
    `## Unresolved leads (${h.leads.length})`,
    ...(h.leads.length
      ? h.leads.map((t) => {
          const state = t.status === "WAITING" ? " Waiting for a response." : t.status === "DEFERRED" && t.deferredUntil ? ` Deferred until ${formatDateIST(new Date(t.deferredUntil))}.` : t.status === "DRAFT_PREPARED" ? " A draft request is prepared." : "";
          return `- ${t.title}. Open question: ${t.question}${state}${t.assignee ? ` Assigned to ${t.assignee}.` : ""} ${src.cite(`Next action: ${t.title}`, `${base}/actions?task=${t.id}`)}`;
        })
      : ["- None recorded."]),
    "",
    `## Pending requests (${h.pendingRequests.length})`,
    ...(h.pendingRequests.length
      ? h.pendingRequests.map((r) => {
          const follow = r.followUpAt ? `; follow-up ${r.followUpDue ? "was due" : "due"} ${formatDateIST(new Date(r.followUpAt))}` : "";
          return `- ${r.reference} to ${r.recipient}: ${statusDef("request", r.status).label.toLowerCase()}${follow}${r.needsReview ? "; its sources changed, so it needs review" : ""}. ${src.cite(`Request ${r.reference}`, `${base}/requests/${r.id}`)}`;
        })
      : ["- None."]),
    "",
    `## Responses waiting for review (${h.responsesToReview.length})`,
    ...(h.responsesToReview.length
      ? h.responsesToReview.map(
          (r) =>
            `- From ${r.from}, received ${formatDateTimeIST(new Date(r.receivedAt))}: ${r.subject}${r.needsMatch ? ". Which request it answers is not yet confirmed" : ""}. ${src.cite(`Response from ${r.from}`, `${base}/responses/${r.id}`)}`,
        )
      : ["- None."]),
    "",
    "## Identifiers",
    `- ${h.unverifiedIdentifiers} identifier${h.unverifiedIdentifiers === 1 ? " is" : "s are"} not yet verified. ${src.cite("Identifiers and locations", `${base}/people`)}`,
  ];
  return { title: `Handover note: ${h.reference}`, body: lines.join("\n"), sources: src.items };
}

// ---------------------------------------------------------------------------------------------------------
// Case summary
// ---------------------------------------------------------------------------------------------------------

async function composeSummary(db: Db, user: SessionUser, caseId: string) {
  const header = await getCaseHeader(db, user, caseId);
  const overview = await getCaseOverview(db, user, caseId);
  const [transactions, relationships, relSources, intakeDoc, requests, tasks] = await Promise.all([
    db.transaction.findMany({ where: { caseId } }),
    db.relationship.findMany({ where: { caseId }, include: { fromEntity: true, toEntity: true }, orderBy: { discoveredAt: "asc" } }),
    db.sourceAssertion.findMany({ where: { caseId, subjectType: "RELATIONSHIP" }, include: { evidence: { select: { title: true } } } }),
    db.evidenceItem.findFirst({ where: { caseId, category: { in: ["FIR_COPY", "COMPLAINT"] } }, orderBy: { uploadedAt: "asc" } }),
    db.request.findMany({ where: { caseId, status: { not: "DISCARDED" } }, include: { recipient: true }, orderBy: { reference: "asc" } }),
    db.task.findMany({ where: { caseId, status: { in: ACTIVE_TASK_STATUSES } } }),
  ]);
  const src = sourceList();
  const base = `/cases/${caseId}`;
  const inv = overview.investigation;

  const layers = new Map<number, { total: bigint; count: number }>();
  for (const t of transactions) {
    const l = layers.get(t.layer) ?? { total: 0n, count: 0 };
    layers.set(t.layer, { total: l.total + t.amountMinor, count: l.count + 1 });
  }
  const statusCounts = new Map<string, number>();
  for (const r of requests) statusCounts.set(r.status, (statusCounts.get(r.status) ?? 0) + 1);
  const waiting = requests.filter((r) => ["SUBMITTED", "ACKNOWLEDGED", "PARTIAL_RESPONSE"].includes(r.status));
  const missing = tasks.filter((t) => t.kind === "MISSING_INFORMATION");

  const lines = [
    `Case summary for ${header.reference}: ${header.title}`,
    `Draft prepared from case records on ${formatDateTimeIST(now())}. It states only what the records show; review it before relying on it.`,
    "",
    "## Case",
    `- ${header.reference}, registered ${formatDateIST(new Date(header.registeredAt))} at ${header.stationName}. Investigating officer: ${header.investigatingOfficer}.`,
    `- Legal sections: ${header.legalSections ? `${formatSections(header.legalSections)} (${header.legalSectionsSource ?? "source not recorded"})` : "not entered by an officer"}.`,
    ...(header.narrative ? [`- Complaint as recorded: ${header.narrative} ${intakeDoc ? src.cite(intakeDoc.title, `${base}/evidence/${intakeDoc.id}`) : ""}`.trimEnd()] : []),
    "",
    "## Money",
    `- ${overview.ledger.victimCount} victim claim${overview.ledger.victimCount === 1 ? "" : "s"} recorded.`,
    ...moneyLines(overview.ledger, src.cite("Funds ledger", `${base}/funds`)),
    ...(layers.size
      ? [
          `- Transfers traced: ${[...layers.entries()]
            .sort(([a], [b]) => a - b)
            .map(([layer, v]) => `layer ${layer} ${formatInr(v.total)} in ${v.count} transfer${v.count === 1 ? "" : "s"}`)
            .join("; ")}. ${src.cite("Money flow graph", `${base}/graph`)}`,
        ]
      : []),
    "",
    "## People, accounts and identifiers",
    `- ${inv.people} ${inv.people === 1 ? "person" : "people"} recorded, including ${inv.victims} victim${inv.victims === 1 ? "" : "s"} and ${inv.holdersOnRecord} account holder${inv.holdersOnRecord === 1 ? "" : "s"} on record. ${inv.identifiers} identifier${inv.identifiers === 1 ? "" : "s"}, ${inv.unverifiedIdentifiers} not yet verified. ${src.cite("People and identifiers", `${base}/people`)}`,
    ...(inv.locations ? [`- ${inv.locations} location observation${inv.locations === 1 ? "" : "s"}; none is a current location.`] : []),
    ...relationships.map((r) => {
      const s = relSources.find((x) => x.subjectId === r.id);
      return `- As recorded: “${r.statement}” ${s ? src.cite(citationLabel(s.evidence.title, s.locator), evidenceHref(caseId, s.evidenceId, s.locator)) : src.cite("Identifiers and locations", `${base}/people`)}`;
    }),
    "",
    "## Requests",
    requests.length
      ? `- ${requests.length} request${requests.length === 1 ? "" : "s"} by status: ${[...statusCounts.entries()].map(([s, n]) => `${statusDef("request", s).label} ${n}`).join("; ")}. ${src.cite("Requests", `${base}/requests`)}`
      : "- No requests yet.",
    ...(waiting.length ? [`- Waiting for a response: ${waiting.map((r) => `${r.reference} (${r.recipient.organisation})`).join(", ")}.`] : []),
    "",
    `## Open next actions (${tasks.length})`,
    ...(tasks.length ? sortTasks(tasks).map((t) => `- ${t.title} ${src.cite(`Next action: ${t.title}`, `${base}/actions?task=${t.id}`)}`) : ["- None."]),
    "",
    "## Not yet known",
    ...[
      ...overview.ledger.unknownHolds.map((label) => `- The amount held in ${label}.`),
      ...missing.map((t) => `- ${t.question}`),
      ...(inv.unverifiedIdentifiers ? [`- Whether the ${inv.unverifiedIdentifiers} unverified identifier${inv.unverifiedIdentifiers === 1 ? "" : "s"} belong to the people they are linked with.`] : []),
    ],
  ];
  if (lines.at(-1) === "## Not yet known") lines.push("- Nothing recorded as unknown.");
  return { title: `Case summary: ${header.reference}`, body: lines.join("\n"), sources: src.items };
}

// ---------------------------------------------------------------------------------------------------------
// Case diary
// ---------------------------------------------------------------------------------------------------------

async function composeDiary(db: Db, user: SessionUser, caseId: string) {
  const header = await getCaseHeader(db, user, caseId);
  const events = (await db.auditEvent.findMany({ where: { caseId }, orderBy: [{ at: "asc" }, { id: "asc" }] })).filter(isDiaryEvent);
  const ids = (type: string) => events.filter((e) => e.objectType === type && e.objectId).map((e) => e.objectId!);
  const [users, requests, responses, evidence] = await Promise.all([
    db.user.findMany({ select: { id: true, displayName: true, rank: true } }),
    db.request.findMany({ where: { id: { in: ids("Request") } }, select: { id: true, reference: true } }),
    db.response.findMany({ where: { id: { in: ids("Response") } }, select: { id: true, fromAddress: true } }),
    db.evidenceItem.findMany({ where: { id: { in: ids("EvidenceItem") } }, select: { id: true, title: true } }),
  ]);
  const name = (id: string | null) => {
    const u = users.find((x) => x.id === id);
    return u ? `${shortRank(u.rank)} ${u.displayName}` : "An officer";
  };
  const labelFor = (type: string, id: string | null): string => {
    switch (type) {
      case "Request":
        return `Request ${requests.find((r) => r.id === id)?.reference ?? ""}`.trim();
      case "Response":
        return `Response from ${responses.find((r) => r.id === id)?.fromAddress ?? "a provider"}`;
      case "EvidenceItem":
        return evidence.find((e) => e.id === id)?.title ?? "Evidence item";
      case "Task":
        return "Next action";
      case "Hold":
      case "Allocation":
        return "Holds and allocations";
      case "Refund":
        return "Returns";
      case "Transaction":
      case "VictimClaim":
        return "Funds";
      case "AuditEvent":
        return "Activity record";
      case "Case":
        return "Case overview";
      default:
        return "Identifiers and locations";
    }
  };
  const src = sourceList();
  const lines = [
    `Case diary draft for ${header.reference}: ${header.title}`,
    `Drafted from the activity record on ${formatDateTimeIST(now())}. Each entry is a step an officer recorded in this system; add anything done outside it and review before use.`,
  ];
  let day = "";
  for (const e of events) {
    const d = formatDateIST(e.at);
    if (d !== day) {
      lines.push("", `## ${d}`);
      day = d;
    }
    const href = activityHref(caseId, e.objectType, e.objectId);
    lines.push(`- ${formatTimeIST(e.at)}, ${name(e.actorId)}: ${e.summary}${href ? ` ${src.cite(labelFor(e.objectType, e.objectId), href)}` : ""}`);
  }
  if (!events.length) lines.push("", "- No officer steps are recorded yet.");
  return { title: `Case diary draft: ${header.reference}`, body: lines.join("\n"), sources: src.items };
}

async function compose(db: Db, user: SessionUser, caseId: string, kind: ReportKind) {
  if (kind === "CASE_SUMMARY") return composeSummary(db, user, caseId);
  if (kind === "CASE_DIARY") return composeDiary(db, user, caseId);
  return composeHandover(await getHandover(db, user, caseId));
}

// ---------------------------------------------------------------------------------------------------------
// Reports and versions
// ---------------------------------------------------------------------------------------------------------

const kindSchema = z.enum(["CASE_SUMMARY", "CASE_DIARY", "HANDOVER"]);

/** Drafts a report from the current case records as version 1. */
export async function createReport(db: Db, user: SessionUser, caseId: string, kind: ReportKind) {
  const k = kindSchema.parse(kind);
  await loadCaseForUser(db, user, caseId, "write");
  const draft = await compose(db, user, caseId, k);
  return db.$transaction(async (tx) => {
    await loadCaseForUser(tx, user, caseId, "write");
    const at = now();
    const report = await tx.report.create({
      data: {
        caseId,
        kind: k,
        title: draft.title,
        status: "DRAFT",
        latestVersion: 1,
        createdById: user.id,
        createdAt: at,
        versions: { create: { versionNo: 1, body: draft.body, sourcesJson: JSON.stringify(draft.sources), generated: true, createdById: user.id, createdAt: at } },
      },
    });
    await recordAudit(tx, { caseId, actorId: user.id, action: "report.created", objectType: "Report", objectId: report.id, summary: `${REPORT_KINDS[k]} drafted from case records (version 1)` });
    return { reportId: report.id };
  });
}

async function loadReport(db: Db, user: SessionUser, reportId: string, mode: "read" | "write") {
  const report = await db.report.findUnique({ where: { id: reportId } });
  if (!report) throw notFoundError("report");
  await loadCaseForUser(db, user, report.caseId, mode);
  return report;
}

/** Drafts a fresh version from the current records; earlier versions stay as they were. */
export async function regenerateReport(db: Db, user: SessionUser, reportId: string, input: { expectedVersion: number }) {
  const report = await loadReport(db, user, reportId, "write");
  const draft = await compose(db, user, report.caseId, report.kind as ReportKind);
  return db.$transaction(async (tx) => {
    await loadCaseForUser(tx, user, report.caseId, "write");
    const next = input.expectedVersion + 1;
    const claimed = await tx.report.updateMany({ where: { id: reportId, latestVersion: input.expectedVersion }, data: { latestVersion: next, status: "DRAFT", title: draft.title } });
    if (claimed.count !== 1) throw conflictError("A newer version of this report was saved. Open it to see the latest version.");
    const at = now();
    await tx.reportVersion.create({ data: { reportId, versionNo: next, body: draft.body, sourcesJson: JSON.stringify(draft.sources), generated: true, changeNote: "Redrafted from the current case records", createdById: user.id, createdAt: at } });
    await recordAudit(tx, { caseId: report.caseId, actorId: user.id, action: "report.regenerated", objectType: "Report", objectId: reportId, summary: `${REPORT_KINDS[report.kind as ReportKind]} redrafted from current records (version ${next})` });
    return { versionNo: next };
  });
}

const editSchema = z.object({
  body: z.string().trim().min(1, "The report cannot be empty.").max(50_000, "Keep the report under 50,000 characters."),
  changeNote: z.string().trim().min(3, "Say briefly what you changed.").max(300, "Keep the note under 300 characters."),
  expectedVersion: z.number().int().positive(),
});

/** An officer's edit is saved as a new version. Review always belongs to one exact version. */
export async function saveReportEdit(db: Db, user: SessionUser, reportId: string, input: z.input<typeof editSchema>) {
  const parsed = editSchema.safeParse(input);
  if (!parsed.success) {
    const fieldErrors = Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0]), i.message]));
    throw new AppError(parsed.error.issues[0]?.message ?? "Check the report.", "VALIDATION", fieldErrors);
  }
  const { body, changeNote, expectedVersion } = parsed.data;
  return db.$transaction(async (tx) => {
    const report = await tx.report.findUnique({ where: { id: reportId } });
    if (!report) throw notFoundError("report");
    await loadCaseForUser(tx, user, report.caseId, "write");
    const latest = await tx.reportVersion.findUnique({ where: { reportId_versionNo: { reportId, versionNo: report.latestVersion } } });
    const next = expectedVersion + 1;
    const claimed = await tx.report.updateMany({ where: { id: reportId, latestVersion: expectedVersion }, data: { latestVersion: next, status: "DRAFT" } });
    if (claimed.count !== 1) throw conflictError("A newer version of this report was saved while you were editing. Your text is still in the editor; copy it, then open the latest version.");
    await tx.reportVersion.create({ data: { reportId, versionNo: next, body, sourcesJson: latest?.sourcesJson ?? "[]", generated: false, changeNote, createdById: user.id, createdAt: now() } });
    await recordAudit(tx, { caseId: report.caseId, actorId: user.id, action: "report.edited", objectType: "Report", objectId: reportId, summary: `${REPORT_KINDS[report.kind as ReportKind]} edited (version ${next}): ${changeNote}` });
    return { versionNo: next };
  });
}

/** Records that an officer reviewed the latest version. A later edit starts a new, unreviewed draft. */
export async function markReportReviewed(db: Db, user: SessionUser, reportId: string, input: { versionNo: number }) {
  return db.$transaction(async (tx) => {
    const report = await tx.report.findUnique({ where: { id: reportId } });
    if (!report) throw notFoundError("report");
    await loadCaseForUser(tx, user, report.caseId, "write");
    if (input.versionNo !== report.latestVersion) throw new AppError(`Only the latest version (version ${report.latestVersion}) can be marked as reviewed.`, "PRECONDITION");
    const version = await tx.reportVersion.findUnique({ where: { reportId_versionNo: { reportId, versionNo: input.versionNo } } });
    if (!version) throw notFoundError("report version");
    if (version.reviewedAt) throw new AppError(`Version ${input.versionNo} is already marked as reviewed.`, "PRECONDITION");
    const at = now();
    await tx.reportVersion.update({ where: { id: version.id }, data: { reviewedById: user.id, reviewedAt: at } });
    await tx.report.update({ where: { id: reportId }, data: { status: "REVIEWED" } });
    await recordAudit(tx, { caseId: report.caseId, actorId: user.id, action: "report.reviewed", objectType: "Report", objectId: reportId, summary: `${REPORT_KINDS[report.kind as ReportKind]} version ${input.versionNo} marked as reviewed` });
  });
}

export async function listReports(db: Db, user: SessionUser, caseId: string) {
  await loadCaseForUser(db, user, caseId, "read");
  const [reports, users] = await Promise.all([
    db.report.findMany({ where: { caseId }, include: { versions: { orderBy: { versionNo: "desc" }, take: 1 } }, orderBy: { updatedAt: "desc" } }),
    db.user.findMany({ select: { id: true, displayName: true, rank: true } }),
  ]);
  const name = (id: string | null) => {
    const u = users.find((x) => x.id === id);
    return u ? `${shortRank(u.rank)} ${u.displayName}` : null;
  };
  return reports.map((r) => ({
    id: r.id,
    kind: r.kind as ReportKind,
    kindLabel: REPORT_KINDS[r.kind as ReportKind] ?? r.kind,
    title: r.title,
    status: r.status,
    latestVersion: r.latestVersion,
    updatedAt: (r.versions[0]?.createdAt ?? r.updatedAt).toISOString(),
    updatedBy: name(r.versions[0]?.createdById ?? r.createdById),
    reviewedBy: name(r.versions[0]?.reviewedById ?? null),
  }));
}

export async function getReport(db: Db, user: SessionUser, reportId: string, versionNo?: number) {
  const report = await loadReport(db, user, reportId, "read");
  const [versions, users] = await Promise.all([db.reportVersion.findMany({ where: { reportId }, orderBy: { versionNo: "desc" } }), db.user.findMany({ select: { id: true, displayName: true, rank: true } })]);
  const name = (id: string | null) => {
    const u = users.find((x) => x.id === id);
    return u ? `${shortRank(u.rank)} ${u.displayName}` : null;
  };
  const selected = versions.find((v) => v.versionNo === (versionNo ?? report.latestVersion));
  if (!selected) throw notFoundError("report version");
  const shape = (v: (typeof versions)[number]) => ({
    versionNo: v.versionNo,
    generated: v.generated,
    changeNote: v.changeNote,
    createdAt: v.createdAt.toISOString(),
    createdBy: name(v.createdById) ?? "Unknown user",
    reviewedAt: v.reviewedAt?.toISOString() ?? null,
    reviewedBy: name(v.reviewedById),
  });
  return {
    report: { id: report.id, caseId: report.caseId, kind: report.kind as ReportKind, kindLabel: REPORT_KINDS[report.kind as ReportKind] ?? report.kind, title: report.title, status: report.status, latestVersion: report.latestVersion },
    version: { ...shape(selected), body: selected.body, sources: JSON.parse(selected.sourcesJson) as ReportSource[] },
    versions: versions.map(shape),
  };
}

export type ReportDetail = Awaited<ReturnType<typeof getReport>>;

// ---------------------------------------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------------------------------------

function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > width) {
      out.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out.length ? out : [""];
}

function paginate(lines: PdfLine[]): PdfPage[] {
  const pages: PdfPage[] = [];
  let current: PdfLine[] = [];
  let y = 790;
  for (const raw of lines) {
    let line = raw;
    const step = (line.gapBefore ?? 0) + (line.size ?? 10) * 1.5;
    if (y - step < 56 && current.length) {
      pages.push({ lines: current });
      current = [];
      y = 790;
      line = { ...line, gapBefore: 0 };
    }
    y -= (line.gapBefore ?? 0) + (line.size ?? 10) * 1.5;
    current.push(line);
  }
  if (current.length) pages.push({ lines: current });
  return pages;
}

/** A version as a PDF, with its review status and sources. Every export is recorded in the activity log. */
export async function exportReportPdf(db: Db, user: SessionUser, reportId: string, versionNo: number) {
  const detail = await getReport(db, user, reportId, versionNo);
  const header = await getCaseHeader(db, user, detail.report.caseId);
  const v = detail.version;
  const out: PdfLine[] = [
    { text: detail.report.title, size: 14, bold: true },
    { text: `${header.reference}. Version ${v.versionNo}, saved ${formatDateTimeIST(new Date(v.createdAt))} by ${v.createdBy}.`, size: 9, gapBefore: 4 },
    { text: v.reviewedAt ? `Reviewed by ${v.reviewedBy ?? "an officer"} on ${formatDateTimeIST(new Date(v.reviewedAt))}.` : "Not yet reviewed by an officer.", size: 9 },
    { text: "Demonstration environment: all names, accounts and records are synthetic.", size: 9 },
  ];
  for (const line of v.body.split("\n")) {
    if (!line.trim()) {
      out.push({ text: "", size: 6 });
    } else if (line.startsWith("## ")) {
      out.push({ text: line.slice(3), size: 11, bold: true, gapBefore: 6 });
    } else if (line.startsWith("- ")) {
      wrap(line.slice(2), 92).forEach((part, i) => out.push({ text: `${i === 0 ? "- " : "  "}${part}`, size: 10 }));
    } else {
      wrap(line, 94).forEach((part) => out.push({ text: part, size: 10 }));
    }
  }
  if (v.sources.length) {
    out.push({ text: "Sources", size: 11, bold: true, gapBefore: 10 });
    for (const s of v.sources) wrap(`[${s.ref}] ${s.label}: ${s.href}`, 100).forEach((part, i) => out.push({ text: `${i === 0 ? "" : "    "}${part}`, size: 9 }));
  }
  const bytes = buildPdf(paginate(out), { title: detail.report.title, producer: "T-CYBER report export (demonstration)" });
  const filename = `${header.reference.replace(/[^A-Za-z0-9]+/g, "-")}-${detail.report.kind.toLowerCase().replace(/_/g, "-")}-v${v.versionNo}.pdf`;
  await db.$transaction(async (tx) => {
    await recordAudit(tx, { caseId: detail.report.caseId, actorId: user.id, action: "report.exported", objectType: "Report", objectId: reportId, summary: `${detail.report.kindLabel} version ${v.versionNo} exported as PDF` });
  });
  return { filename, bytes };
}
