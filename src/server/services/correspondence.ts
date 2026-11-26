import type { Prisma } from "@/generated/prisma/client";
import { gmailDraftView } from "../gmail/view";
import { deliverySettings } from "../config";
import { mailDefaultsFor } from "./mail-defaults";
import { formatInr } from "@/domain/money";
import { formatDateTimeIST } from "@/domain/time";
import { shortRank } from "@/lib/cn";
import type { Db } from "../db";
import type { SessionUser } from "../auth/session";
import { caseAccessWhere, loadCaseForUser } from "../auth/access";
import { notFoundError } from "../errors";
import { caseReference } from "./cases";
import { parseAttributes } from "./facts";
import { computeContentHash } from "./requests";
import { checkSubmissionReadiness } from "@/domain/request-workflow";
import { responseRef } from "@/domain/request-ref";
import { getAppConfig } from "../config";

/**
 * Case "Requests" and global "Correspondence" are the same records filtered differently.
 * Both pages call listCorrespondence; only the scope (one case vs all accessible cases) differs.
 */
export const VIEWS = {
  inbox: { label: "Inbox", statuses: null },
  drafts: { label: "Drafts", statuses: ["DRAFT", "APPROVED", "SUBMISSION_FAILED"] },
  approval: { label: "Awaiting approval", statuses: ["AWAITING_APPROVAL"] },
  awaiting: { label: "Awaiting response", statuses: ["SUBMITTED", "ACKNOWLEDGED"] },
  partial: { label: "Partial response", statuses: ["PARTIAL_RESPONSE"] },
  sent: { label: "Sent", statuses: ["SUBMITTED", "ACKNOWLEDGED", "PARTIAL_RESPONSE", "COMPLETE_RESPONSE", "REJECTED"] },
  all: { label: "All requests", statuses: null },
} as const;
export type CorrespondenceView = keyof typeof VIEWS;

export async function listCorrespondence(db: Db, user: SessionUser, opts: { caseId?: string; view: CorrespondenceView; q?: string }) {
  if (opts.caseId) await loadCaseForUser(db, user, opts.caseId, "read");
  const caseScope: Prisma.CaseWhereInput = opts.caseId ? { id: opts.caseId } : caseAccessWhere(user);
  const q = opts.q?.trim();

  // A mail an officer discarded before sending is kept (records are never deleted) but listed nowhere.
  const requestWhere: Prisma.RequestWhereInput = { case: caseScope, status: { not: "DISCARDED" } };
  const reqCounts = await db.request.groupBy({ by: ["status"], where: requestWhere, _count: true });
  const countFor = (statuses: readonly string[] | null) => reqCounts.filter((c) => !statuses || statuses.includes(c.status)).reduce((s, c) => s + c._count, 0);
  // Every imported message is filed under a case the officer can access (see importResponse).
  const responseWhere: Prisma.ResponseWhereInput = opts.caseId ? { caseId: opts.caseId } : { case: caseScope };
  const inboxCount = await db.response.count({ where: { AND: [responseWhere, { OR: [{ reviewStatus: { in: ["UNREVIEWED", "IN_REVIEW"] } }, { matchStatus: { not: "MATCHED" } }] }] } });
  const counts = Object.fromEntries(Object.entries(VIEWS).map(([k, v]) => [k, k === "inbox" ? inboxCount : countFor(v.statuses)])) as Record<CorrespondenceView, number>;

  if (opts.view === "inbox") {
    const responses = await db.response.findMany({
      where: {
        AND: [
          responseWhere,
          q ? { OR: [{ subject: { contains: q } }, { fromAddress: { contains: q } }, { bodyText: { contains: q } }] } : {},
        ],
      },
      include: { case: true, request: true, _count: { select: { findings: true, attachments: true } } },
      orderBy: { receivedAt: "desc" },
    });
    const resRefs = await responseRefsFor(db, responses.filter((r) => r.matchStatus === "MATCHED"));
    return {
      counts,
      requests: [],
      responses: responses.map((r) => ({
        id: r.id,
        reference: resRefs.get(r.id) ?? null,
        caseId: r.caseId,
        caseReference: r.case ? caseReference(r.case) : "Not matched to a case",
        fromAddress: r.fromAddress,
        subject: r.subject,
        receivedAt: r.receivedAt.toISOString(),
        requestReference: r.request?.reference ?? null,
        matchStatus: r.matchStatus,
        reviewStatus: r.reviewStatus,
        suggestedType: r.suggestedType,
        responseType: r.responseType,
        findings: r._count.findings,
        attachments: r._count.attachments,
      })),
    };
  }

  const statuses = VIEWS[opts.view].statuses;
  const requests = await db.request.findMany({
    where: {
      AND: [
        requestWhere,
        statuses ? { status: { in: [...statuses] } } : {},
        q ? { OR: [{ reference: { contains: q } }, { legacyReference: { contains: q } }, { versions: { some: { subject: { contains: q } } } }, { recipient: { organisation: { contains: q } } }] } : {},
      ],
    },
    include: { case: true, recipient: true, items: true, versions: { orderBy: { versionNo: "desc" }, take: 1 }, responses: { select: { reviewStatus: true } } },
    orderBy: { reference: "desc" },
  });
  return {
    counts,
    responses: [],
    requests: requests.map((r) => ({
      id: r.id,
      caseId: r.caseId,
      caseReference: caseReference(r.case),
      reference: r.reference,
      category: r.category,
      status: r.status,
      subject: r.versions[0]?.subject ?? "",
      recipient: r.recipient.organisation,
      recipientVerified: r.recipient.verificationStatus === "VERIFIED",
      itemsReceived: r.items.filter((i) => i.status === "RECEIVED").length,
      itemsTotal: r.items.length,
      followUpAt: r.followUpAt?.toISOString() ?? null,
      submittedAt: r.submittedAt?.toISOString() ?? null,
      needsReview: r.needsReview,
      responsesToReview: r.responses.filter((x) => x.reviewStatus !== "APPLIED").length,
      updatedAt: r.updatedAt.toISOString(),
    })),
  };
}

