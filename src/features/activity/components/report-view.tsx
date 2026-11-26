"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { CheckCheck, Download, FilePen, Printer, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmationDialog } from "@/components/ui/dialog";
import { FormField, Input, Textarea } from "@/components/ui/field";
import { InlineAlert } from "@/components/ui/feedback";
import { PageHeader, Panel } from "@/components/app/page";
import { StatusBadge } from "@/components/app/status-badge";
import { DateTime } from "@/components/app/datetime";
import { cn } from "@/lib/cn";
import { useServerAction } from "@/features/shared/use-action";
import { useUnsavedGuard } from "@/features/shared/use-unsaved-guard";
import { markReportReviewedAction, regenerateReportAction, saveReportEditAction } from "@/features/activity/actions";
import type { ReportDetail } from "@/server/services/reports";
import { ReportBody, ReportSources } from "./report-body";

function ReportEditor({ d, onClose }: { d: ReportDetail; onClose: (saved: boolean) => void }) {
  const storageKey = `tcyber:report:${d.report.id}:v${d.report.latestVersion}`;
  const [body, setBody] = useState(d.version.body);
  const [note, setNote] = useState("");
  const [restoredAt, setRestoredAt] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const save = useServerAction(saveReportEditAction);
  const dirty = body !== d.version.body || note.trim() !== "";
  const { dialog } = useUnsavedGuard(dirty && !save.pending);
  const forget = () => {
    try {
      window.localStorage.removeItem(storageKey);
    } catch {
      /* storage unavailable */
    }
  };

  // Restore edits kept in this browser for this exact version.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) return;
      const stored = JSON.parse(raw) as { body: string; note: string; savedAt: string };
      if (stored.body !== d.version.body || stored.note) {
        // Browser storage is only readable after hydration, so restoring must happen in an effect.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setBody(stored.body);
        setNote(stored.note);
        setRestoredAt(stored.savedAt);
      }
    } catch {
      /* storage unavailable: editing still works */
    }
  }, [storageKey, d.version.body]);

  useEffect(() => {
    const t = setTimeout(() => {
      try {
        if (dirty) window.localStorage.setItem(storageKey, JSON.stringify({ body, note, savedAt: new Date().toISOString() }));
        else window.localStorage.removeItem(storageKey);
      } catch {
        /* ignore */
      }
    }, 600);
    return () => clearTimeout(t);
  }, [body, note, dirty, storageKey]);

  const next = d.report.latestVersion + 1;
  return (
    <div className="panel flex flex-col gap-4 p-5">
      {dialog}
      {restoredAt ? (
        <InlineAlert
          tone="info"
          title="Unsaved edits restored from this browser"
          action={
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setBody(d.version.body);
                setNote("");
                setRestoredAt(null);
                forget();
              }}
            >
              Discard restored edits
            </Button>
          }
        >
          These edits were made earlier and not saved. Save them as version {next} or discard them.
        </InlineAlert>
      ) : null}
      {save.error && !save.fieldErrors.body && !save.fieldErrors.changeNote ? <InlineAlert tone="danger">{save.error}</InlineAlert> : null}
      <FormField label="Report text" required error={save.fieldErrors.body} validate={(v) => (v.trim() ? null : "The report cannot be empty.")} hint="Lines starting with “## ” are headings and lines starting with “- ” are list items. Keep a marker such as [S2] beside a statement to keep its link to the source.">
        <Textarea rows={22} value={body} onChange={(e) => setBody(e.target.value)} className="leading-relaxed" />
      </FormField>
      <FormField label="What changed" required error={save.fieldErrors.changeNote} validate={(v) => (v.trim().length < 3 ? "Say briefly what you changed." : null)} hint="Saved with the new version, for example “Added the call to Demo Bank B on 21 Oct”.">
        <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
      </FormField>
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="secondary" onClick={() => (dirty ? setConfirmDiscard(true) : onClose(false))} disabled={save.pending}>
          Cancel
        </Button>
        <Button
          variant="primary"
          loading={save.pending}
          onClick={() =>
            save.run([d.report.id, { body, changeNote: note, expectedVersion: d.report.latestVersion }], {
              success: `Saved as version ${next}`,
              onSuccess: () => {
                forget();
                onClose(true);
              },
            })
          }
        >
          Save as version {next}
        </Button>
      </div>
      <ConfirmationDialog
        open={confirmDiscard}
        onOpenChange={setConfirmDiscard}
        title={`Discard your changes to the ${d.report.kindLabel.toLowerCase()}?`}
        description={`Version ${d.report.latestVersion} stays as it is.`}
        confirmLabel="Discard changes"
        tone="danger"
        onConfirm={() => {
          forget();
          onClose(false);
        }}
      />
    </div>
  );
}

