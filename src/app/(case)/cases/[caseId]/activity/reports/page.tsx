import type { Metadata } from "next";
import { requireUser } from "@/server/auth/current-user";
import { getDb } from "@/server/db";
import { orNotFound } from "@/server/not-found";
import { REPORT_KINDS, REPORT_KIND_DESCRIPTIONS, listReports, type ReportKind } from "@/server/services/reports";
import { PageBody, PageHeader, Panel } from "@/components/app/page";
import { DataTable } from "@/components/app/data-table";
import { StatusBadge } from "@/components/app/status-badge";
import { DateTime } from "@/components/app/datetime";
import { EmptyState } from "@/components/app/states";
import { CreateReportButton } from "@/features/activity/components/create-report-button";

export const metadata: Metadata = { title: "Reports" };

const ACTION_LABELS: Record<ReportKind, string> = { CASE_SUMMARY: "Draft case summary", CASE_DIARY: "Draft case diary", HANDOVER: "Draft handover note" };

export default async function ReportsPage({ params }: { params: Promise<{ caseId: string }> }) {
  const user = await requireUser();
  const { caseId } = await params;
  const reports = await orNotFound(listReports(getDb(), user, caseId));
  type Row = (typeof reports)[number];

  return (
    <PageBody>
      <PageHeader title="Reports" description="Drafts are prepared from the case records, with numbered links to their sources. An officer reviews each version; every edit is saved as a new version and earlier versions are kept." />

      <Panel className="mt-6" title="Draft a Report" description="A draft states only what the case records show. Review it before relying on it." bodyClassName="p-0">
        <ul className="divide-y divide-line">
          {(Object.keys(REPORT_KINDS) as ReportKind[]).map((kind) => (
            <li key={kind} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="text-body font-medium text-ink">{REPORT_KINDS[kind]}</p>
                <p className="max-w-[70ch] text-label text-ink-2">{REPORT_KIND_DESCRIPTIONS[kind]}</p>
              </div>
              <CreateReportButton caseId={caseId} kind={kind} label={ACTION_LABELS[kind]} />
            </li>
          ))}
        </ul>
      </Panel>

      <h2 className="mt-8 text-section font-semibold tracking-tight text-ink">Saved Reports</h2>
      <DataTable<Row>
        className="mt-3"
        caption="Saved reports"
        rows={reports}
        rowKey={(r) => r.id}
        rowHref={(r) => `/cases/${caseId}/activity/reports/${r.id}`}
        minWidth={760}
        empty={<EmptyState compact title="No reports saved yet" description="Draft a case summary, a case diary or a handover note above; it opens for review straight away." />}
        columns={[
          { key: "title", header: "Report", cell: (r) => <span className="font-medium text-ink">{r.title}</span> },
          { key: "kind", header: "Kind", hideBelow: "md", cell: (r) => r.kindLabel },
          { key: "status", header: "Status", cell: (r) => <StatusBadge kind="report" value={r.status} /> },
          { key: "version", header: "Version", align: "right", cell: (r) => <span className="tabular-nums">{r.latestVersion}</span> },
          {
            key: "saved",
            header: "Last saved",
            hideBelow: "lg",
            cell: (r) => (
              <span className="text-ink-2">
                <DateTime iso={r.updatedAt} />
                {r.updatedBy ? <span className="block text-label text-ink-3">{r.updatedBy}</span> : null}
              </span>
            ),
          },
        ]}
        mobileCard={(r) => (
          <div className="flex flex-col gap-1">
            <div className="flex items-start justify-between gap-3">
              <span className="text-body font-medium text-ink">{r.title}</span>
              <StatusBadge kind="report" value={r.status} />
            </div>
            <span className="text-label text-ink-2">
              Version {r.latestVersion}, saved <DateTime iso={r.updatedAt} />
            </span>
          </div>
        )}
      />
    </PageBody>
  );
}