export async function getRequestDetail(db: Db, user: SessionUser, requestId: string) {
  const req = await db.request.findUnique({
    where: { id: requestId },
    include: {
      case: true,
      recipient: true,
      versions: { orderBy: { versionNo: "asc" } },
      items: { orderBy: { sortOrder: "asc" } },
      approvals: { orderBy: { decidedAt: "asc" } },
      submissions: { orderBy: { attemptedAt: "asc" } },
      notes: { orderBy: { createdAt: "asc" } },
      subjects: { include: { entity: true } },
      responses: { orderBy: { receivedAt: "asc" }, include: { findings: { select: { decision: true } } } },
    },
  });
  if (!req) throw notFoundError("request");
  await loadCaseForUser(db, user, req.caseId, "read");
  const [users, route, recipients, evidence, parent, children, task] = await Promise.all([
    db.user.findMany({ select: { id: true, displayName: true, rank: true, role: true } }),
    req.routeId ? db.routingRule.findUnique({ where: { id: req.routeId } }) : Promise.resolve(null),
    db.recipient.findMany({ where: { active: true }, orderBy: { organisation: "asc" } }),
    db.evidenceItem.findMany({ where: { caseId: req.caseId, derivation: "ORIGINAL" }, select: { id: true, title: true, fileName: true, category: true }, orderBy: { receivedAt: "asc" } }),
    req.parentRequestId ? db.request.findUnique({ where: { id: req.parentRequestId }, select: { id: true, reference: true, status: true } }) : Promise.resolve(null),
    db.request.findMany({ where: { parentRequestId: req.id }, select: { id: true, reference: true, status: true } }),
    req.taskId ? db.task.findUnique({ where: { id: req.taskId } }) : Promise.resolve(null),
  ]);
  const who = (id: string | null) => {
    const u = users.find((x) => x.id === id);
    return u ? `${shortRank(u.rank)} ${u.displayName}` : "System";
  };
  const current = req.versions.find((v) => v.versionNo === req.currentVersionNo)!;
  const items = (JSON.parse(current.basisJson) as { items?: { label: string; itemType: string }[] }).items ?? req.items.map((i) => ({ label: i.label, itemType: i.itemType }));
  const attachmentIds = JSON.parse(current.attachmentIdsJson) as string[];
  const hashCheck = computeContentHash({ recipientId: current.recipientId, subject: current.subject, body: current.body, scope: current.scope, periodFrom: current.periodFrom, periodTo: current.periodTo, attachmentIds, items, fromAddress: current.fromAddress });
  // What this officer's new drafts are sent from and signed with, to compare an edit against.
  const mail = await mailDefaultsFor(db, user);
  const readiness = checkSubmissionReadiness({
    status: req.status,
    currentVersionNo: req.currentVersionNo,
    approvedVersionNo: req.approvedVersionNo,
    approvedHash: req.approvedHash,
    currentHash: current.contentHash,
    recipientVerification: req.recipient.verificationStatus,
    needsReview: req.needsReview,
    confirmed: true,
  });

  type ThreadItem = { at: string; kind: string; title: string; detail?: string; href?: string; actor?: string; tone?: "danger" | "success" | "warning" };
  const thread: ThreadItem[] = [
    ...req.versions.map((v) => ({ at: v.createdAt.toISOString(), kind: "version", title: v.versionNo === 1 ? "Draft prepared (version 1)" : `Edited: version ${v.versionNo}`, detail: v.changeNote ?? undefined, actor: who(v.createdById) })),
    ...req.approvals.map((a) => ({
      at: a.decidedAt.toISOString(),
      kind: "approval",
      title: a.decision === "APPROVED" ? `Version ${a.versionNo} approved` : `Version ${a.versionNo} returned for changes`,
      detail: [a.note, a.invalidatedAt ? `Approval withdrawn on ${formatDateTimeIST(a.invalidatedAt)}: ${a.invalidatedReason}` : null].filter(Boolean).join(" ") || undefined,
      actor: who(a.decidedById),
      tone: a.decision === "APPROVED" && !a.invalidatedAt ? ("success" as const) : ("warning" as const),
    })),
    ...req.submissions.map((s) => ({
      at: s.attemptedAt.toISOString(),
      kind: "submission",
      title: s.outcome === "SUCCEEDED" ? `Submitted (version ${s.versionNo})` : `Submission failed (version ${s.versionNo})`,
      detail: s.outcome === "SUCCEEDED" ? `${s.adapter}. Reference ${s.externalReference}.` : s.errorMessage ?? undefined,
      actor: who(s.actorId),
      tone: s.outcome === "SUCCEEDED" ? ("success" as const) : ("danger" as const),
    })),
    ...req.responses.map((r) => ({
      at: r.receivedAt.toISOString(),
      kind: "response",
      title: `Response received from ${r.fromAddress}`,
      detail: `${r.subject}. ${r.reviewStatus === "APPLIED" ? `Reviewed and recorded as ${r.responseType.toLowerCase().replace(/_/g, " ")}.` : "Waiting for review."}`,
      href: `/cases/${req.caseId}/responses/${r.id}`,
      tone: r.reviewStatus === "APPLIED" ? undefined : ("warning" as const),
    })),
    ...req.notes.map((n) => ({ at: n.createdAt.toISOString(), kind: "note", title: "Internal note", detail: n.body, actor: who(n.authorId) })),
  ].sort((a, b) => a.at.localeCompare(b.at));

  const pendingApproval = req.status === "AWAITING_APPROVAL";
  return {
    id: req.id,
    caseId: req.caseId,
    caseReference: caseReference(req.case),
    reference: req.reference,
    /** The reference it had before references named their case; replies quoting it still match. */
    legacyReference: req.legacyReference,
    category: req.category,
    status: req.status,
    version: req.version,
    channel: req.channel,
    needsReview: req.needsReview,
    needsReviewReason: req.needsReviewReason,
    followUpAt: req.followUpAt?.toISOString() ?? null,
    submittedAt: req.submittedAt?.toISOString() ?? null,
    externalReference: req.externalReference,
    currentVersionNo: req.currentVersionNo,
    approvedVersionNo: req.approvedVersionNo,
    approvedHash: req.approvedHash,
    contentHash: current.contentHash,
    hashIntact: hashCheck === current.contentHash,
    mail,
    /** v1 delivery: approved requests go to the PS IO's mailbox, and the IO forwards them. */
    delivery: { viaIo: deliverySettings().mode === "via-io" && req.channel !== "PORTAL", ioMailbox: deliverySettings().ioMailbox, handedOverAt: req.handedOverAt?.toISOString() ?? null, handedOverTo: req.handedOverTo },
    gmail: gmailDraftView(req, req.case.isDemo),
    current: {
      recipientId: current.recipientId,
      /** The mailbox this version is sent from (the station mailbox when none was set on it). */
      fromAddress: current.fromAddress ?? mail.stationFrom,
      subject: current.subject,
      body: current.body,
      scope: current.scope,
      periodFrom: current.periodFrom?.toISOString() ?? null,
      periodTo: current.periodTo?.toISOString() ?? null,
      attachmentIds,
      items,
      author: who(current.createdById),
      authorId: current.createdById,
      createdAt: current.createdAt.toISOString(),
    },
    recipient: {
      id: req.recipient.id,
      name: req.recipient.name,
      organisation: req.recipient.organisation,
      address: req.recipient.address,
      channel: req.recipient.channel,
      verificationStatus: req.recipient.verificationStatus,
      verificationNote: req.recipient.verificationNote,
      /** A draft written before its addressee was known: whom it is for. */
      unaddressed: req.recipient.organisationType === "UNADDRESSED" ? (/\[([^\]]+): to be filled in\]/.exec(current.body)?.[1] ?? "the recipient") : null,
    },
    route: route ? { name: route.name, approvalRole: route.approvalRole, followUpDays: route.followUpDays, procedureNote: route.procedureNote } : null,
    recipients: recipients
      .filter((r) => (JSON.parse(r.categoriesJson) as string[]).includes(req.category))
      .map((r) => ({ id: r.id, label: r.name, verified: r.verificationStatus === "VERIFIED", channel: r.channel })),
    evidence: evidence.map((e) => ({ id: e.id, title: e.title })),
    items: req.items.map((i) => ({ id: i.id, label: i.label, itemType: i.itemType, status: i.status, note: i.note, responseId: i.responseId })),
    subjects: req.subjects.map((s) => ({ id: s.entityId, label: s.entity.label, value: s.entity.value, kind: s.entity.kind, bank: (parseAttributes(s.entity.attributesJson).bank as string | undefined) ?? null })),
    versions: req.versions.map((v) => ({ versionNo: v.versionNo, author: who(v.createdById), createdAt: v.createdAt.toISOString(), contentHash: v.contentHash, changeNote: v.changeNote })),
    activeApproval: (() => {
      const a = [...req.approvals].reverse().find((x) => x.decision === "APPROVED" && !x.invalidatedAt && x.versionNo === req.approvedVersionNo);
      return a ? { versionNo: a.versionNo, by: who(a.decidedById), at: a.decidedAt.toISOString(), contentHash: a.contentHash } : null;
    })(),
    lastFailure: (() => {
      const s = [...req.submissions].reverse()[0];
      return s && s.outcome === "FAILED" ? { at: s.attemptedAt.toISOString(), error: s.errorMessage } : null;
    })(),
    // Where the request actually went, as recorded at submission; the directory entry may have changed since.
    sentTo: (() => {
      const s = [...req.submissions].reverse().find((x) => x.outcome === "SUCCEEDED" && x.recipientAddress);
      return s ? { address: s.recipientAddress!, at: s.attemptedAt.toISOString() } : null;
    })(),
    readinessReasons: readiness.ok ? [] : readiness.reasons,
    canApprove: user.role === "SUPERVISOR" && pendingApproval && current.createdById !== user.id,
    isAuthor: current.createdById === user.id,
    parent,
    children,
    task: task ? { id: task.id, title: task.title, question: task.question } : null,
    thread,
    responses: req.responses.map((r) => ({ id: r.id, receivedAt: r.receivedAt.toISOString(), fromAddress: r.fromAddress, reviewStatus: r.reviewStatus, responseType: r.responseType })),
  };
}

