import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/server/auth/current-user";
import { getDb } from "@/server/db";
import { orNotFound } from "@/server/not-found";
import { getHandover } from "@/server/services/reports";
import { PageBody, PageHeader, Panel } from "@/components/app/page";
import { LedgerStatement } from "@/components/app/ledger-statement";
import { StatusBadge, Tag } from "@/components/app/status-badge";
import { DateTime } from "@/components/app/datetime";
import { CreateReportButton } from "@/features/activity/components/create-report-button";

export const metadata: Metadata = { title: "Handover" };

export default async function HandoverPage({ params }: { params: Promise<{ caseId: string }> }) {
  const user = await requireUser();
  const { caseId } = await params;
  const h = await orNotFound(getHandover(getDb(), user, caseId));
  const base = `/cases/${caseId}`;

  return (
    <PageBody>
      <PageHeader
        title="Handover"
        description="What an officer taking over needs to pick up, live from the case records: unresolved leads, pending requests and responses waiting for review."
        actions={<CreateReportButton caseId={caseId} kind="HANDOVER" label="Create handover note" variant="primary" />}
      />

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-12">
        <div className="flex min-w-0 flex-col gap-6 lg:col-span-8">
          <Panel id="leads" title={`Unresolved leads (${h.leads.length})`} description="Open next actions and the question each one is trying to answer." bodyClassName="p-0">
            {h.leads.length ? (
              <ul className="divide-y divide-line">
                {h.leads.map((t) => (
                  <li key={t.id} className="flex flex-col gap-1 px-5 py-3.5">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <Link href={`${base}/actions?task=${t.id}`} className="min-w-0 text-body font-medium text-action hover:underline">
                        {t.title}
                      </Link>
                      {t.priority === "HIGH" || t.status !== "OPEN" ? (
                        <div className="flex shrink-0 flex-wrap gap-1.5">
                          {t.priority === "HIGH" ? <Tag tone="warning">High priority</Tag> : null}
                          {/* Every lead here is unresolved; only a status other than Open adds information. */}
                          {t.status !== "OPEN" ? <StatusBadge kind="task" value={t.status} /> : null}
                        </div>
                      ) : null}
                    </div>
                    <p className="text-body text-ink-2">{t.question}</p>
                    {t.assignee || t.deferredUntil ? (
                      <p className="text-label text-ink-3">
                        {t.assignee ? `Assigned to ${t.assignee}` : null}
                        {t.assignee && t.deferredUntil ? ". " : null}
                        {t.deferredUntil ? (
                          <>
                            Deferred until <DateTime iso={t.deferredUntil} mode="date" />
                          </>
                        ) : null}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-5 py-6 text-body text-ink-2">No unresolved leads are recorded.</p>
            )}
          </Panel>

          <Panel id="pending" title={`Pending requests (${h.pendingRequests.length})`} description="Drafts, requests awaiting approval and requests waiting for a full response." bodyClassName="p-0">
            {h.pendingRequests.length ? (
              <ul className="divide-y divide-line">
                {h.pendingRequests.map((r) => (
                  <li key={r.id} className="flex flex-col gap-1 px-5 py-3.5 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                    <div className="min-w-0">
                      <Link href={`${base}/requests/${r.id}`} className="text-body font-medium text-action hover:underline">
                        {r.reference}
                      </Link>
                      <span className="text-body text-ink-2"> to {r.recipient}</span>
                      {r.subject ? <p className="truncate text-label text-ink-3">{r.subject}</p> : null}
                      {r.followUpAt ? (
                        <p className={r.followUpDue ? "text-label font-medium text-warning" : "text-label text-ink-3"}>
                          {r.followUpDue ? "Follow-up was due " : "Follow-up due "}
                          <DateTime iso={r.followUpAt} mode="date" />
                        </p>
                      ) : null}
                      {r.needsReview ? <p className="text-label font-medium text-warning">Its sources changed; review the draft before sending.</p> : null}
                    </div>
                    <StatusBadge kind="request" value={r.status} className="self-start" />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-5 py-6 text-body text-ink-2">No requests are pending.</p>
            )}
          </Panel>
        </div>

        <div className="flex min-w-0 flex-col gap-6 lg:col-span-4">
          <Panel title="Money Position" description="From the funds ledger. Unknown amounts are not counted as ₹0.">
            <LedgerStatement l={h.money} />
          </Panel>
          <Panel title={`Responses waiting for review (${h.responsesToReview.length})`} bodyClassName="p-0">
            {h.responsesToReview.length ? (
              <ul className="divide-y divide-line">
                {h.responsesToReview.map((r) => (
                  <li key={r.id} className="flex flex-col gap-0.5 px-5 py-3.5">
                    <Link href={`${base}/responses/${r.id}`} className="break-words text-body font-medium text-action hover:underline">
                      {r.subject}
                    </Link>
                    <span className="break-words text-label text-ink-2">From {r.from}</span>
                    <span className="text-label text-ink-3">
                      Received <DateTime iso={r.receivedAt} />
                    </span>
                    {r.needsMatch ? <span className="text-label font-medium text-warning">Which request it answers is not yet confirmed.</span> : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-5 py-6 text-body text-ink-2">No responses are waiting.</p>
            )}
          </Panel>
          <Panel title="Identifiers">
            <p className="text-body text-ink">
              {h.unverifiedIdentifiers} identifier{h.unverifiedIdentifiers === 1 ? " is" : "s are"} not yet verified.
            </p>
            <Link href={`${base}/people`} className="mt-2 inline-block text-body font-medium text-action hover:underline">
              Open identifiers and locations
            </Link>
          </Panel>
        </div>
      </div>
    </PageBody>
  );
}
