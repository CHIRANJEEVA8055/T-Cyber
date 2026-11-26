"use client";

import { autoDraftMessage } from "@/lib/auto-draft-message";
import { useMemo, useState } from "react";
import { Check, CheckCheck, Link2, PencilLine, Plus, RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmationDialog } from "@/components/ui/dialog";
import { FormField, Input, Select } from "@/components/ui/field";
import { InlineAlert } from "@/components/ui/feedback";
import { StatusBadge, Tag } from "@/components/app/status-badge";
import { useServerAction } from "@/features/shared/use-action";
import { addManualCandidateAction, applyCandidatesAction, confirmClearCandidatesAction, reviewCandidateAction } from "@/features/evidence/actions";
import type { ExtractionReviewData } from "@/server/services/evidence-views";
import { cn } from "@/lib/cn";
import { DocumentViewer, type Highlight } from "./document-viewer";

type Candidate = ExtractionReviewData["candidates"][number];

const GROUPS: { title: string; fields: string[] }[] = [
  { title: "Case reference", fields: ["FIR_REFERENCE"] },
  { title: "People", fields: ["PERSON_NAME"] },
  { title: "Identifiers", fields: ["BANK_ACCOUNT", "PHONE", "EMAIL", "UPI_ID", "WEBSITE", "IP_ADDRESS", "PLATFORM_PROFILE", "IFSC"] },
  { title: "Payment rows", fields: ["TRANSACTION_ROW"] },
  { title: "Amounts, dates and references", fields: ["AMOUNT", "DATE_TIME", "TXN_REFERENCE"] },
];
const FIELD_LABELS: Record<string, string> = {
  FIR_REFERENCE: "FIR reference",
  PERSON_NAME: "Name",
  BANK_ACCOUNT: "Bank account",
  PHONE: "Phone number",
  EMAIL: "Email address",
  UPI_ID: "UPI ID",
  WEBSITE: "Website",
  IP_ADDRESS: "IP address",
  PLATFORM_PROFILE: "Platform profile",
  IFSC: "IFSC",
  TRANSACTION_ROW: "Payment row",
  AMOUNT: "Amount",
  DATE_TIME: "Date and time",
  TXN_REFERENCE: "Transaction reference",
};
const PERSON_ROLES = ["Complainant", "Victim", "Witness", "Person of interest", "Account holder on record", "Other"];
const UNCERTAINTY_TEXT: Record<string, string> = { MASKED: "Masked in source", INCOMPLETE: "Incomplete", UNCERTAIN_CHARACTERS: "Unclear characters", AMBIGUOUS_ROLE: "Role not stated", AMBIGUOUS_FORMAT: "Unclear format" };

function locatorOf(c: Candidate) {
  return c.row ? `row ${c.row}` : `${c.page ? `p. ${c.page}, ` : ""}line ${c.line}`;
}