export type RequestDetail = Awaited<ReturnType<typeof getRequestDetail>>;

function previewFor(f: { findingType: string; payloadJson: string; editedPayloadJson: string | null; classification: string }, labels: Map<string, string>): string {
  const p = JSON.parse(f.editedPayloadJson ?? f.payloadJson) as Record<string, unknown>;
  switch (f.findingType) {
    case "TRANSACTION": {
      const cp = (p.counterparty ?? {}) as { entityId?: string | null; value?: string | null; bank?: string | null };
      const amount = p.amountMinor ? formatInr(BigInt(String(p.amountMinor))) : "an unreadable amount";
      if (f.classification === "CONFLICTING") return "Records the bank figure as contradicting evidence on the existing transaction and marks it disputed. The recorded amount is not overwritten.";
      if (p.existingTransactionId) return `Marks the recorded ${amount} transaction as confirmed by the bank and links this statement as a source.`;
      const counter = cp.entityId ? labels.get(cp.entityId) ?? "the account" : `a new account ${cp.value ?? ""}${cp.bank ? ` (${cp.bank})` : ""}`;
      return p.direction === "DEBIT" ? `Adds ${counter} and an onward transfer of ${amount} from ${labels.get(String(p.subjectEntityId)) ?? "the account"}. Does not change held or returned amounts.` : `Adds a credit of ${amount} from ${counter}.`;
    }
    case "HOLD_STATUS":
      return p.amountMinor ? `Records ${formatInr(BigInt(String(p.amountMinor)))} as held in ${labels.get(String(p.accountEntityId)) ?? "the account"} (bank-confirmed). This changes the secured amount.` : "Records the account as restricted with the held amount unknown.";
    case "KYC_RECORD":
      return `Adds ${p.holderName} as account holder on record for ${labels.get(String(p.accountEntityId)) ?? "the account"}. This is a registration record, not a finding of involvement.`;
    case "SUBSCRIBER_RECORD":
      return `Adds ${p.holderName} as the subscriber on record of ${labels.get(String(p.phoneEntityId)) ?? "the number"}${p.address ? `, with the address on the CAF` : ""}. A name on a CAF is not proof of who used the number.`;
    case "RELATIONSHIP":
      return p.relType === "CONTACTED"
        ? `Records that ${(p.from as { value?: string })?.value ?? "the number"} was in contact with ${labels.get(String(p.toEntityId)) ?? "the number"}, as the call records show.`
        : `Links ${(p.from as { value?: string })?.value ?? "the identifier"} to ${labels.get(String(p.toEntityId)) ?? "the account"} as the record states.`;
    case "LOCATION_OBSERVATION":
      return `Adds a historical location observation (${p.observationType === "IP_LOGIN" ? "login record" : p.observationType === "CELL_SITE" ? "cell used, location of the tower not yet known" : "KYC address"}). It is not a current location.`;
    case "BALANCE_REPORTED":
      return "Marks the balance item as answered. No funds are recorded as secured.";
    case "ITEM_NOT_PROVIDED":
    case "BALANCE_UNCONFIRMED":
      return "Keeps the item open on the request checklist. No facts change.";
    default:
      return "Recorded for reference only.";
  }
}

