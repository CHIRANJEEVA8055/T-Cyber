import type { Metadata } from "next";
import Link from "next/link";
import { FileSearch } from "lucide-react";
import { requireUser } from "@/server/auth/current-user";
import { getDb } from "@/server/db";
import { orNotFound } from "@/server/not-found";
import { listEvidence } from "@/server/services/evidence-views";
import { PageBody, Panel } from "@/components/app/page";
import { FilterBar } from "@/components/app/filter-bar";
import { DataTable } from "@/components/app/data-table";
import { StatusBadge, Tag } from "@/components/app/status-badge";
import { DateTime } from "@/components/app/datetime";
import { EmptyState } from "@/components/app/states";
import { UploadEvidenceButton } from "@/features/evidence/components/upload-drawer";
import { DERIVATION_LABELS, EVIDENCE_CATEGORY_LABELS } from "@/lib/labels";

export const metadata: Metadata = { title: "Evidence" };

const size = (b: number) => (b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

export default async function EvidencePage({ params, searchParams }: { params: Promise<{ caseId: string }>; searchParams: Promise<{ q?: string; category?: string; derivation?: string }> }) {
  const user = await requireUser();
  const { caseId } = await params;
  const sp = await searchParams;
  const { items, hits } = await orNotFound(listEvidence(getDb(), user, caseId, sp));
  const filtered = !!(sp.category || sp.derivation);
  return (
    <PageBody>
      <div className="mb-5 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-title font-semibold tracking-tight text-ink">Evidence</h1>
          <p className="mt-1 max-w-[75ch] text-body text-ink-2">Originals are kept unchanged with their SHA-256 hash and processing history. Extracted text, annotations and assistant summaries are labelled separately from originals.</p>
        </div>
        <UploadEvidenceButton caseId={caseId} />
      </div>
      <FilterBar
        searchLabel="Search document text"
        searchHint="Words, numbers or references in extracted text"
        selects={[
          { param: "category", label: "Kind", allValue: "", options: [{ value: "", label: "All kinds" }, ...Object.entries(EVIDENCE_CATEGORY_LABELS).map(([value, label]) => ({ value, label }))] },
          { param: "derivation", label: "Original or derived", allValue: "", options: [{ value: "", label: "All" }, { value: "ORIGINAL", label: "Originals only" }, { value: "DERIVED", label: "Derived only" }] },
        ]}
      />
      {sp.q ? (
        <Panel className="mt-5" title={`Text matches for "${sp.q}"`} description={hits.length ? `${hits.length} ${hits.length === 1 ? "line" : "lines"} found in extracted text` : undefined} bodyClassName="p-0">
          {hits.length ? (
            <ul className="divide-y divide-line">
              {hits.map((h, i) => {
                const qs = new URLSearchParams();
                if (h.page) qs.set("page", String(h.page));
                if (h.line) qs.set("line", String(h.line));
                if (h.row) qs.set("row", String(h.row));
                return (
                  <li key={i}>
                    <Link href={`/cases/${caseId}/evidence/${h.evidenceId}?${qs}`} className="block px-5 py-3 hover:bg-surface-muted">
                      <span className="text-label font-medium text-action">
                        {h.evidenceTitle}, {h.row ? `row ${h.row}` : `${h.page ? `p. ${h.page}, ` : ""}line ${h.line}`}
                      </span>
                      <span className="mt-0.5 block font-mono text-label text-ink">{h.text}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          ) : (
            <EmptyState compact title="No extracted text matches" description="Scanned images and unsupported files have no extracted text, so they cannot be searched. Check their originals directly." />
          )}
        </Panel>
      ) : null}
      <DataTable
        className="mt-5"
        caption="Evidence items"
        rows={items}
        rowKey={(r) => r.id}
        rowHref={(r) => `/cases/${caseId}/evidence/${r.id}`}
        minWidth={900}
        cardBelow="md"
        mobileCard={(r) => (
          <span className="flex flex-col gap-1">
            <span className="font-medium text-ink">{r.title}</span>
            <span className="flex flex-wrap gap-1.5">
              <StatusBadge kind="processing" value={r.processingStatus} />
              {r.derivation !== "ORIGINAL" ? <Tag tone="warning">{DERIVATION_LABELS[r.derivation]}</Tag> : null}
            </span>
            <span className="text-meta text-ink-3">
              Received <DateTime iso={r.receivedAt} mode="date" />
            </span>
          </span>
        )}
        columns={[
          {
            key: "title",
            header: "Document",
            cell: (r) => (
              <span className="flex min-w-0 flex-col">
                <span className="max-w-[32ch] truncate">{r.title}</span>
                <span className="max-w-[32ch] truncate text-label font-normal text-ink-3">{r.parentTitle ? `Derived from ${r.parentTitle}` : r.fileName}</span>
              </span>
            ),
          },
          {
            key: "kind",
            header: "Kind",
            cell: (r) => (
              <span className="flex flex-col items-start gap-1">
                <span className="whitespace-nowrap text-ink-2">{EVIDENCE_CATEGORY_LABELS[r.category] ?? r.category}</span>
                {r.derivation !== "ORIGINAL" ? <Tag tone={r.derivation === "AI_SUMMARY" ? "warning" : "neutral"}>{DERIVATION_LABELS[r.derivation]}</Tag> : <Tag>Original</Tag>}
              </span>
            ),
          },
          {
            // Processing, extraction review and citations share one column so the table fits a 1280px screen.
            key: "status",
            header: "Processing and review",
            cell: (r) => (
              <span className="flex flex-col items-start gap-1">
                <StatusBadge kind="processing" value={r.processingStatus} />
                {r.pendingCandidates ? <span className="whitespace-nowrap text-label font-medium text-warning">{r.pendingCandidates} to review</span> : <StatusBadge kind="evidenceReview" value={r.reviewStatus} />}
                <span className="text-meta text-ink-3">{r.citedBy ? `Cited by ${r.citedBy} ${r.citedBy === 1 ? "fact" : "facts"}` : "Not cited by any fact"}</span>
              </span>
            ),
          },
          { key: "received", header: "Received", cell: (r) => <DateTime iso={r.receivedAt} mode="date" className="text-ink-2" /> },
          {
            key: "hash",
            header: "SHA-256",
            hideBelow: "lg",
            cell: (r) => (
              <span className="flex flex-col">
                <span className="font-mono text-label text-ink-2">{r.sha256.slice(0, 12)}…</span>
                <span className="text-meta text-ink-3">{size(r.sizeBytes)}</span>
              </span>
            ),
          },
        ]}
        empty={
          filtered ? (
            <EmptyState
              icon={<FileSearch aria-hidden="true" />}
              title="No documents match these filters"
              description="Clear the filters to see every document in this case."
              action={
                <Link href={`/cases/${caseId}/evidence`} className="inline-flex h-10 items-center rounded-[var(--radius-control)] border border-line-input bg-surface px-4 text-body font-medium text-ink hover:bg-surface-muted">
                  Clear all filters
                </Link>
              }
            />
          ) : (
            <EmptyState icon={<FileSearch aria-hidden="true" />} title="No evidence yet" description="Upload the FIR copy, receipts or bank replies. Each original is hashed and kept unchanged." action={<UploadEvidenceButton caseId={caseId} />} />
          )
        }
      />
    </PageBody>
  );
}
