"use client";

import { autoDraftMessage } from "@/lib/auto-draft-message";
import Link from "next/link";
import { useMemo, useState } from "react";
import { FileText, Paperclip } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmationDialog } from "@/components/ui/dialog";
import { FormField, Select } from "@/components/ui/field";
import { InlineAlert } from "@/components/ui/feedback";
import { StatusBadge } from "@/components/app/status-badge";
import { DateTime } from "@/components/app/datetime";
import { useServerAction } from "@/features/shared/use-action";
import { applyResponseAction, confirmMatchAction } from "@/features/requests/actions";
import type { ResponseReview } from "@/server/services/correspondence";
import { cn } from "@/lib/cn";
import { FindingCard } from "./finding-card";

type Finding = ResponseReview["findings"][number];
const TYPE_OPTIONS = [
  { value: "ACKNOWLEDGEMENT", label: "Acknowledgement only (not a reply)" },
  { value: "PARTIAL", label: "Partial response (request stays open)" },
  { value: "COMPLETE", label: "Complete response" },
  { value: "REJECTION", label: "Rejected by the recipient" },
] as const;

export function ResponseReviewWorkspace({ r }: { r: ResponseReview }) {
  const [highlight, setHighlight] = useState<{ findingId: string; evidenceId: string | null; row: number | null; line: number | null } | null>(null);
  const [responseType, setResponseType] = useState<string>(r.reviewStatus === "APPLIED" ? r.responseType : (r.suggestedType ?? "PARTIAL"));
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [matchId, setMatchId] = useState<string>(r.request?.id ?? r.matchCandidates.find((c) => c.sameSender)?.id ?? "");
  const apply = useServerAction(applyResponseAction);
  const match = useServerAction(confirmMatchAction);
  const [outcome, setOutcome] = useState<{ applied: number; followUpRequestId: string | null } | null>(null);

  const counts = useMemo(() => {
    const c = { accepted: 0, rejected: 0, deferred: 0, pending: 0, applied: 0 };
    for (const f of r.findings) {
      if (f.appliedAt) c.applied++;
      else if (f.decision === "ACCEPTED" || f.decision === "EDITED") c.accepted++;
      else if (f.decision === "REJECTED") c.rejected++;
      else if (f.decision === "DEFERRED") c.deferred++;
      else c.pending++;
    }
    return c;
  }, [r.findings]);
  const financialChange = r.findings.some((f) => !f.appliedAt && (f.decision === "ACCEPTED" || f.decision === "EDITED") && f.findingType === "HOLD_STATUS");
  const matched = r.matchStatus === "MATCHED";
  const showSource = (f: Finding) => {
    setHighlight({ findingId: f.id, evidenceId: f.evidenceId, row: f.row, line: f.line });
    const target = f.row ? `att-${f.evidenceId}-row-${f.row}` : f.line ? (f.evidenceId === r.messageEvidenceId ? `msg-line-${f.line}` : `att-${f.evidenceId}-line-${f.line}`) : null;
    if (target) document.getElementById(target)?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
  };
  const isHighlighted = (evidenceId: string | null, kind: "row" | "line", n: number) => !!highlight && highlight.evidenceId === evidenceId && (kind === "row" ? highlight.row === n : highlight.line === n);

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-12">
      {/* Original material */}
      <section aria-labelledby="original-title" className="panel min-w-0 self-start xl:sticky xl:top-[72px] xl:col-span-6 xl:max-h-[calc(100dvh-88px)] xl:overflow-y-auto">
        <div className="border-b border-line px-5 py-3.5">
          <h2 id="original-title" className="text-section font-semibold tracking-tight text-ink">
            Original Message
          </h2>
          <p className="mt-0.5 text-label text-ink-2">Preserved exactly as received. Treated as untrusted data; nothing in it is executed.</p>
        </div>
        <dl className="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1.5 border-b border-line px-5 py-3 text-body">
          <dt className="text-ink-3">From</dt>
          <dd className="break-all text-ink">{r.fromAddress}</dd>
          <dt className="text-ink-3">Subject</dt>
          <dd className="text-ink">{r.subject}</dd>
          <dt className="text-ink-3">Received</dt>
          <dd className="text-ink">
            <DateTime iso={r.receivedAt} />
          </dd>
        </dl>
        <div className="px-5 py-4">
          <ol className="font-mono text-label leading-relaxed text-ink">
            {r.bodyText.split(/\r?\n/).map((line, i) => (
              <li key={i} id={`msg-line-${i + 1}`} className={cn("grid grid-cols-[2rem_1fr] gap-2 rounded-[2px]", isHighlighted(r.messageEvidenceId, "line", i + 1) && "bg-warning-tint")}>
                <span aria-hidden="true" className="select-none text-right text-ink-3">
                  {i + 1}
                </span>
                <span className="whitespace-pre-wrap break-words">{line || " "}</span>
              </li>
            ))}
          </ol>
          {r.messageEvidenceId && r.caseId ? (
            <Link href={`/cases/${r.caseId}/evidence/${r.messageEvidenceId}`} className="mt-3 inline-flex items-center gap-1.5 text-label font-medium text-action hover:underline">
              <FileText aria-hidden="true" className="size-3.5" />
              Open stored original (.eml) with integrity details
            </Link>
          ) : null}
        </div>
        {r.attachments.map((a) => (
          <div key={a.id} className="border-t border-line px-5 py-4">
            <div className="flex flex-wrap items-center gap-2">
              <Paperclip aria-hidden="true" className="size-4 text-ink-3" />
              <Link href={`/cases/${r.caseId}/evidence/${a.id}`} className="text-body font-medium text-action hover:underline">
                {a.fileName}
              </Link>
              <StatusBadge kind="processing" value={a.processingStatus} />
            </div>
            <p className="mt-1 text-meta text-ink-3">
              SHA-256 <span className="font-mono">{a.sha256.slice(0, 16)}…</span>
            </p>
            {a.processingNote ? <p className="mt-1 text-label text-ink-2">{a.processingNote}</p> : null}
            {a.rows ? (
              <div className="mt-3 overflow-x-auto rounded-[var(--radius-control)] border border-line">
                <table className="w-full min-w-[640px] border-collapse text-left text-label">
                  <caption className="sr-only">Rows of {a.fileName}</caption>
                  <tbody>
                    {a.rows.map((row) => (
                      <tr key={row.row} id={`att-${a.id}-row-${row.row}`} className={cn("border-b border-line last:border-b-0", row.row === 1 && "bg-surface-muted font-medium", isHighlighted(a.id, "row", row.row) && "bg-warning-tint")}>
                        <th scope="row" className="w-10 px-2 py-1.5 text-right font-normal text-ink-3">
                          {row.row}
                        </th>
                        {row.cells.map((cell, i) => (
                          <td key={i} className="whitespace-nowrap px-2 py-1.5 text-ink">
                            {cell}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : a.lines && a.lines.length ? (
              <ol className="mt-3 font-mono text-label leading-relaxed text-ink">
                {a.lines.map((l) => (
                  <li key={l.line} id={`att-${a.id}-line-${l.line}`} className={cn("grid grid-cols-[2rem_1fr] gap-2", isHighlighted(a.id, "line", l.line) && "bg-warning-tint")}>
                    <span aria-hidden="true" className="select-none text-right text-ink-3">
                      {l.line}
                    </span>
                    <span className="whitespace-pre-wrap break-words">{l.text}</span>
                  </li>
                ))}
              </ol>
            ) : null}
          </div>
        ))}
      </section>

      {/* Extracted results and proposed changes */}
      <section aria-labelledby="results-title" className="flex min-w-0 flex-col gap-4 xl:col-span-6">
        {!matched ? (
          <div className="panel-raised p-5">
            <h2 className="text-section font-semibold tracking-tight text-ink">Confirm Which Request This Message Answers</h2>
            <p className="mt-1 text-body text-ink-2">{r.matchBasis}</p>
            <p className="mt-1 text-label text-ink-3">Uncertain matches are never applied automatically.</p>
            {r.matchCandidates.length ? (
              <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
                <FormField label="Request" className="flex-1">
                  <Select value={matchId} onChange={(e) => setMatchId(e.target.value)}>
                    <option value="">Choose a request</option>
                    {r.matchCandidates.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.reference}, {c.recipient}
                        {c.sameSender ? " (same sender domain)" : ""}
                      </option>
                    ))}
                  </Select>
                </FormField>
                <Button variant="primary" loading={match.pending} onClick={() => (matchId ? match.run([r.id, matchId], { success: "Message matched to the request" }) : undefined)}>
                  Confirm match
                </Button>
              </div>
            ) : (
              <InlineAlert tone="warning" className="mt-4">
                No submitted request in this case could have produced this message.
              </InlineAlert>
            )}
          </div>
        ) : null}

        <div className="panel">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-3.5">
            <div>
              <h2 id="results-title" className="text-section font-semibold tracking-tight text-ink">
                Results to Review
              </h2>
              <p className="mt-0.5 text-label text-ink-2">Read by T-CYBER&apos;s rules from the message and attachments. Each is applied only if you accept it.</p>
            </div>
            <p className="text-label text-ink-2">
              {counts.accepted} accepted, {counts.rejected} rejected, {counts.deferred} deferred, {counts.pending} not reviewed
              {counts.applied ? `, ${counts.applied} applied` : ""}
            </p>
          </div>
          <div className="flex flex-col gap-3 p-4">
            {r.findings.length ? (
              r.findings.map((f) => <FindingCard key={f.id} f={f} onShowSource={showSource} highlighted={highlight?.findingId === f.id} readOnly={!matched} />)
            ) : (
              <p className="px-1 py-4 text-body text-ink-2">{matched ? "No facts were recognised in this message. If it is an acknowledgement, record it as one below; otherwise review the original manually." : "Results appear after the message is matched to a request."}</p>
            )}
          </div>
        </div>

        {matched && r.request ? (
          <div className="panel-raised p-5">
            <h2 className="text-section font-semibold tracking-tight text-ink">Apply Reviewed Results</h2>
            {outcome ? (
              <InlineAlert tone="success" className="mt-3" title={`${outcome.applied} ${outcome.applied === 1 ? "result" : "results"} applied`}>
                The case, graph, tasks and activity log are updated.{" "}
                {outcome.followUpRequestId ? (
                  <Link href={`/cases/${r.caseId}/requests/${outcome.followUpRequestId}`} className="font-medium text-action underline">
                    Open the follow-up draft
                  </Link>
                ) : null}
              </InlineAlert>
            ) : null}
            <div className="mt-3 flex flex-col gap-3">
              <FormField label="Record this response as" hint={r.suggestedType ? `Suggested from the checklist: ${r.suggestedType.toLowerCase()}. An acknowledgement never completes a request.` : undefined}>
                <Select value={responseType} onChange={(e) => setResponseType(e.target.value)}>
                  {TYPE_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              </FormField>
              <p className="text-label text-ink-2">
                {financialChange ? "An accepted hold confirmation will change the secured amount." : "Holds and refunds will not change: no accepted result confirms funds."} Unreviewed and deferred results stay pending.
              </p>
              <div>
                <Button variant="primary" onClick={() => setConfirmOpen(true)}>
                  Apply reviewed results
                </Button>
              </div>
            </div>
            <ConfirmationDialog
              open={confirmOpen}
              onOpenChange={setConfirmOpen}
              title={`Apply ${counts.accepted} accepted ${counts.accepted === 1 ? "result" : "results"} to ${r.request.reference}?`}
              description={`The response will be recorded as ${TYPE_OPTIONS.find((o) => o.value === responseType)?.label.toLowerCase()}. Changes are applied in one transaction and recorded in the activity log.`}
              confirmLabel="Apply results"
              onConfirm={async () => {
                const res = await apply.run([r.id, responseType as "ACKNOWLEDGEMENT" | "PARTIAL" | "COMPLETE" | "REJECTION", r.version], { success: (d) => autoDraftMessage("Reviewed results applied", d.autoDraft) });
                if (res.ok) setOutcome({ applied: res.data.applied, followUpRequestId: res.data.followUpRequestId });
                return res.ok;
              }}
            >
              <ul className="list-disc space-y-1 pl-5 text-body text-ink-2">
                <li>{counts.accepted} accepted, {counts.rejected} rejected (recorded, not applied)</li>
                <li>{counts.pending + counts.deferred} not reviewed or deferred (stay pending)</li>
                <li>{financialChange ? "The secured amount will change from the accepted hold confirmation." : "No change to held or returned amounts."}</li>
              </ul>
            </ConfirmationDialog>
          </div>
        ) : null}
      </section>
    </div>
  );
}