function CandidateRow({ c, selected, onSelect }: { c: Candidate; selected: boolean; onSelect: () => void }) {
  const [mode, setMode] = useState<null | "correct" | "reject" | "link">(null);
  const [value, setValue] = useState(c.correctedValue ?? c.originalValue);
  const [reason, setReason] = useState("");
  const [linkId, setLinkId] = useState(c.linkedEntityId ?? c.exactMatches[0]?.id ?? "");
  const review = useServerAction(reviewCandidateAction);
  const isPerson = c.field === "PERSON_NAME";
  const isAccount = c.field === "BANK_ACCOUNT";
  const done = c.applied;
  const run = (input: Parameters<typeof reviewCandidateAction>[1], success: string) => review.run([c.id, input], { success, onSuccess: () => setMode(null) });

  return (
    <li className={cn("rounded-[var(--radius-control)] border p-3", selected ? "border-focus ring-2 ring-[rgb(40_102_197/0.2)]" : "border-line")}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <button type="button" onClick={onSelect} className="min-w-0 text-left">
          <span className="block text-meta text-ink-3">
            {FIELD_LABELS[c.field] ?? c.field}, {locatorOf(c)}
          </span>
          <span className="block break-all font-mono text-body text-ink">{c.correctedValue ?? c.originalValue}</span>
          {c.correctedValue ? <span className="block text-meta text-ink-3">Originally read as <span className="font-mono">{c.originalValue}</span></span> : null}
        </button>
        <StatusBadge kind="candidate" value={c.status} />
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {c.uncertainty !== "NONE" ? <Tag tone="warning">{UNCERTAINTY_TEXT[c.uncertainty] ?? c.uncertainty}</Tag> : null}
        {c.roleHint ? <Tag tone="info">{c.roleHint}</Tag> : null}
        {c.linkedEntityId ? <Tag>Linked to existing record</Tag> : null}
        {c.officerLabel ? <Tag>Label: {c.officerLabel}</Tag> : null}
      </div>
      {c.roleHintBasis || c.uncertaintyNote ? <p className="mt-1.5 text-label text-ink-2">{[c.roleHintBasis, c.uncertaintyNote].filter(Boolean).join(". ")}</p> : null}
      {c.rejectReason ? <p className="mt-1.5 text-label text-ink-2">Rejected: {c.rejectReason}</p> : null}
      {c.exactMatches.length && !c.linkedEntityId && !done ? <p className="mt-1.5 text-label text-info-ink">Matches an existing record exactly: {c.exactMatches.map((m) => m.label).join(", ")}</p> : null}

      {done ? (
        <p className="mt-2 text-label text-success">Applied to the case</p>
      ) : mode === "correct" ? (
        <div className="mt-2 flex flex-col gap-2">
          <FormField label="Corrected value" error={review.fieldErrors.correctedValue} hint="The original reading is kept on record.">
            <Input value={value} onChange={(e) => setValue(e.target.value)} className="font-mono" />
          </FormField>
          <div className="flex gap-2">
            <Button size="sm" variant="primary" loading={review.pending} onClick={() => run({ action: "CORRECT", correctedValue: value }, "Correction saved")}>
              Save correction
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setMode(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : mode === "reject" ? (
        <div className="mt-2 flex flex-col gap-2">
          <FormField label="Reason for rejecting" required error={review.fieldErrors.rejectReason}>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} />
          </FormField>
          <div className="flex gap-2">
            <Button size="sm" variant="danger" loading={review.pending} onClick={() => run({ action: "REJECT", rejectReason: reason }, "Item rejected")}>
              Reject item
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setMode(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : mode === "link" ? (
        <div className="mt-2 flex flex-col gap-2">
          <FormField label={isPerson ? "Same person as" : "Same record as"} hint={isPerson ? "Link only when you have established it is the same person. Names alone never establish this." : "Only exact matches are suggested."}>
            <Select value={linkId} onChange={(e) => setLinkId(e.target.value)}>
              <option value="">Do not link (create a separate record)</option>
              {c.linkOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                  {c.exactMatches.some((m) => m.id === o.id) ? " (exact match)" : ""}
                </option>
              ))}
            </Select>
          </FormField>
          <div className="flex gap-2">
            <Button size="sm" variant="primary" loading={review.pending} onClick={() => run({ action: "ACCEPT", linkEntityId: linkId || null }, linkId ? "Linked to the existing record" : "Accepted as a separate record")}>
              Save link
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setMode(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          {isPerson ? (
            <div className="w-48">
              <FormField label="Role in this case">
                <Select value={c.roleHint ?? ""} onChange={(e) => run({ action: c.status === "PENDING" ? "ACCEPT" : "ACCEPT", roleHint: e.target.value }, "Role recorded")}>
                  <option value="" disabled>
                    Choose a role
                  </option>
                  {PERSON_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </Select>
              </FormField>
            </div>
          ) : null}
          {isAccount ? (
            <div className="w-44">
              <FormField label="Label">
                <Input defaultValue={c.officerLabel ?? ""} placeholder="Account A" onBlur={(e) => e.target.value !== (c.officerLabel ?? "") && run({ action: "ACCEPT", label: e.target.value }, "Label saved")} />
              </FormField>
            </div>
          ) : null}
          <div className="flex flex-wrap gap-1.5" role="group" aria-label={`Review ${FIELD_LABELS[c.field]} ${c.originalValue}`}>
            <Button size="sm" variant={c.status === "ACCEPTED" || c.status === "CORRECTED" || c.status === "ADDED" ? "primary" : "secondary"} icon={<Check aria-hidden="true" />} loading={review.pending && mode === null} onClick={() => run({ action: "ACCEPT" }, "Marked as read correctly")}>
              Read correctly
            </Button>
            <Button size="sm" variant="secondary" icon={<PencilLine aria-hidden="true" />} onClick={() => setMode("correct")}>
              Correct
            </Button>
            {c.linkOptions.length ? (
              <Button size="sm" variant="secondary" icon={<Link2 aria-hidden="true" />} onClick={() => setMode("link")}>
                Link
              </Button>
            ) : null}
            <Button size="sm" variant="secondary" icon={<X aria-hidden="true" />} onClick={() => setMode("reject")}>
              Reject
            </Button>
            {c.status !== "PENDING" ? (
              <Button size="sm" variant="ghost" icon={<RotateCcw aria-hidden="true" />} onClick={() => run({ action: "RESET" }, "Decision cleared")}>
                Reset
              </Button>
            ) : null}
          </div>
        </div>
      )}
    </li>
  );
}

export function ExtractionReviewWorkspace({ d }: { d: ExtractionReviewData }) {
  const [selected, setSelected] = useState<Candidate | null>(null);
  const [payer, setPayer] = useState("");
  const [claim, setClaim] = useState(d.claims[0]?.id ?? "");
  const [confirm, setConfirm] = useState(false);
  const [manual, setManual] = useState({ field: "PLATFORM_PROFILE", value: "", page: "", line: "", row: "", roleHint: "" });
  const apply = useServerAction(applyCandidatesAction);
  const confirmClear = useServerAction(confirmClearCandidatesAction);
  const clearCount = d.candidates.filter((c) => c.status === "PENDING" && !c.applied && (c.uncertainty === "NONE" || c.uncertainty === "MASKED") && c.field !== "PERSON_NAME").length;
  const add = useServerAction(addManualCandidateAction);
  const highlight: Highlight | null = selected ? { page: selected.page, line: selected.line, row: selected.row, charStart: selected.charStart, charEnd: selected.charEnd } : null;
  const ready = d.candidates.filter((c) => !c.applied && ["ACCEPTED", "CORRECTED", "ADDED"].includes(c.status));
  const pending = d.candidates.filter((c) => c.status === "PENDING").length;
  const needsPayer = ready.some((c) => c.field === "TRANSACTION_ROW");
  // Matches the server: without a chosen payer, the complainant's own account stated in this document is used.
  const documentPayer = d.candidates.find((c) => c.field === "BANK_ACCOUNT" && !c.applied && ["ACCEPTED", "CORRECTED", "ADDED"].includes(c.status) && /complainant'?s own account|victim'?s (?:own )?account/i.test(c.roleHint ?? ""));
  const groups = useMemo(() => GROUPS.map((g) => ({ ...g, items: d.candidates.filter((c) => g.fields.includes(c.field)) })).filter((g) => g.items.length), [d.candidates]);
  const isTable = d.segments.some((s) => s.method === "CSV_ROW");

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-12">
      <section aria-labelledby="doc-title" className="panel min-w-0 self-start xl:sticky xl:top-[72px] xl:col-span-6 xl:max-h-[calc(100dvh-88px)] xl:overflow-y-auto">
        <div className="border-b border-line px-5 py-3.5">
          <h2 id="doc-title" className="text-section font-semibold tracking-tight text-ink">
            Source Document
          </h2>
          <p className="mt-0.5 text-label text-ink-2">Select an item to see exactly where it was read.</p>
        </div>
        <div className="p-4">
          {d.segments.length ? <DocumentViewer segments={d.segments} highlight={highlight} idPrefix="review" /> : <InlineAlert tone="warning">{d.processingNote ?? "No text could be extracted."}</InlineAlert>}
        </div>
      </section>

      <section aria-labelledby="items-title" className="flex min-w-0 flex-col gap-4 xl:col-span-6">
        <div className="panel">
          <div className="border-b border-line px-5 py-3.5">
            <h2 id="items-title" className="text-section font-semibold tracking-tight text-ink">
              Items Read from This Document
            </h2>
            <p className="mt-0.5 text-label text-ink-2">
              Confirm each was read correctly. Applying records facts as unverified with this location as their source; it does not confirm that they are true. {pending} not reviewed.
            </p>
            {clearCount > 0 ? (
              <div className="mt-3 flex flex-col gap-1.5">
                <Button
                  size="sm"
                  variant="secondary"
                  className="self-start"
                  icon={<CheckCheck aria-hidden="true" />}
                  loading={confirmClear.pending}
                  onClick={() => confirmClear.run([d.id], { success: (r) => `${r.confirmed} items confirmed as read correctly; ${r.remaining} left to review` })}
                >
                  {`Confirm ${clearCount} items read clearly`}
                </Button>
                <p className="text-meta text-ink-3">People and items flagged as uncertain, incomplete or ambiguous stay for you to review one by one.</p>
              </div>
            ) : null}
          </div>
          <div className="flex flex-col gap-5 p-4">
            {d.lastRun?.status === "NOT_SUPPORTED" ? <InlineAlert tone="warning" title="Extraction not available for this file">{d.lastRun.note}</InlineAlert> : null}
            {d.lastRun?.status === "NOTHING_FOUND" ? <InlineAlert tone="info">{d.lastRun.note}</InlineAlert> : null}
            {groups.map((g) => (
              <div key={g.title}>
                <h3 className="mb-2 text-label font-semibold text-ink-2">{g.title}</h3>
                <ul className="flex flex-col gap-2">
                  {g.items.map((c) => (
                    <CandidateRow key={c.id} c={c} selected={selected?.id === c.id} onSelect={() => setSelected(c)} />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>

        <div className="panel p-5">
          <h2 className="text-section font-semibold tracking-tight text-ink">Add a Missed Item</h2>
          <p className="mt-0.5 text-label text-ink-2">For details the rules did not recognise, such as a profile name. Give its location so it keeps a source.</p>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <FormField label="Kind">
              <Select value={manual.field} onChange={(e) => setManual({ ...manual, field: e.target.value })}>
                {["PLATFORM_PROFILE", "PERSON_NAME", "PHONE", "EMAIL", "BANK_ACCOUNT", "UPI_ID", "WEBSITE", "IP_ADDRESS"].map((f) => (
                  <option key={f} value={f}>
                    {FIELD_LABELS[f]}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField label="Value as written" error={add.fieldErrors.value}>
              <Input value={manual.value} onChange={(e) => setManual({ ...manual, value: e.target.value })} />
            </FormField>
            {isTable ? (
              <FormField label="Row" optionalLabel error={add.fieldErrors.line}>
                <Input inputMode="numeric" value={manual.row} onChange={(e) => setManual({ ...manual, row: e.target.value })} />
              </FormField>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <FormField label="Page" optionalLabel>
                  <Input inputMode="numeric" value={manual.page} onChange={(e) => setManual({ ...manual, page: e.target.value })} />
                </FormField>
                <FormField label="Line" optionalLabel error={add.fieldErrors.line}>
                  <Input inputMode="numeric" value={manual.line} onChange={(e) => setManual({ ...manual, line: e.target.value })} />
                </FormField>
              </div>
            )}
            <FormField label="Role in this case" optionalLabel>
              <Input value={manual.roleHint} onChange={(e) => setManual({ ...manual, roleHint: e.target.value })} />
            </FormField>
          </div>
          <Button
            className="mt-3"
            size="sm"
            variant="secondary"
            icon={<Plus aria-hidden="true" />}
            loading={add.pending}
            onClick={() =>
              add.run([d.id, { field: manual.field, value: manual.value, page: manual.page ? Number(manual.page) : null, line: manual.line ? Number(manual.line) : null, row: manual.row ? Number(manual.row) : null, roleHint: manual.roleHint || null }], {
                success: "Item added",
                onSuccess: () => setManual({ ...manual, value: "", roleHint: "" }),
              })
            }
          >
            Add item
          </Button>
        </div>

        <div className="panel-raised p-5">
          <h2 className="text-section font-semibold tracking-tight text-ink">Apply Reviewed Items</h2>
          <p className="mt-1 text-body text-ink-2">
            {ready.length} reviewed {ready.length === 1 ? "item is" : "items are"} ready. Rejected and unreviewed items are not applied.
          </p>
          {needsPayer ? (
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <FormField label="Payments were made from" required error={apply.fieldErrors.payerAccountEntityId}>
                <Select value={payer} onChange={(e) => setPayer(e.target.value)}>
                  <option value="">{documentPayer ? `The complainant’s own account in this document (${documentPayer.correctedValue ?? documentPayer.originalValue})` : "Choose the victim’s account"}</option>
                  {d.accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.label}
                    </option>
                  ))}
                </Select>
              </FormField>
              <FormField label="Victim claim" error={apply.fieldErrors.claimId}>
                <Select value={claim} onChange={(e) => setClaim(e.target.value)}>
                  <option value="">Not linked to a claim</option>
                  {d.claims.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </Select>
              </FormField>
            </div>
          ) : null}
          <Button className="mt-3" variant="primary" onClick={() => setConfirm(true)}>
            Apply reviewed items
          </Button>
          <ConfirmationDialog
            open={confirm}
            onOpenChange={setConfirm}
            title={`Add ${ready.length} reviewed ${ready.length === 1 ? "item" : "items"} to the case?`}
            description="Identifiers and people are added as unverified, each with this document location as its source. Payment rows are recorded as reported by the victim."
            confirmLabel="Apply items"
            onConfirm={async () => (await apply.run([d.id, { payerAccountEntityId: payer || null, claimId: claim || null }], { success: (d) => autoDraftMessage("Reviewed items added to the case", d.autoDraft) })).ok}
          />
        </div>
      </section>
    </div>
  );
}
