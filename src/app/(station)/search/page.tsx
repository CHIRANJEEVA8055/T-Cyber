import type { Metadata } from "next";
import Link from "next/link";
import { Search } from "lucide-react";
import { requireCaseWorker } from "@/server/auth/current-user";
import { getDb } from "@/server/db";
import { searchRecords } from "@/server/services/search";
import { PageBody, PageHeader, Panel } from "@/components/app/page";
import { StatusBadge } from "@/components/app/status-badge";
import { EmptyState } from "@/components/app/states";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "Search" };

export default async function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const user = await requireCaseWorker();
  const { q = "" } = await searchParams;
  const results = q.trim() ? await searchRecords(getDb(), user, q) : null;
  const total = results ? results.cases.length + results.records.length + results.evidence.length + results.requests.length : 0;

  return (
    <PageBody>
      <PageHeader title="Search" description="Searches only the cases you may open: case details, recorded accounts, identifiers and people, the text of stored documents, and requests." />
      <form action="/search" method="get" role="search" className="mt-6 flex max-w-2xl flex-col gap-2 sm:flex-row sm:items-end">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <label htmlFor="search-q" className="text-label font-medium text-ink">
            Search for
          </label>
          <div className="relative">
            <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-3" />
            <input
              id="search-q"
              name="q"
              type="search"
              defaultValue={q}
              placeholder="e.g. FIR 1/2026, 0937 or REQ-412/2026-002"
              className="h-11 w-full rounded-[var(--radius-control)] border border-line-input bg-surface pl-9 pr-3 text-body text-ink shadow-[inset_0_1px_2px_rgba(0,0,0,0.03)] placeholder:text-ink-3 focus-visible:border-focus focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[rgb(40_102_197/0.25)]"
            />
          </div>
        </div>
        <Button type="submit" variant="primary" className="h-11">
          Search
        </Button>
      </form>

      {!results ? null : results.tooShort ? (
        <p className="mt-6 text-body text-ink-2">Type at least two characters to search.</p>
      ) : total === 0 ? (
        <div className="panel mt-6">
          <EmptyState title={`No matches for “${results.query}” in your cases`} description="Try part of an account number, a phone number, a name or a request reference. Cases you are not assigned to are not searched." />
        </div>
      ) : (
        <div className="mt-6 flex flex-col gap-6">
          <p className="text-label text-ink-2" aria-live="polite">
            {total} match{total === 1 ? "" : "es"} for “{results.query}”.
          </p>
          {results.cases.length ? (
            <Panel title={`Cases (${results.cases.length})`} bodyClassName="p-0">
              <ul className="divide-y divide-line">
                {results.cases.map((c) => (
                  <li key={c.id} className="flex items-center justify-between gap-3 px-5 py-3">
                    <Link href={c.href} className="min-w-0 text-body text-action hover:underline">
                      <span className="font-medium">{c.reference}</span>: {c.title}
                    </Link>
                    <StatusBadge kind="case" value={c.status} />
                  </li>
                ))}
              </ul>
            </Panel>
          ) : null}
          {results.records.length ? (
            <Panel title={`Accounts, identifiers and people (${results.records.length})`} bodyClassName="p-0">
              <ul className="divide-y divide-line">
                {results.records.map((r) => (
                  <li key={r.id} className="flex flex-col gap-0.5 px-5 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                    <div className="min-w-0">
                      <Link href={r.href} className="text-body font-medium text-action hover:underline">
                        {r.label}
                      </Link>
                      <p className="text-label text-ink-3">
                        {r.kind}
                        {r.value !== r.label ? <>, <span className="font-mono">{r.value}</span></> : null}. {r.caseReference}.
                      </p>
                    </div>
                    <Link href={r.graphHref} className="shrink-0 text-label font-medium text-action hover:underline">
                      Show in the graph
                    </Link>
                  </li>
                ))}
              </ul>
            </Panel>
          ) : null}
          {results.evidence.length ? (
            <Panel title={`Text in documents (${results.evidence.length})`} bodyClassName="p-0">
              <ul className="divide-y divide-line">
                {results.evidence.map((e) => (
                  <li key={e.id} className="flex flex-col gap-1 px-5 py-3">
                    <Link href={e.href} className="text-body font-medium text-action hover:underline">
                      {e.evidenceTitle}
                      {e.locator ? `, ${e.locator}` : ""}
                    </Link>
                    <p className="break-words font-mono text-label text-ink-2">
                      {e.excerpt.before}
                      <mark className="rounded-[2px] bg-warning-tint px-0.5 text-ink">{e.excerpt.match}</mark>
                      {e.excerpt.after}
                    </p>
                    <p className="text-label text-ink-3">{e.caseReference}</p>
                  </li>
                ))}
              </ul>
            </Panel>
          ) : null}
          {results.requests.length ? (
            <Panel title={`Requests (${results.requests.length})`} bodyClassName="p-0">
              <ul className="divide-y divide-line">
                {results.requests.map((r) => (
                  <li key={r.id} className="flex flex-col gap-1 px-5 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                    <div className="min-w-0">
                      <Link href={r.href} className="text-body font-medium text-action hover:underline">
                        {r.reference}
                      </Link>
                      <p className="truncate text-label text-ink-2">{r.subject}</p>
                      <p className="text-label text-ink-3">
                        To {r.recipient}. {r.caseReference}.
                      </p>
                    </div>
                    <StatusBadge kind="request" value={r.status} className="self-start sm:self-center" />
                  </li>
                ))}
              </ul>
            </Panel>
          ) : null}
        </div>
      )}
    </PageBody>
  );
}
