import Link from "next/link";
import { Inbox, Mail } from "lucide-react";
import { cn } from "@/lib/cn";
import { REQUEST_CATEGORY_LABELS } from "@/lib/labels";
import { DataTable } from "./data-table";
import { StatusBadge, Tag } from "./status-badge";
import { DateTime } from "./datetime";
import { EmptyState } from "./states";
import { FilterBar } from "./filter-bar";
import { RevealStrip } from "./reveal-strip";
import { VIEWS, type CorrespondenceView as View } from "@/server/services/correspondence";
import type { listCorrespondence } from "@/server/services/correspondence";

type Data = Awaited<ReturnType<typeof listCorrespondence>>;

/**
 * One implementation for case Requests and global Correspondence. `caseId` scopes it to a case;
 * without it the view spans every case the officer may access.
 */
export function CorrespondenceViewPanel({ data, view, basePath, q, caseId }: { data: Data; view: View; basePath: string; q?: string; caseId?: string }) {
  const returnTo = `${basePath}?view=${view}${q ? `&q=${encodeURIComponent(q)}` : ""}`;
  const withReturn = (href: string) => `${href}?returnTo=${encodeURIComponent(returnTo)}`;
  const views = Object.entries(VIEWS) as [View, (typeof VIEWS)[View]][];
  return (
    <div className="flex flex-col gap-4">
      <RevealStrip label="Correspondence views" revealKey={view} className="overflow-x-auto border-b border-line">
        <ul className="flex min-w-max gap-6">
          {views.map(([key, v]) => (
            <li key={key}>
              <Link
                href={`${basePath}?view=${key}${q ? `&q=${encodeURIComponent(q)}` : ""}`}
                aria-current={view === key ? "page" : undefined}
                className={cn(
                  "relative inline-flex h-10 items-center gap-1.5 text-body font-medium",
                  view === key ? "text-action after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:rounded-full after:bg-action" : "text-ink-2 hover:text-ink",
                )}
              >
                {v.label}
                <span className={cn("inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-meta font-semibold tabular-nums", view === key ? "bg-action-tint text-action" : "bg-surface-sunken text-ink-2")}>{data.counts[key]}</span>
              </Link>
            </li>
          ))}
        </ul>
      </RevealStrip>
      <FilterBar searchLabel={view === "inbox" ? "Search messages" : "Search requests"} searchHint={view === "inbox" ? "Sender, subject or text" : "Reference, subject or recipient"} />
      {view === "inbox" ? (
        <DataTable
          caption="Incoming responses"
          rows={data.responses}
          rowKey={(r) => r.id}
          rowHref={(r) => withReturn(`/cases/${r.caseId}/responses/${r.id}`)}
          minWidth={860}
          cardBelow="md"
          mobileCard={(r) => (
            <span className="flex flex-col gap-1">
              <span className="flex items-start justify-between gap-3">
                <span className="min-w-0 font-medium text-ink">{r.subject}</span>
                <StatusBadge kind={r.matchStatus === "MATCHED" ? "review" : "match"} value={r.matchStatus === "MATCHED" ? r.reviewStatus : r.matchStatus} />
              </span>
              <span className="text-label text-ink-2">{r.fromAddress}</span>
              <span className="text-meta text-ink-3">
                <DateTime iso={r.receivedAt} />
                {r.requestReference ? `, ${r.requestReference}` : ""}
              </span>
            </span>
          )}
          columns={[
            {
              key: "subject",
              header: "Message",
              cell: (r) => (
                <span className="flex min-w-0 flex-col">
                  <span className="max-w-[32ch] truncate" title={r.subject}>{r.subject}</span>
                  <span className="text-label font-normal text-ink-2">{r.fromAddress}</span>
                </span>
              ),
            },
            ...(caseId ? [] : [{ key: "case", header: "Case", cell: (r: Data["responses"][number]) => <span className="whitespace-nowrap text-ink-2">{r.caseReference}</span> }]),
            { key: "req", header: "Reference", cell: (r) => (r.requestReference ? <span className="whitespace-nowrap">{r.reference ?? r.requestReference}{r.reference ? <span className="block text-meta text-ink-3">reply to {r.requestReference}</span> : null}</span> : <span className="text-ink-3">Not matched</span>) },
            {
              key: "status",
              header: "Status",
              cell: (r) => (
                <span className="flex flex-col items-start gap-1">
                  <StatusBadge kind={r.matchStatus === "MATCHED" ? "review" : "match"} value={r.matchStatus === "MATCHED" ? r.reviewStatus : r.matchStatus} />
                  {r.reviewStatus === "APPLIED" ? <Tag>{r.responseType.toLowerCase().replace(/^\w/, (c) => c.toUpperCase())}</Tag> : r.suggestedType ? <Tag>Suggested: {r.suggestedType.toLowerCase()}</Tag> : null}
                  <span className="text-meta text-ink-3">
                    {r.findings} result{r.findings === 1 ? "" : "s"}
                  </span>
                </span>
              ),
            },
            { key: "received", header: "Received", cell: (r) => <DateTime iso={r.receivedAt} className="text-ink-2" /> },
          ]}
          empty={
            <EmptyState
              icon={<Inbox aria-hidden="true" />}
              title={q ? "No messages match this search" : "No incoming responses"}
              description={q ? "Try another sender or subject, or clear the search." : "Replies to submitted requests appear here for review. Nothing is applied to a case until an officer reviews it."}
              action={
                q ? (
                  <Link href={`${basePath}?view=inbox`} className="inline-flex h-10 items-center rounded-[var(--radius-control)] border border-line-input bg-surface px-4 text-body font-medium text-ink hover:bg-surface-muted">
                    Clear search
                  </Link>
                ) : undefined
              }
            />
          }
        />
      ) : (
        <DataTable
          caption="Requests"
          rows={data.requests}
          rowKey={(r) => r.id}
          rowHref={(r) => withReturn(`/cases/${r.caseId}/requests/${r.id}`)}
          minWidth={920}
          cardBelow="md"
          mobileCard={(r) => (
            <span className="flex flex-col gap-1">
              <span className="flex items-start justify-between gap-3">
                <span className="font-semibold text-ink">{r.reference}</span>
                <StatusBadge kind="request" value={r.status} />
              </span>
              <span className="text-body text-ink-2">{r.subject}</span>
              <span className="text-meta text-ink-3">
                {r.recipient}, {r.itemsReceived} of {r.itemsTotal} items received
              </span>
            </span>
          )}
          columns={[
            { key: "ref", header: "Reference", cell: (r) => <span className="whitespace-nowrap font-semibold">{r.reference}</span> },
            {
              key: "subject",
              header: "Subject and recipient",
              cell: (r) => (
                <span className="flex min-w-0 flex-col">
                  <span className={cn("truncate", caseId ? "max-w-[30ch]" : "max-w-[24ch]")} title={r.subject}>{r.subject}</span>
                  <span className="text-label text-ink-2">
                    {r.recipient}
                    {!r.recipientVerified ? <span className="ml-1.5 font-medium text-warning">(recipient not verified)</span> : null}
                  </span>
                </span>
              ),
            },
            ...(caseId ? [] : [{ key: "case", header: "Case", cell: (r: Data["requests"][number]) => <span className="whitespace-nowrap text-ink-2">{r.caseReference}</span> }]),
            { key: "cat", header: "Type", hideBelow: "lg", cell: (r) => <span className="text-ink-2">{REQUEST_CATEGORY_LABELS[r.category] ?? r.category}</span> },
            {
              key: "status",
              header: "Status",
              cell: (r) => (
                <span className="flex flex-col items-start gap-1">
                  <StatusBadge kind="request" value={r.status} />
                  {r.needsReview ? <span className="text-meta font-medium text-warning">Needs renewed review</span> : null}
                  {r.responsesToReview ? <span className="text-meta font-medium text-warning">Response to review</span> : null}
                </span>
              ),
            },
            { key: "items", header: "Received", align: "right", cell: (r) => <span className="whitespace-nowrap text-ink-2">{r.itemsReceived} of {r.itemsTotal}</span> },
            { key: "follow", header: "Follow-up", hideBelow: "lg", cell: (r) => <DateTime iso={r.followUpAt} mode="date" className="text-ink-2" fallback="Not set" /> },
          ]}
          empty={
            <EmptyState
              icon={<Mail aria-hidden="true" />}
              title={q ? "No requests match this search" : `No requests in "${VIEWS[view].label}"`}
              description={q ? "Try another reference or recipient, or clear the search." : caseId ? "Prepare requests from the case's next actions. Each draft needs approval before it can be submitted." : "Requests from all your cases appear here by status."}
              action={
                caseId && !q ? (
                  <Link href={`/cases/${caseId}/actions`} className="inline-flex h-10 items-center rounded-[var(--radius-control)] bg-action px-4 text-body font-medium text-white hover:bg-action-hover">
                    Open next actions
                  </Link>
                ) : q ? (
                  <Link href={`${basePath}?view=${view}`} className="inline-flex h-10 items-center rounded-[var(--radius-control)] border border-line-input bg-surface px-4 text-body font-medium text-ink hover:bg-surface-muted">
                    Clear search
                  </Link>
                ) : undefined
              }
            />
          }
        />
      )}
    </div>
  );
}