export function ReportView({ d }: { d: ReportDetail }) {
  const router = useRouter();
  const pathname = usePathname();
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState<null | "review" | "redraft">(null);
  const review = useServerAction(markReportReviewedAction);
  const redraft = useServerAction(regenerateReportAction);
  const v = d.version;
  const isLatest = v.versionNo === d.report.latestVersion;
  const kind = d.report.kindLabel.toLowerCase();
  const pdfHref = `/api/reports/${d.report.id}/pdf?version=${v.versionNo}`;

  return (
    <>
      <PageHeader
        className="no-print"
        title={d.report.title}
        meta={
          <div className="flex flex-wrap items-center gap-2 text-label text-ink-2">
            <StatusBadge kind="report" value={isLatest ? d.report.status : v.reviewedAt ? "REVIEWED" : "DRAFT"} />
            <span>
              Version {v.versionNo} of {d.report.latestVersion}, {v.generated ? "drafted from case records" : "edited"} by {v.createdBy}, <DateTime iso={v.createdAt} />
            </span>
          </div>
        }
        actions={
          isLatest && !editing ? (
            <>
              <Button variant="secondary" icon={<FilePen aria-hidden="true" />} onClick={() => setEditing(true)}>
                Edit report
              </Button>
              {!v.reviewedAt ? (
                <Button variant="primary" icon={<CheckCheck aria-hidden="true" />} onClick={() => setConfirm("review")}>
                  Mark version {v.versionNo} as reviewed
                </Button>
              ) : null}
            </>
          ) : null
        }
      />

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-12">
        <div className="min-w-0 lg:col-span-8">
          {!isLatest ? (
            <InlineAlert
              className="no-print mb-4"
              tone="info"
              title={`You are viewing version ${v.versionNo}`}
              action={
                <Button asChild size="sm" variant="secondary">
                  <Link href={pathname}>Open the latest version</Link>
                </Button>
              }
            >
              The latest is version {d.report.latestVersion}. Earlier versions are kept exactly as they were saved.
            </InlineAlert>
          ) : null}
          {editing ? (
            <ReportEditor
              d={d}
              onClose={(saved) => {
                setEditing(false);
                if (saved) router.replace(pathname);
              }}
            />
          ) : (
            <article className="panel px-5 py-6 sm:px-8 print:border-0 print:px-0 print:py-0">
              <div className="print-only mb-6 border-b border-line pb-3 text-label text-ink-2">
                <p className="text-heading font-semibold text-ink">{d.report.title}</p>
                <p>
                  Version {v.versionNo}, saved <DateTime iso={v.createdAt} /> by {v.createdBy}. {v.reviewedAt ? <>Reviewed by {v.reviewedBy} on <DateTime iso={v.reviewedAt} />.</> : "Not yet reviewed by an officer."}
                </p>
                <p>Demonstration environment: all names, accounts and records are synthetic.</p>
              </div>
              <ReportBody body={v.body} sources={v.sources} />
              <ReportSources sources={v.sources} />
            </article>
          )}
        </div>

        <aside className="no-print flex min-w-0 flex-col gap-4 lg:col-span-4" aria-label="Report details">
          <Panel title="This Version">
            <dl className="flex flex-col gap-2 text-body">
              <div>
                <dt className="text-label text-ink-3">Saved</dt>
                <dd className="text-ink">
                  <DateTime iso={v.createdAt} /> by {v.createdBy}
                </dd>
              </div>
              <div>
                <dt className="text-label text-ink-3">How it was made</dt>
                <dd className="text-ink">{v.generated ? "Drafted from the case records; not yet checked unless reviewed below." : `Edited by an officer: ${v.changeNote ?? "no note"}`}</dd>
              </div>
              <div>
                <dt className="text-label text-ink-3">Review</dt>
                <dd className="text-ink">
                  {v.reviewedAt ? (
                    <>
                      Reviewed by {v.reviewedBy} on <DateTime iso={v.reviewedAt} />
                    </>
                  ) : (
                    "Not yet reviewed"
                  )}
                </dd>
              </div>
            </dl>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" icon={<Printer aria-hidden="true" />} onClick={() => window.print()}>
                Print
              </Button>
              <Button asChild variant="secondary" size="sm">
                <a href={pdfHref} download data-allow-unsaved="true">
                  <Download aria-hidden="true" className="size-4" />
                  Download PDF
                </a>
              </Button>
              {isLatest && !editing ? (
                <Button variant="ghost" size="sm" icon={<RefreshCw aria-hidden="true" />} onClick={() => setConfirm("redraft")}>
                  Redraft from current records
                </Button>
              ) : null}
            </div>
          </Panel>

          <Panel title="Versions" description="Each save is kept. Review applies to one exact version." bodyClassName="p-0">
            <ol className="divide-y divide-line">
              {d.versions.map((x) => (
                <li key={x.versionNo}>
                  <Link
                    href={x.versionNo === d.report.latestVersion ? pathname : `${pathname}?version=${x.versionNo}`}
                    aria-current={x.versionNo === v.versionNo ? "page" : undefined}
                    className={cn("flex flex-col gap-0.5 px-5 py-3 hover:bg-surface-muted", x.versionNo === v.versionNo && "bg-action-tint")}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="text-body font-medium text-ink">Version {x.versionNo}</span>
                      {x.reviewedAt ? <StatusBadge kind="report" value="REVIEWED" /> : null}
                    </span>
                    <span className="text-label text-ink-2">{x.generated ? "Drafted from case records" : x.changeNote}</span>
                    <span className="text-label text-ink-3">
                      {x.createdBy}, <DateTime iso={x.createdAt} />
                    </span>
                  </Link>
                </li>
              ))}
            </ol>
          </Panel>
        </aside>
      </div>

      <ConfirmationDialog
        open={confirm === "review"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={`Mark version ${v.versionNo} of the ${kind} as reviewed?`}
        description="Confirm that you have read this version and checked it against the case records. A later edit starts a new, unreviewed version."
        confirmLabel="Mark as reviewed"
        onConfirm={async () => (await review.run([d.report.id, v.versionNo], { success: `Version ${v.versionNo} marked as reviewed` })).ok}
      />
      <ConfirmationDialog
        open={confirm === "redraft"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={`Redraft the ${kind} from the current records?`}
        description={`This saves version ${d.report.latestVersion + 1}, drafted from the records as they are now. Every earlier version, including officers' edits, stays in the history.`}
        confirmLabel="Redraft as a new version"
        onConfirm={async () => {
          const r = await redraft.run([d.report.id, d.report.latestVersion], { success: `Version ${d.report.latestVersion + 1} drafted` });
          if (r.ok) router.replace(pathname);
          return r.ok;
        }}
      />
    </>
  );
}
