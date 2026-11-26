"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useState } from "react";
import { PenLine } from "lucide-react";
import { Button, IconButton } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { FormField, Textarea } from "@/components/ui/field";
import { InlineAlert } from "@/components/ui/feedback";
import { EmptyState } from "@/components/app/states";
import { formatDateIST, formatDateTimeIST, formatTimeIST } from "@/domain/time";
import { useServerAction } from "@/features/shared/use-action";
import { recordCorrectionAction } from "@/features/activity/actions";
import { cn } from "@/lib/cn";
import type { ActivityEntry } from "@/server/services/activity";

const OPEN_LABELS: Record<string, string> = {
  Case: "Open overview",
  Request: "Open request",
  Response: "Open response",
  EvidenceItem: "Open evidence",
  Task: "Open next action",
  Hold: "Open holds",
  Allocation: "Open holds",
  Refund: "Open returns",
  Transaction: "Open funds",
  VictimClaim: "Open funds",
  Entity: "Open record",
  Relationship: "Open identifiers",
  LocationObservation: "Open identifiers",
  Report: "Open report",
};

function CorrectionDialog({ caseId, entry, onClose }: { caseId: string; entry: ActivityEntry | null; onClose: () => void }) {
  const [text, setText] = useState("");
  const save = useServerAction(recordCorrectionAction);
  const close = () => {
    setText("");
    save.reset();
    onClose();
  };
  return (
    <Dialog open={!!entry} onOpenChange={(o) => !o && !save.pending && close()}>
      {entry ? (
        <DialogContent
          title="Record a correction"
          description={
            <>
              Entry of {formatDateTimeIST(new Date(entry.at))}: “{entry.summary}”
            </>
          }
          footer={
            <>
              <Button variant="secondary" onClick={close} disabled={save.pending}>
                Cancel
              </Button>
              <Button variant="primary" loading={save.pending} onClick={() => save.run([caseId, entry.id, text], { success: "Correction recorded", onSuccess: close })}>
                Record correction
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-4">
            <InlineAlert tone="info">The original entry stays in the history exactly as it is. Your correction is added as a new entry, linked to it, with your name and the time.</InlineAlert>
            {save.error && !save.fieldErrors.text ? <InlineAlert tone="danger">{save.error}</InlineAlert> : null}
            <FormField label="Correction" required error={save.fieldErrors.text} hint="Say what was wrong and what is correct, in at least 10 characters." validate={(v) => (v.trim().length < 10 ? "Describe the correction in at least 10 characters." : null)}>
              <Textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} maxLength={1000} />
            </FormField>
          </div>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

export function ActivityFeed({ caseId, events, filtered, nextCursor, isFirstPage }: { caseId: string; events: ActivityEntry[]; filtered: boolean; nextCursor: string | null; isFirstPage: boolean }) {
  const pathname = usePathname();
  const params = useSearchParams();
  const [target, setTarget] = useState<ActivityEntry | null>(null);
  const withCursor = (cursor: string | null) => {
    const next = new URLSearchParams(params.toString());
    if (cursor) next.set("cursor", cursor);
    else next.delete("cursor");
    return `${pathname}${next.size ? `?${next}` : ""}`;
  };

  if (!events.length) {
    return (
      <div className="panel mt-4">
        {filtered ? (
          <EmptyState
            title="No entries match these filters"
            description="Try a different kind of change or search term."
            action={
              <Button asChild variant="secondary">
                <Link href={pathname}>Clear all filters</Link>
              </Button>
            }
          />
        ) : (
          <EmptyState title="Nothing recorded yet" description="Every change to this case, approval, submission and financial update will be listed here as it happens." />
        )}
      </div>
    );
  }

  const groups: { day: string; entries: ActivityEntry[] }[] = [];
  for (const e of events) {
    const day = formatDateIST(new Date(e.at));
    const last = groups.at(-1);
    if (last?.day === day) last.entries.push(e);
    else groups.push({ day, entries: [e] });
  }

  return (
    <>
      <div className="panel mt-4 overflow-hidden">
        {groups.map((g, gi) => (
          <section key={`${g.day}-${gi}`} aria-labelledby={`day-${gi}`}>
            <h2 id={`day-${gi}`} className={`${gi ? "border-t" : ""} border-b border-line bg-surface-muted px-5 py-2 text-label font-semibold text-ink-2`}>
              {g.day}
            </h2>
            <ol className="divide-y divide-line">
              {g.entries.map((e) => (
                <li key={e.id} id={`entry-${e.id}`} className="flex scroll-mt-28 gap-3 px-4 py-3 target:bg-action-tint sm:gap-4 sm:px-5">
                  <time dateTime={e.at} className="hidden w-[4.5rem] shrink-0 pt-0.5 text-label tabular-nums text-ink-2 sm:block">
                    {formatTimeIST(new Date(e.at))}
                  </time>
                  <div className="min-w-0 flex-1">
                    {/* Officers' steps carry the page; automatic updates stay readable but secondary. */}
                    <p className={cn("break-words text-body", e.actor ? "text-ink" : "text-ink-2")}>{e.summary}</p>
                    <p className="mt-0.5 text-label text-ink-3">
                      <span className="tabular-nums sm:hidden">{formatTimeIST(new Date(e.at))}, </span>
                      {e.actor ? e.actor.name : "Automatic update"}, {e.categoryLabel.toLowerCase()}
                      {e.href && OPEN_LABELS[e.objectType] ? (
                        <>
                          {". "}
                          <Link href={e.href} className="font-medium text-action hover:underline">
                            {OPEN_LABELS[e.objectType]}
                          </Link>
                        </>
                      ) : null}
                    </p>
                    {e.corrects ? (
                      <p className="mt-1.5 text-label text-ink-2">
                        Corrects the entry of{" "}
                        <a href={`#entry-${e.corrects.id}`} className="font-medium text-action hover:underline">
                          {formatDateTimeIST(new Date(e.corrects.at))}
                        </a>
                        : “{e.corrects.summary}”
                      </p>
                    ) : null}
                    {e.correctedBy.map((c) => (
                      <p key={c.id} className="mt-2 rounded-[var(--radius-control)] border-l-2 border-[rgb(138_83_0/0.5)] bg-warning-tint px-3 py-2 text-label text-ink">
                        <span className="font-medium">Corrected</span> by {c.actorName},{" "}
                        <a href={`#entry-${c.id}`} className="text-action hover:underline">
                          {formatDateTimeIST(new Date(c.at))}
                        </a>
                        . This entry is kept as it was recorded.
                      </p>
                    ))}
                  </div>
                  <IconButton label="Record a correction" onClick={() => setTarget(e)}>
                    <PenLine aria-hidden="true" />
                  </IconButton>
                </li>
              ))}
            </ol>
          </section>
        ))}
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        {!isFirstPage ? (
          <Button asChild variant="ghost">
            <Link href={withCursor(null)}>Show the newest entries</Link>
          </Button>
        ) : (
          <span />
        )}
        {nextCursor ? (
          <Button asChild variant="secondary">
            <Link href={withCursor(nextCursor)}>Show older entries</Link>
          </Button>
        ) : (
          <p className="text-label text-ink-3">This is the start of the case history.</p>
        )}
      </div>
      <CorrectionDialog caseId={caseId} entry={target} onClose={() => setTarget(null)} />
    </>
  );
}
