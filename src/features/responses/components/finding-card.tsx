"use client";

import { useState } from "react";
import { Check, Pause, PencilLine, X } from "lucide-react";
import { formatInr, minorFromString, parseRupeesToMinor } from "@/domain/money";
import { istInputToUtc, utcToIstInput } from "@/domain/time";
import { Button } from "@/components/ui/button";
import { FormField, Input, Textarea } from "@/components/ui/field";
import { StatusBadge } from "@/components/app/status-badge";
import { DateTime } from "@/components/app/datetime";
import { useServerAction } from "@/features/shared/use-action";
import { decideFindingAction } from "@/features/requests/actions";
import type { ResponseReview } from "@/server/services/correspondence";
import { cn } from "@/lib/cn";

type Finding = ResponseReview["findings"][number];

const TYPE_LABELS: Record<string, string> = {
  TRANSACTION: "Statement row",
  HOLD_STATUS: "Hold status",
  KYC_RECORD: "KYC record",
  SUBSCRIBER_RECORD: "Subscriber record",
  RELATIONSHIP: "Linked identifier",
  LOCATION_OBSERVATION: "Location observation",
  BALANCE_REPORTED: "Balance reported",
  BALANCE_UNCONFIRMED: "Balance not confirmed",
  ITEM_NOT_PROVIDED: "Item not provided",
  NOTE: "Note",
};

const EDITABLE = ["TRANSACTION", "HOLD_STATUS"];

export function FindingCard({ f, onShowSource, highlighted, readOnly }: { f: Finding; onShowSource: (f: Finding) => void; highlighted: boolean; readOnly: boolean }) {
  const [mode, setMode] = useState<null | "edit" | "reject" | "defer">(null);
  const [reason, setReason] = useState("");
  const decide = useServerAction(decideFindingAction);
  const p = f.payload;
  const [amount, setAmount] = useState(p.amountMinor ? formatInr(minorFromString(String(p.amountMinor))).replace("₹", "") : "");
  const [when, setWhen] = useState(() => {
    const iso = (p.occurredAt ?? p.asOf) as string | null;
    return iso ? utcToIstInput(new Date(iso)) : "";
  });
  const [reference, setReference] = useState(String(p.reference ?? p.bankReference ?? ""));
  const [editError, setEditError] = useState<string | null>(null);
  const applied = !!f.appliedAt;

  const submitEdit = () => {
    const parsed = parseRupeesToMinor(amount);
    if (!parsed.ok) return setEditError(parsed.error);
    const at = istInputToUtc(when);
    if (when && !at) return setEditError("Enter a valid date and time.");
    setEditError(null);
    const edited = f.findingType === "TRANSACTION" ? { amountMinor: parsed.value.toString(), occurredAt: at?.toISOString() ?? null, reference: reference || null } : { amountMinor: parsed.value.toString(), asOf: at?.toISOString() ?? null, bankReference: reference || null };
    decide.run([f.id, "EDITED", null, edited], { success: "Edited result accepted", onSuccess: () => setMode(null) });
  };

  return (
    <article id={`finding-${f.id}`} className={cn("rounded-[var(--radius-control)] border bg-surface p-4", highlighted ? "border-focus ring-2 ring-[rgb(40_102_197/0.2)]" : "border-line")}>
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusBadge kind="classification" value={f.classification} />
        <span className="text-meta text-ink-3">{TYPE_LABELS[f.findingType] ?? f.findingType}</span>
        <span className="ml-auto">
          <StatusBadge kind="decision" value={f.decision} />
        </span>
      </div>
      <h3 className="mt-2 text-body font-semibold text-ink">{f.summary}</h3>
      <p className="mt-1 text-body text-ink-2">{f.classificationNote}</p>
      <p className="mt-2 rounded-[var(--radius-chip)] bg-surface-muted px-3 py-2 text-label text-ink-2">
        <span className="font-medium text-ink">If accepted: </span>
        {f.preview}
      </p>
      {f.locator ? (
        <div className="mt-2 text-label">
          <button type="button" onClick={() => onShowSource(f)} className="font-medium text-action hover:underline">
            Show source: {f.locator}
          </button>
          {f.excerpt ? <p className="mt-1 line-clamp-2 font-mono text-meta text-ink-3">{f.excerpt}</p> : null}
        </div>
      ) : null}
      {f.decisionReason ? <p className="mt-2 text-label text-ink-2">Reason: {f.decisionReason}</p> : null}

      {applied ? (
        <p className="mt-3 text-label text-success">
          Applied to the case <DateTime iso={f.appliedAt} />
        </p>
      ) : readOnly ? null : mode === "edit" ? (
        <div className="mt-3 flex flex-col gap-3 border-t border-line pt-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <FormField label="Amount (₹)" error={editError}>
              <Input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
            </FormField>
            <FormField label={f.findingType === "TRANSACTION" ? "Date and time (IST)" : "As of (IST)"}>
              <Input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
            </FormField>
          </div>
          <FormField label={f.findingType === "TRANSACTION" ? "Reference (UTR/RRN)" : "Bank reference"} optionalLabel>
            <Input value={reference} onChange={(e) => setReference(e.target.value)} />
          </FormField>
          <p className="text-meta text-ink-3">The original value stays on record; the edited value is what gets applied.</p>
          <div className="flex gap-2">
            <Button size="sm" variant="primary" loading={decide.pending} onClick={submitEdit}>
              Accept with edits
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setMode(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : mode === "reject" || mode === "defer" ? (
        <div className="mt-3 flex flex-col gap-2 border-t border-line pt-3">
          <FormField label={mode === "reject" ? "Reason for rejecting" : "Reason for deferring"} required error={decide.fieldErrors.reason}>
            <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
          </FormField>
          <div className="flex gap-2">
            <Button size="sm" variant={mode === "reject" ? "danger" : "primary"} loading={decide.pending} onClick={() => decide.run([f.id, mode === "reject" ? "REJECTED" : "DEFERRED", reason, null], { success: mode === "reject" ? "Result rejected" : "Result deferred", onSuccess: () => setMode(null) })}>
              {mode === "reject" ? "Reject result" : "Defer result"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setMode(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2 border-t border-line pt-3" role="group" aria-label={`Decision for: ${f.summary}`}>
          <Button size="sm" variant={f.decision === "ACCEPTED" ? "primary" : "secondary"} icon={<Check aria-hidden="true" />} loading={decide.pending && mode === null} onClick={() => decide.run([f.id, "ACCEPTED", null, null], { success: "Result accepted" })} aria-pressed={f.decision === "ACCEPTED"}>
            Accept
          </Button>
          {EDITABLE.includes(f.findingType) ? (
            <Button size="sm" variant={f.decision === "EDITED" ? "primary" : "secondary"} icon={<PencilLine aria-hidden="true" />} onClick={() => setMode("edit")}>
              Edit
            </Button>
          ) : null}
          <Button size="sm" variant="secondary" icon={<X aria-hidden="true" />} onClick={() => setMode("reject")} aria-pressed={f.decision === "REJECTED"}>
            Reject
          </Button>
          <Button size="sm" variant="ghost" icon={<Pause aria-hidden="true" />} onClick={() => setMode("defer")} aria-pressed={f.decision === "DEFERRED"}>
            Defer
          </Button>
          {f.decision !== "PENDING" ? (
            <Button size="sm" variant="ghost" onClick={() => decide.run([f.id, "PENDING", null, null], { success: "Decision cleared" })}>
              Clear decision
            </Button>
          ) : null}
        </div>
      )}
    </article>
  );
}