/** Each reply's own reference: RES- and its request's reference, "-2", "-3" for later replies to the same request. */
export async function responseRefsFor(db: Db, responses: { id: string; requestId: string | null; request: { reference: string } | null }[]): Promise<Map<string, string>> {
  const requestIds = [...new Set(responses.map((r) => r.requestId).filter((x): x is string => !!x))];
  const out = new Map<string, string>();
  if (!requestIds.length) return out;
  const all = await db.response.findMany({ where: { requestId: { in: requestIds } }, select: { id: true, requestId: true, receivedAt: true }, orderBy: [{ receivedAt: "asc" }, { id: "asc" }] });
  const refOf = new Map(responses.filter((r) => r.request && r.requestId).map((r) => [r.requestId!, r.request!.reference]));
  const seen = new Map<string, number>();
  for (const x of all) {
    const n = (seen.get(x.requestId!) ?? 0) + 1;
    seen.set(x.requestId!, n);
    const ref = refOf.get(x.requestId!);
    if (ref) out.set(x.id, responseRef(ref, n, getAppConfig().requests.referencePrefix));
  }
  return out;
}

export async function getResponseReview(db: Db, user: SessionUser, responseId: string) {
  const r = await db.response.findUnique({
    where: { id: responseId },
    include: { case: true, request: { include: { recipient: true, items: { orderBy: { sortOrder: "asc" } }, subjects: { include: { entity: true } } } }, findings: { orderBy: { sortOrder: "asc" } }, attachments: { include: { segments: { orderBy: [{ row: "asc" }, { line: "asc" }] } } } },
  });
  if (!r) throw notFoundError("response");
  if (r.caseId) await loadCaseForUser(db, user, r.caseId, "read");
  else if (user.role !== "SUPERVISOR") throw notFoundError("response");
  const entities = r.caseId ? await db.entity.findMany({ where: { caseId: r.caseId }, select: { id: true, label: true } }) : [];
  const labels = new Map(entities.map((e) => [e.id, e.label]));
  const users = await db.user.findMany({ select: { id: true, displayName: true, rank: true } });
  const who = (id: string | null) => {
    const u = users.find((x) => x.id === id);
    return u ? `${shortRank(u.rank)} ${u.displayName}` : null;
  };
  const candidates = r.caseId
    ? await db.request.findMany({ where: { caseId: r.caseId, status: { in: ["SUBMITTED", "ACKNOWLEDGED", "PARTIAL_RESPONSE", "COMPLETE_RESPONSE"] } }, include: { recipient: true, versions: { orderBy: { versionNo: "desc" }, take: 1 } }, orderBy: { reference: "asc" } })
    : [];
  const senderDomain = (r.fromAddress.split("@")[1] ?? "").toLowerCase();
  const ownRef = r.matchStatus === "MATCHED" ? ((await responseRefsFor(db, [r])).get(r.id) ?? null) : null;
  return {
    id: r.id,
    /** RES-412/2026-002 once the reply is matched to its request. */
    reference: ownRef,
    version: r.version,
    caseId: r.caseId,
    caseReference: r.case ? caseReference(r.case) : null,
    fromAddress: r.fromAddress,
    toAddress: r.toAddress,
    subject: r.subject,
    receivedAt: r.receivedAt.toISOString(),
    bodyText: r.bodyText,
    channel: r.channel,
    matchStatus: r.matchStatus,
    matchBasis: r.matchBasis,
    reviewStatus: r.reviewStatus,
    suggestedType: r.suggestedType,
    responseType: r.responseType,
    appliedAt: r.appliedAt?.toISOString() ?? null,
    appliedBy: who(r.appliedById),
    messageEvidenceId: r.messageEvidenceId,
    request: r.request
      ? {
          id: r.request.id,
          reference: r.request.reference,
          status: r.request.status,
          category: r.request.category,
          recipient: r.request.recipient.organisation,
          subjects: r.request.subjects.map((s) => s.entity.label),
          items: r.request.items.map((i) => ({ id: i.id, label: i.label, status: i.status, note: i.note })),
        }
      : null,
    attachments: r.attachments
      .filter((a) => a.id !== r.messageEvidenceId)
      .map((a) => ({
        id: a.id,
        title: a.title,
        fileName: a.fileName,
        mimeType: a.mimeType,
        processingStatus: a.processingStatus,
        processingNote: a.processingNote,
        sha256: a.sha256,
        rows: a.mimeType === "text/csv" ? a.segments.map((s) => ({ row: s.row ?? 0, cells: s.text.split(" | ") })) : null,
        lines: a.mimeType !== "text/csv" ? a.segments.map((s) => ({ line: s.line ?? 0, text: s.text })) : null,
      })),
    findings: r.findings.map((f) => ({
      id: f.id,
      findingType: f.findingType,
      classification: f.classification,
      classificationNote: f.classificationNote,
      summary: f.summary,
      preview: previewFor(f, labels),
      payload: JSON.parse(f.editedPayloadJson ?? f.payloadJson) as Record<string, unknown>,
      edited: !!f.editedPayloadJson,
      evidenceId: f.evidenceId,
      locator: f.locator,
      excerpt: f.excerpt,
      row: f.row,
      line: f.line,
      decision: f.decision,
      decisionReason: f.decisionReason,
      decidedBy: who(f.decidedById),
      appliedAt: f.appliedAt?.toISOString() ?? null,
    })),
    matchCandidates: candidates
      .map((c) => ({ id: c.id, reference: c.reference, recipient: c.recipient.organisation, subject: c.versions[0]?.subject ?? "", sameSender: (c.recipient.address.split("@")[1] ?? "").toLowerCase() === senderDomain }))
      .sort((a, b) => Number(b.sameSender) - Number(a.sameSender)),
  };
}

export type ResponseReview = Awaited<ReturnType<typeof getResponseReview>>;
