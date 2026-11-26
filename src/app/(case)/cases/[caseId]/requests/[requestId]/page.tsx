import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, FileText } from "lucide-react";
import { requireUser } from "@/server/auth/current-user";
import { getDb } from "@/server/db";
import { AppError } from "@/server/errors";
import { getRequestDetail } from "@/server/services/correspondence";
import { isEditableStatus } from "@/domain/request-workflow";
import { PageBody, Panel, DefinitionList } from "@/components/app/page";
import { StatusBadge, Tag } from "@/components/app/status-badge";
import { DateTime } from "@/components/app/datetime";
import { channelText, ITEM_TYPE_LABELS, REQUEST_CATEGORY_LABELS } from "@/lib/labels";
import { cn } from "@/lib/cn";
import { RequestEditor } from "@/features/requests/components/request-editor";
import { WorkflowPanel } from "@/features/requests/components/workflow-panel";
import { RequestNoteForm } from "@/features/requests/components/request-notes";
import { OpenMailButton } from "@/features/requests/components/open-mail";

export const metadata: Metadata = { title: "Request" };

function safeReturn(value: string | undefined, fallback: string) {
  return value && value.startsWith("/") && !value.startsWith("//") ? value : fallback;
}

export default async function RequestPage({ params, searchParams }: { params: Promise<{ caseId: string; requestId: string }>; searchParams: Promise<{ returnTo?: string }> }) {
  const user = await requireUser();
  const { caseId, requestId } = await params;
  const { returnTo } = await searchParams;
  let d;
  try {
    d = await getRequestDetail(getDb(), user, requestId);
  } catch (err) {
    if (err instanceof AppError && err.code === "NOT_FOUND") notFound();
    throw err;
  }
  if (d.caseId !== caseId) notFound();
  const back = safeReturn(returnTo, `/cases/${caseId}/requests`);
  const backLabel = back.startsWith("/correspondence") ? "Back to correspondence" : back.includes("/actions") || back.includes("/investigation") ? "Back to next actions" : back === `/cases/${caseId}` ? "Back to overview" : "Back to requests";
  const editable = isEditableStatus(d.status);
  const evidenceTitle = (id: string) => d.evidence.find((e) => e.id === id)?.title ?? "Evidence item";

  return (
    <PageBody>
      <Link href={back} className="inline-flex items-center gap-1.5 text-label font-medium text-action hover:underline">
        <ArrowLeft aria-hidden="true" className="size-4" />
        {backLabel}
      </Link>
      <div className="mt-3 flex flex-col gap-2 border-b border-line pb-5">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-title font-semibold tracking-tight text-ink">{d.reference}</h2>
          <StatusBadge kind="request" value={d.status} />
          <Tag>{REQUEST_CATEGORY_LABELS[d.category] ?? d.category}</Tag>
          {d.parent ? <Tag tone="info">Follow-up to {d.parent.reference}</Tag> : null}
          {d.legacyReference ? <Tag>{["DRAFT", "AWAITING_APPROVAL", "APPROVED", "SUBMISSION_FAILED", "DISCARDED"].includes(d.status) ? `Earlier ${d.legacyReference}` : `Sent as ${d.legacyReference}`}</Tag> : null}
          {d.gmail.on && d.status !== "DISCARDED" ? (
            <span className="ml-auto">
              <OpenMailButton requestId={d.id} label={editable ? "Open the mail" : "Open the sent mail"} />
            </span>
          ) : null}
        </div>
        <p className="text-body text-ink-2">
          To {d.recipient.name}, {channelText(d.channel, d.gmail)}. Version {d.currentVersionNo} by {d.current.author}, <DateTime iso={d.current.createdAt} />.
        </p>
        {d.task ? (
          <p className="text-label text-ink-3">
            Prepared from the next action: <span className="text-ink-2">{d.task.title}</span>
          </p>
        ) : null}
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-12">
        <div className="flex min-w-0 flex-col gap-6 lg:col-span-8">
          <Panel id="content" title={editable ? "Draft" : `Submitted content (version ${d.approvedVersionNo ?? d.currentVersionNo})`} description={editable ? "Edit the recipient, From address, scope, period, items, text, closing and attachments. Each save is a new version." : "Exactly what was approved and submitted. Sent requests cannot be edited."}>
            {editable ? (
              <RequestEditor d={d} />
            ) : (
              <div className="flex flex-col gap-4">
                <DefinitionList
                  items={[
                    {
                      term: d.sentTo ? "Sent to" : "To",
                      value: (
                        <>
                          {d.recipient.name}
                          <span className="block break-all text-label text-ink-2">{d.sentTo?.address ?? d.recipient.address}</span>
                          {d.sentTo && d.sentTo.address !== d.recipient.address ? (
                            <span className="block text-label text-warning">The directory address has since changed to {d.recipient.address}.</span>
                          ) : null}
                        </>
                      ),
                    },
                    { term: d.sentTo ? "Sent from" : "From", value: <span className="break-all">{d.current.fromAddress}</span> },
                    { term: "Subject", value: d.current.subject },
                    { term: "Scope", value: d.current.scope, wide: true },
                    { term: "Period", value: d.current.periodFrom ? <><DateTime iso={d.current.periodFrom} mode="date" /> to <DateTime iso={d.current.periodTo} mode="date" /></> : "Not limited to a period" },
                    { term: "Attachments", value: d.current.attachmentIds.length ? d.current.attachmentIds.map((id) => evidenceTitle(id)).join(", ") : "None" },
                  ]}
                />
                <div className="rounded-[var(--radius-control)] border border-line bg-surface-muted p-4">
                  <p className="whitespace-pre-wrap text-body leading-relaxed text-ink">{d.current.body}</p>
                </div>
              </div>
            )}
          </Panel>

          <Panel id="thread" title="History" description="Versions, approvals, submissions, responses and notes, oldest first." bodyClassName="px-5 py-4">
            <ol className="relative flex flex-col gap-4 border-l border-line-strong pl-5">
              {d.thread.map((t, i) => (
                <li key={i} className="relative">
                  <span aria-hidden="true" className={cn("absolute -left-[26px] top-1.5 size-2.5 rounded-full border-2 border-surface", t.tone === "danger" ? "bg-danger" : t.tone === "success" ? "bg-success" : t.tone === "warning" ? "bg-[#c07a1c]" : "bg-ink-3")} />
                  <p className="text-body font-medium text-ink">
                    {t.href ? (
                      <Link href={t.href} className="text-action hover:underline">
                        {t.title}
                      </Link>
                    ) : (
                      t.title
                    )}
                  </p>
                  {t.detail ? <p className="mt-0.5 whitespace-pre-wrap text-body text-ink-2">{t.detail}</p> : null}
                  <p className="mt-0.5 text-meta text-ink-3">
                    <DateTime iso={t.at} />
                    {t.actor ? `, ${t.actor}` : ""}
                  </p>
                </li>
              ))}
            </ol>
            <div className="mt-5 border-t border-line pt-4">
              <RequestNoteForm requestId={d.id} />
            </div>
          </Panel>
        </div>

        <div className="order-first flex min-w-0 flex-col gap-6 lg:order-none lg:col-span-4">
          <Panel id="workflow" title="Workflow" className="panel-raised">
            <WorkflowPanel d={d} userRole={user.role} />
          </Panel>

          <Panel id="checklist" title="Requested and Received" description="Updated only from reviewed responses" bodyClassName="p-0">
            <ul className="divide-y divide-line">
              {d.items.map((i) => (
                <li key={i.id} className="flex items-start justify-between gap-3 px-5 py-3">
                  <div className="min-w-0">
                    <p className="text-body text-ink">{i.label}</p>
                    <p className="text-meta text-ink-3">
                      {ITEM_TYPE_LABELS[i.itemType] ?? i.itemType}
                      {i.note ? `: ${i.note}` : ""}
                    </p>
                  </div>
                  <StatusBadge kind="item" value={i.status} />
                </li>
              ))}
            </ul>
          </Panel>

          <Panel id="details" title="Routing and Approval">
            <DefinitionList
              columns={1}
              items={[
                { term: "Route", value: d.route ? d.route.name : "Chosen manually" },
                ...(d.route ? [{ term: "Procedure note", value: <span className="text-label text-ink-2">{d.route.procedureNote}</span> }] : []),
                { term: "Recipient verification", value: <StatusBadge kind="verification" value={d.recipient.verificationStatus} /> },
                { term: "Approval", value: d.activeApproval ? <>Version {d.activeApproval.versionNo}, {d.activeApproval.by}, <DateTime iso={d.activeApproval.at} /></> : "Not approved" },
                { term: "Content fingerprint", value: <span className="font-mono text-label">{d.contentHash.slice(0, 16)}</span> },
                ...(d.externalReference ? [{ term: "External reference", value: <span className="font-mono text-label">{d.externalReference}</span> }] : []),
                { term: "About this subject", value: d.subjects.length ? d.subjects.map((s) => `${s.label} (${s.value})`).join(", ") : "No identifier linked" },
              ]}
            />
            {d.children.length ? (
              <p className="mt-3 text-label text-ink-2">
                Follow-up {d.children.length === 1 ? "request" : "requests"}:{" "}
                {d.children.map((c, i) => (
                  <span key={c.id}>
                    {i ? ", " : ""}
                    <Link href={`/cases/${caseId}/requests/${c.id}`} className="font-medium text-action hover:underline">
                      {c.reference}
                    </Link>
                  </span>
                ))}
              </p>
            ) : null}
            <p className="mt-3 flex items-start gap-1.5 text-meta text-ink-3">
              <FileText aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
              Routes and recipients are a configurable local directory, not independently verified universal rules.
            </p>
          </Panel>
        </div>
      </div>
    </PageBody>
  );
}
