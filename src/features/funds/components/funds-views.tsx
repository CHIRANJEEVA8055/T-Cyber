"use client";

import { autoDraftMessage } from "@/lib/auto-draft-message";
import { useState } from "react";
import { AlertTriangle, Plus } from "lucide-react";
import { formatInr, minorFromString } from "@/domain/money";
import { utcToIstInput } from "@/domain/time";
import { Button } from "@/components/ui/button";
import { DetailDrawer } from "@/components/ui/drawer";
import { ConfirmationDialog } from "@/components/ui/dialog";
import { FormField, Input, Select, Textarea } from "@/components/ui/field";
import { InlineAlert } from "@/components/ui/feedback";
import { AmountDisplay } from "@/components/app/amount";
import { DateTime } from "@/components/app/datetime";
import { EvidenceLink } from "@/components/app/evidence-link";
import { StatusBadge } from "@/components/app/status-badge";
import { EmptyState } from "@/components/app/states";
import { useServerAction } from "@/features/shared/use-action";
import { SortTh, useSort, type SortValue } from "@/components/design/sort";
import {
  addTransactionAction,
  advanceRefundAction,
  confirmAllocationAction,
  proposeAllocationAction,
  recordHoldChangeAction,
  recordHoldConfirmationAction,
  recordRefundAction,
  withdrawAllocationAction,
} from "@/features/funds/actions";
import type { LedgerView } from "@/server/services/funds";

export interface FundsOptions {
  entities: { id: string; label: string; kind: string }[];
  evidence: { id: string; title: string }[];
}

const KIND_TEXT: Record<string, string> = { VICTIM_PAYMENT: "Victim payment", ONWARD_TRANSFER: "Onward transfer", CASH_WITHDRAWAL: "Cash withdrawal" };
const sum = (vals: string[]) => vals.reduce((s, v) => s + minorFromString(v), 0n);
const big = (v: string | null | undefined): SortValue => (v === null || v === undefined || !/^-?\d+$/.test(v) ? null : BigInt(v));
type Flow = { id: string; label: string; received: bigint; onward: bigint; held: bigint | null; holdStatus: string | null; releasedToVictims: bigint; remainder: bigint };
const FLOW_SORT: Record<string, (f: Flow) => SortValue> = { account: (f) => f.label, received: (f) => f.received, onward: (f) => f.onward, held: (f) => f.held, left: (f) => f.remainder };
type Txn = LedgerView["transactions"][number];
const TXN_SORT: Record<string, (t: Txn) => SortValue> = { date: (t) => (t.occurredAt ? new Date(t.occurredAt) : null), from: (t) => `${t.fromLabel} ${t.toLabel}`, amount: (t) => big(t.amountMinor), layer: (t) => t.layer, status: (t) => t.status, sources: (t) => t.sources.length };
type ClaimPos = LedgerView["position"]["perClaim"][number];

// ───────────────────────── Transactions ─────────────────────────

export function TransactionsView({ caseId, v, options }: { caseId: string; v: LedgerView; options: FundsOptions }) {
  const [open, setOpen] = useState(false);
  // Per receiving account: received, traced onward, held — what is left is not yet accounted for.
  const receivers = [...new Map(v.transactions.filter((t) => t.kind !== "CASH_WITHDRAWAL").map((t) => [t.toEntityId, t.toLabel])).entries()];
  const flowsRaw: Flow[] = receivers.map(([id, label]) => {
    const received = sum(v.transactions.filter((t) => t.toEntityId === id).map((t) => t.amountMinor));
    const onward = sum(v.transactions.filter((t) => t.fromEntityId === id).map((t) => t.amountMinor));
    const hold = v.holds.find((h) => h.accountEntityId === id);
    const held = hold && hold.status === "CONFIRMED_HELD" && hold.confirmedMinor !== null ? minorFromString(hold.confirmedMinor) : null;
    const releasedToVictims = sum(v.refunds.filter((r) => r.holdId === hold?.id && r.status === "CREDIT_CONFIRMED").map((r) => r.amountMinor));
    const known = onward + (held ?? 0n) + releasedToVictims;
    const remainder = received - known;
    return { id, label, received, onward, held, holdStatus: hold?.status ?? null, releasedToVictims, remainder };
  });
  const { rows: flows, sort: fSort, toggle: fToggle } = useSort(flowsRaw, FLOW_SORT);
  const { rows: txns, sort: tSort, toggle: tToggle } = useSort(v.transactions, TXN_SORT);
  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="flow-title" className="panel overflow-hidden">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-3.5">
          <div>
            <h3 id="flow-title" className="text-section font-semibold tracking-tight text-ink">
              Where the Money Went
            </h3>
            <p className="mt-0.5 text-label text-ink-2">For each receiving account: what came in, what was traced onward, what is held, and what is not yet accounted for.</p>
          </div>
          <Button size="sm" variant="secondary" icon={<Plus aria-hidden="true" />} onClick={() => setOpen(true)}>
            Record transaction
          </Button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] border-collapse text-left">
            <caption className="sr-only">Money received and traced by account</caption>
            <thead className="bg-surface-muted">
              <tr className="border-b border-line text-label text-ink-2">
                <SortTh k="account" sort={fSort} onSort={fToggle} className="px-4 py-2.5 font-medium">Account</SortTh>
                <SortTh k="received" sort={fSort} onSort={fToggle} className="px-4 py-2.5 text-right font-medium">Received</SortTh>
                <SortTh k="onward" sort={fSort} onSort={fToggle} className="px-4 py-2.5 text-right font-medium">Traced onward</SortTh>
                <SortTh k="held" sort={fSort} onSort={fToggle} className="px-4 py-2.5 text-right font-medium">Confirmed held</SortTh>
                <SortTh k="left" sort={fSort} onSort={fToggle} className="px-4 py-2.5 text-right font-medium">Not yet accounted for</SortTh>
              </tr>
            </thead>
            <tbody>
              {flows.map((f) => (
                <tr key={f.id} className="border-b border-line last:border-b-0">
                  <th scope="row" className="px-4 py-3 text-left text-body font-medium text-ink">
                    {f.label}
                  </th>
                  <td className="px-4 py-3 text-right text-body">{formatInr(f.received)}</td>
                  <td className="px-4 py-3 text-right text-body">{f.onward > 0n ? formatInr(f.onward) : <span className="text-ink-3">None traced</span>}</td>
                  <td className="px-4 py-3 text-right text-body">
                    {f.held !== null ? formatInr(f.held) : <span className="italic text-ink-3">{f.holdStatus === "REQUESTED" || f.holdStatus === "RESTRICTION_CONFIRMED" ? "Unknown (not confirmed)" : "No hold"}</span>}
                    {f.releasedToVictims > 0n ? <span className="block text-meta text-ink-3">{formatInr(f.releasedToVictims)} already returned</span> : null}
                  </td>
                  <td className="px-4 py-3 text-right text-body">{f.remainder > 0n ? <span className="font-medium text-warning">{formatInr(f.remainder)}</span> : f.remainder === 0n ? <span className="text-ink-3">₹0</span> : <span className="font-medium text-danger">Exceeds receipts</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="layers-title" className="panel px-5 py-4">
        <h3 id="layers-title" className="text-section font-semibold tracking-tight text-ink">
          Observed Transfers by Layer
        </h3>
        <p className="mt-0.5 text-label text-ink-2">The same money appears at each layer, so these totals are never added together or to the loss.</p>
        <dl className="mt-3 flex flex-wrap gap-x-10 gap-y-2">
          {v.position.transfersByLayer.map((l) => (
            <div key={l.layer}>
              <dt className="text-label text-ink-3">
                Layer {l.layer} ({l.count} {l.count === 1 ? "transfer" : "transfers"})
              </dt>
              <dd className="text-section font-semibold text-ink">
                <AmountDisplay minor={l.totalMinor} />
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <section aria-labelledby="tx-title" className="panel overflow-hidden">
        <h3 id="tx-title" className="border-b border-line px-5 py-3.5 text-section font-semibold tracking-tight text-ink">
          Transactions <span className="font-normal text-ink-3">{v.transactions.length}</span>
        </h3>
        {v.transactions.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[920px] border-collapse text-left">
              <caption className="sr-only">Transactions</caption>
              <thead className="bg-surface-muted">
                <tr className="border-b border-line text-label text-ink-2">
                  <SortTh k="date" sort={tSort} onSort={tToggle} className="px-4 py-2.5 font-medium">Date (IST)</SortTh>
                  <SortTh k="from" sort={tSort} onSort={tToggle} className="px-4 py-2.5 font-medium">From and to</SortTh>
                  <SortTh k="amount" sort={tSort} onSort={tToggle} className="px-4 py-2.5 text-right font-medium">Amount</SortTh>
                  <SortTh k="layer" sort={tSort} onSort={tToggle} className="px-4 py-2.5 font-medium">Layer and kind</SortTh>
                  <SortTh k="status" sort={tSort} onSort={tToggle} className="px-4 py-2.5 font-medium">Status</SortTh>
                  <SortTh k="sources" sort={tSort} onSort={tToggle} className="px-4 py-2.5 font-medium">Sources</SortTh>
                </tr>
              </thead>
              <tbody>
                {txns.map((t) => (
                  <tr key={t.id} className="border-b border-line align-top last:border-b-0">
                    <td className="whitespace-nowrap px-4 py-3 text-body">
                      <DateTime iso={t.occurredAt} label={false} />
                      <span className="block text-meta text-ink-3">{t.reference ? `Ref ${t.reference}` : "No reference"}</span>
                    </td>
                    <td className="px-4 py-3 text-body">
                      <span className="text-ink">{t.fromLabel}</span>
                      <span className="block text-ink-2">to {t.toLabel}</span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-right text-body font-medium">
                      <AmountDisplay minor={t.amountMinor} />
                    </td>
                    <td className="px-4 py-3 text-body text-ink-2">
                      Layer {t.layer}
                      <span className="block text-label">{KIND_TEXT[t.kind] ?? t.kind}, {t.channel.replace(/_/g, " ").toLowerCase()}</span>
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge kind="transaction" value={t.status} />
                      <span className="mt-1 block text-meta text-ink-3">
                        Recorded <DateTime iso={t.discoveredAt} mode="date" />
                      </span>
                    </td>
                    <td className="max-w-[18rem] px-4 py-3">
                      <span className="flex flex-col gap-1">
                        {t.sources.length ? t.sources.map((s, i) => <EvidenceLink key={i} caseId={caseId} source={s} />) : <span className="text-label text-ink-3">Officer entry</span>}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState compact title="No transactions recorded" description="Victim payments come from reviewed receipts or the FIR; onward transfers from reviewed bank statements." />
        )}
      </section>
      <AddTransaction caseId={caseId} v={v} options={options} open={open} onOpenChange={setOpen} />
    </div>
  );
}

function AddTransaction({ caseId, v, options, open, onOpenChange }: { caseId: string; v: LedgerView; options: FundsOptions; open: boolean; onOpenChange: (o: boolean) => void }) {
  const action = useServerAction(addTransactionAction);
  const accounts = options.entities.filter((e) => ["BANK_ACCOUNT", "UPI_ID", "WALLET", "CASH"].includes(e.kind));
  const [f, setF] = useState({ fromEntityId: "", toEntityId: "", amountRupees: "", occurredAt: utcToIstInput(new Date()), channel: "IMPS", reference: "", kind: "ONWARD_TRANSFER", claimId: "", sourceNote: "", evidenceId: "", locator: "" });
  const fe = action.fieldErrors;
  const formId = "add-transaction";
  return (
    <DetailDrawer
      open={open}
      onOpenChange={onOpenChange}
      title="Record a transaction"
      subtitle="Cite the record it comes from. Totals are recalculated by the ledger."
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form={formId} variant="primary" loading={action.pending}>
            Record transaction
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          action.run([caseId, { ...f, kind: f.kind as "VICTIM_PAYMENT" | "ONWARD_TRANSFER" | "CASH_WITHDRAWAL", reference: f.reference || null, claimId: f.claimId || null, evidenceId: f.evidenceId || null, locator: f.locator || null }], { success: (d) => autoDraftMessage("Transaction recorded", d.autoDraft), onSuccess: () => onOpenChange(false) });
        }}
      >
        {action.error && !Object.keys(fe).length ? <InlineAlert tone="danger">{action.error}</InlineAlert> : null}
        <FormField label="Kind" required>
          <Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
            {Object.entries(KIND_TEXT).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </Select>
        </FormField>
        {(["fromEntityId", "toEntityId"] as const).map((k) => (
          <FormField key={k} label={k === "fromEntityId" ? "From" : "To"} required error={fe[k]}>
            <Select value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })}>
              <option value="">Choose an account</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </Select>
          </FormField>
        ))}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField label="Amount (₹)" required error={fe.amountRupees}>
            <Input inputMode="decimal" value={f.amountRupees} onChange={(e) => setF({ ...f, amountRupees: e.target.value })} placeholder="4,00,000" />
          </FormField>
          <FormField label="Date and time (IST)" required error={fe.occurredAt}>
            <Input type="datetime-local" value={f.occurredAt} onChange={(e) => setF({ ...f, occurredAt: e.target.value })} />
          </FormField>
          <FormField label="Channel">
            <Select value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })}>
              {["IMPS", "NEFT", "RTGS", "UPI", "CASH_WITHDRAWAL", "OTHER"].map((c) => (
                <option key={c} value={c}>
                  {c.replace("_", " ").toLowerCase().replace(/^\w/, (x) => x.toUpperCase())}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Reference (UTR/RRN)" optionalLabel error={fe.reference}>
            <Input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} />
          </FormField>
        </div>
        {f.kind === "VICTIM_PAYMENT" ? (
          <FormField label="Victim claim" required error={fe.claimId}>
            <Select value={f.claimId} onChange={(e) => setF({ ...f, claimId: e.target.value })}>
              <option value="">Choose the claim</option>
              {v.claims.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.victimLabel}
                </option>
              ))}
            </Select>
          </FormField>
        ) : null}
        <FormField label="Source document" optionalLabel error={fe.evidenceId}>
          <Select value={f.evidenceId} onChange={(e) => setF({ ...f, evidenceId: e.target.value })}>
            <option value="">No document (describe the source below)</option>
            {options.evidence.map((e) => (
              <option key={e.id} value={e.id}>
                {e.title}
              </option>
            ))}
          </Select>
        </FormField>
        {f.evidenceId ? (
          <FormField label="Location in the document" optionalLabel hint="For example: p. 2, line 5 or row 3">
            <Input value={f.locator} onChange={(e) => setF({ ...f, locator: e.target.value })} />
          </FormField>
        ) : null}
        <FormField label="Source note" required={!f.evidenceId} error={fe.sourceNote}>
          <Textarea rows={2} value={f.sourceNote} onChange={(e) => setF({ ...f, sourceNote: e.target.value })} />
        </FormField>
      </form>
    </DetailDrawer>
  );
}

// ───────────────────────── Holds and allocations ─────────────────────────

export function HoldsView({ caseId, v, options }: { caseId: string; v: LedgerView; options: FundsOptions }) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [allocOpen, setAllocOpen] = useState<string | null>(null);
  const [changeFor, setChangeFor] = useState<string | null>(null);
  const [overFor, setOverFor] = useState<{ id: string; message: string } | null>(null);
  const [withdrawFor, setWithdrawFor] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const confirm = useServerAction(confirmAllocationAction);
  const withdraw = useServerAction(withdrawAllocationAction);
  const issues = v.position.reconciliation.issues;
  const claimLabel = (id: string) => v.claims.find((c) => c.id === id)?.victimLabel ?? "Claim";

  return (
    <div className="flex flex-col gap-6">
      {issues.length ? (
        <InlineAlert tone="warning" title="Needs reconciliation">
          <ul className="list-disc pl-4">
            {issues.map((i, n) => (
              <li key={n}>{i.message}</li>
            ))}
          </ul>
        </InlineAlert>
      ) : null}
      <div className="flex justify-end">
        <Button variant="secondary" icon={<Plus aria-hidden="true" />} onClick={() => setConfirmOpen(true)}>
          Record hold confirmation
        </Button>
      </div>
      {v.holds.length ? (
        v.holds.map((h) => {
          const pos = v.position.perHold.find((p) => p.holdId === h.id);
          const allocations = v.allocations.filter((a) => a.holdId === h.id && a.status !== "WITHDRAWN");
          return (
            <section key={h.id} aria-labelledby={`hold-${h.id}`} className="panel overflow-hidden">
              <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-3.5">
                <div>
                  <h3 id={`hold-${h.id}`} className="text-section font-semibold tracking-tight text-ink">
                    {h.accountLabel} <span className="font-mono text-label font-normal text-ink-2">{h.accountValue}</span>
                  </h3>
                  <p className="mt-0.5 text-label text-ink-2">
                    {h.bank ?? "Bank not recorded"}
                    {h.bankReference ? `, lien reference ${h.bankReference}` : ""}
                    {h.requestReference ? `, requested in ${h.requestReference}` : ""}
                  </p>
                </div>
                <StatusBadge kind="hold" value={h.status} />
              </div>
              <dl className="grid grid-cols-2 gap-4 px-5 py-4 sm:grid-cols-4">
                <div>
                  <dt className="text-label text-ink-3">Hold requested</dt>
                  <dd className="text-body font-medium text-ink">
                    <AmountDisplay minor={h.requestedMinor} unknownLabel="Not stated" />
                  </dd>
                </div>
                <div>
                  <dt className="text-label text-ink-3">Confirmed held</dt>
                  <dd className="text-body font-medium text-ink">
                    <AmountDisplay minor={h.status === "RELEASED" ? "0" : h.confirmedMinor} />
                  </dd>
                  {h.confirmedAsOf ? (
                    <dd className="text-meta text-ink-3">
                      as of <DateTime iso={h.confirmedAsOf} />
                    </dd>
                  ) : null}
                </div>
                <div>
                  <dt className="text-label text-ink-3">Allocated (confirmed)</dt>
                  <dd className="text-body font-medium text-ink">
                    <AmountDisplay minor={pos?.allocatedConfirmedMinor ?? "0"} />
                  </dd>
                </div>
                <div>
                  <dt className="text-label text-ink-3">Not yet allocated</dt>
                  <dd className="text-body font-medium text-ink">
                    <AmountDisplay minor={pos?.unallocatedMinor ?? null} unknownLabel={h.confirmedMinor === null ? "Unknown" : "Needs reconciliation"} />
                  </dd>
                  {pos?.competingProposals ? <dd className="text-meta font-medium text-warning">Competing claims, unresolved</dd> : null}
                </div>
              </dl>
              {h.sources.length ? (
                <div className="flex flex-wrap gap-x-4 gap-y-1 px-5 pb-3">
                  {h.sources.map((s, i) => (
                    <EvidenceLink key={i} caseId={caseId} source={s} />
                  ))}
                </div>
              ) : null}
              <div className="border-t border-line px-5 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h4 className="text-label font-semibold text-ink-2">Allocations to victim claims</h4>
                  <div className="flex gap-2">
                    {h.status === "CONFIRMED_HELD" ? (
                      <Button size="sm" variant="secondary" onClick={() => setAllocOpen(h.id)}>
                        Propose allocation
                      </Button>
                    ) : null}
                    <Button size="sm" variant="ghost" onClick={() => setChangeFor(h.id)}>
                      Record change or release
                    </Button>
                  </div>
                </div>
                {allocations.length ? (
                  <ul className="mt-2 divide-y divide-line rounded-[var(--radius-control)] border border-line">
                    {allocations.map((a) => (
                      <li key={a.id} className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0">
                          <p className="text-body text-ink">
                            <AmountDisplay minor={a.amountMinor} className="font-medium" /> for {claimLabel(a.claimId)}
                          </p>
                          <p className="text-label text-ink-2">{a.basis}</p>
                          <p className="text-meta text-ink-3">
                            Proposed by {a.createdBy}
                            {a.decidedBy ? `, decided by ${a.decidedBy}` : ""}
                            {a.decisionNote ? `. ${a.decisionNote}` : ""}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <StatusBadge kind="allocation" value={a.status} />
                          {a.status === "PROPOSED" ? (
                            <>
                              <Button
                                size="sm"
                                variant="secondary"
                                loading={confirm.pending}
                                onClick={async () => {
                                  const r = await confirm.run([a.id, false], { success: "Allocation confirmed", toastError: false });
                                  if (!r.ok && r.code === "PRECONDITION") setOverFor({ id: a.id, message: r.error });
                                  else if (!r.ok) setOverFor({ id: a.id, message: r.error });
                                }}
                              >
                                Confirm
                              </Button>
                              <Button size="sm" variant="ghost" onClick={() => setWithdrawFor(a.id)}>
                                Withdraw
                              </Button>
                            </>
                          ) : a.status === "CONFIRMED" ? (
                            <Button size="sm" variant="ghost" onClick={() => setWithdrawFor(a.id)}>
                              Withdraw
                            </Button>
                          ) : null}
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-1 text-label text-ink-3">{h.status === "CONFIRMED_HELD" ? "No allocations. Held funds are not counted as secured for a victim until allocated." : "Nothing can be allocated until the bank confirms an amount."}</p>
                )}
              </div>
              <details className="border-t border-line px-5 py-3">
                <summary className="cursor-pointer text-label font-medium text-action">History ({h.events.length})</summary>
                <ol className="mt-2 flex flex-col gap-2">
                  {h.events.map((e) => (
                    <li key={e.id} className="text-label">
                      <span className="font-medium text-ink">{e.type.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase())}</span>
                      {e.amountMinor !== null ? <> <AmountDisplay minor={e.amountMinor} /></> : null}
                      {e.previousAmountMinor !== null ? <span className="text-ink-3"> (was <AmountDisplay minor={e.previousAmountMinor} />)</span> : null}
                      <span className="block text-ink-2">{e.note}</span>
                      <span className="text-ink-3">
                        <DateTime iso={e.at} />
                        {e.actor ? `, ${e.actor}` : ""}
                      </span>
                    </li>
                  ))}
                </ol>
              </details>
              <ProposeAllocation caseId={caseId} holdId={h.id} v={v} open={allocOpen === h.id} onOpenChange={(o) => setAllocOpen(o ? h.id : null)} />
              <HoldChange holdId={h.id} label={h.accountLabel} open={changeFor === h.id} onOpenChange={(o) => setChangeFor(o ? h.id : null)} />
            </section>
          );
        })
      ) : (
        <div className="panel">
          <EmptyState title="No holds" description="A hold appears when a hold request is submitted, and records an amount only when the bank confirms it." />
        </div>
      )}
      <RecordHold caseId={caseId} options={options} open={confirmOpen} onOpenChange={setConfirmOpen} />
      <ConfirmationDialog
        open={!!overFor}
        onOpenChange={(o) => !o && setOverFor(null)}
        title="Confirm an allocation that exceeds the held amount?"
        description={overFor?.message}
        confirmLabel="Confirm and flag for reconciliation"
        tone="danger"
        onConfirm={async () => (overFor ? (await confirm.run([overFor.id, true], { success: "Allocation confirmed; the case shows Needs reconciliation" })).ok : false)}
      />
      <ConfirmationDialog
        open={!!withdrawFor}
        onOpenChange={(o) => {
          if (!o) {
            setWithdrawFor(null);
            setReason("");
          }
        }}
        title="Withdraw this allocation?"
        description="The funds stay held but are no longer counted as secured for this victim."
        confirmLabel="Withdraw allocation"
        tone="danger"
        onConfirm={async () => (withdrawFor ? (await withdraw.run([withdrawFor, reason], { success: "Allocation withdrawn" })).ok : false)}
      >
        <FormField label="Reason" required error={withdraw.fieldErrors.reason}>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} />
        </FormField>
      </ConfirmationDialog>
    </div>
  );
}

function ProposeAllocation({ caseId, holdId, v, open, onOpenChange }: { caseId: string; holdId: string; v: LedgerView; open: boolean; onOpenChange: (o: boolean) => void }) {
  const action = useServerAction(proposeAllocationAction);
  const [f, setF] = useState({ claimId: v.claims[0]?.id ?? "", amountRupees: "", basis: "" });
  const formId = `alloc-${holdId}`;
  return (
    <DetailDrawer
      open={open}
      onOpenChange={onOpenChange}
      title="Propose an allocation"
      subtitle="Explain why these held funds belong to this victim. Proposals are not counted as secured until confirmed."
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form={formId} variant="primary" loading={action.pending}>
            Propose allocation
          </Button>
        </>
      }
    >
      <form id={formId} className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); action.run([caseId, { holdId, ...f }], { success: "Allocation proposed", onSuccess: () => onOpenChange(false) }); }}>
        <FormField label="Victim claim" required error={action.fieldErrors.claimId}>
          <Select value={f.claimId} onChange={(e) => setF({ ...f, claimId: e.target.value })}>
            {v.claims.map((c) => (
              <option key={c.id} value={c.id}>
                {c.victimLabel}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="Amount (₹)" required error={action.fieldErrors.amountRupees}>
          <Input inputMode="decimal" value={f.amountRupees} onChange={(e) => setF({ ...f, amountRupees: e.target.value })} />
        </FormField>
        <FormField label="Basis" required error={action.fieldErrors.basis} hint="Similar amounts or timing alone do not establish whose money it is.">
          <Textarea rows={3} value={f.basis} onChange={(e) => setF({ ...f, basis: e.target.value })} />
        </FormField>
      </form>
    </DetailDrawer>
  );
}

function HoldChange({ holdId, label, open, onOpenChange }: { holdId: string; label: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const action = useServerAction(recordHoldChangeAction);
  const [f, setF] = useState({ type: "AMOUNT_CHANGED" as "AMOUNT_CHANGED" | "RELEASED", amountRupees: "", at: utcToIstInput(new Date()), note: "" });
  const formId = `change-${holdId}`;
  return (
    <DetailDrawer
      open={open}
      onOpenChange={onOpenChange}
      title={`Record a change to the hold on ${label}`}
      subtitle="Changes are recorded as history; nothing is overwritten."
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form={formId} variant="primary" loading={action.pending}>
            Record change
          </Button>
        </>
      }
    >
      <form id={formId} className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); action.run([holdId, { ...f, amountRupees: f.type === "RELEASED" ? null : f.amountRupees }], { success: "Hold change recorded", onSuccess: () => onOpenChange(false) }); }}>
        <FormField label="What changed">
          <Select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value as "AMOUNT_CHANGED" | "RELEASED" })}>
            <option value="AMOUNT_CHANGED">The held amount changed</option>
            <option value="RELEASED">The bank released the hold</option>
          </Select>
        </FormField>
        {f.type === "AMOUNT_CHANGED" ? (
          <FormField label="New held amount (₹)" required error={action.fieldErrors.amountRupees}>
            <Input inputMode="decimal" value={f.amountRupees} onChange={(e) => setF({ ...f, amountRupees: e.target.value })} />
          </FormField>
        ) : null}
        <FormField label="As of (IST)" required error={action.fieldErrors.at}>
          <Input type="datetime-local" value={f.at} onChange={(e) => setF({ ...f, at: e.target.value })} />
        </FormField>
        <FormField label="Source and note" required error={action.fieldErrors.note}>
          <Textarea rows={2} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
        </FormField>
      </form>
    </DetailDrawer>
  );
}

function RecordHold({ caseId, options, open, onOpenChange }: { caseId: string; options: FundsOptions; open: boolean; onOpenChange: (o: boolean) => void }) {
  const action = useServerAction(recordHoldConfirmationAction);
  const [f, setF] = useState({ accountEntityId: "", amountRupees: "", asOf: utcToIstInput(new Date()), bankReference: "", note: "", evidenceId: "", locator: "" });
  const formId = "record-hold";
  return (
    <DetailDrawer
      open={open}
      onOpenChange={onOpenChange}
      title="Record a hold confirmation"
      subtitle="Use when a bank confirms a hold outside a reviewed response (for example by letter). Leave the amount empty if only a restriction was confirmed."
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form={formId} variant="primary" loading={action.pending}>
            Record confirmation
          </Button>
        </>
      }
    >
      <form id={formId} className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); action.run([caseId, { ...f, amountRupees: f.amountRupees || null, bankReference: f.bankReference || null, evidenceId: f.evidenceId || null, locator: f.locator || null }], { success: "Hold confirmation recorded", onSuccess: () => onOpenChange(false) }); }}>
        <FormField label="Account" required error={action.fieldErrors.accountEntityId}>
          <Select value={f.accountEntityId} onChange={(e) => setF({ ...f, accountEntityId: e.target.value })}>
            <option value="">Choose the account</option>
            {options.entities.filter((x) => x.kind === "BANK_ACCOUNT").map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="Confirmed held amount (₹)" optionalLabel error={action.fieldErrors.amountRupees} hint="Leave empty if the bank confirmed a restriction without an amount. It will show as unknown, not ₹0.">
          <Input inputMode="decimal" value={f.amountRupees} onChange={(e) => setF({ ...f, amountRupees: e.target.value })} />
        </FormField>
        <FormField label="As of (IST)" required error={action.fieldErrors.asOf}>
          <Input type="datetime-local" value={f.asOf} onChange={(e) => setF({ ...f, asOf: e.target.value })} />
        </FormField>
        <FormField label="Bank reference" optionalLabel>
          <Input value={f.bankReference} onChange={(e) => setF({ ...f, bankReference: e.target.value })} />
        </FormField>
        <FormField label="Source document" optionalLabel>
          <Select value={f.evidenceId} onChange={(e) => setF({ ...f, evidenceId: e.target.value })}>
            <option value="">No document</option>
            {options.evidence.map((e) => (
              <option key={e.id} value={e.id}>
                {e.title}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="Note" required={!f.evidenceId} error={action.fieldErrors.note}>
          <Textarea rows={2} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
        </FormField>
      </form>
    </DetailDrawer>
  );
}

// ───────────────────────── Returns ─────────────────────────

export function ReturnsView({ caseId, v }: { caseId: string; v: LedgerView }) {
  const [open, setOpen] = useState(false);
  const [advance, setAdvance] = useState<{ id: string; to: "INITIATED" | "CREDIT_CONFIRMED" | "FAILED" | "CANCELLED" } | null>(null);
  const [adv, setAdv] = useState({ at: utcToIstInput(new Date()), note: "" });
  const action = useServerAction(advanceRefundAction);
  const claimLabel = (id: string) => v.claims.find((c) => c.id === id)?.victimLabel ?? "Claim";
  const needs = v.position.reconciliation.status !== "CONSISTENT";
  const CLAIM_SORT: Record<string, (c: ClaimPos) => SortValue> = { victim: (c) => claimLabel(c.claimId), loss: (c) => big(c.lossMinor), returned: (c) => big(c.confirmedRefundsMinor), outstanding: (c) => big(c.outstandingMinor), secured: (c) => big(c.allocatedMinor), neither: (c) => big(c.neitherMinor), proposed: (c) => big(c.proposedMinor) };
  const { rows: perClaim, sort: cSort, toggle: cToggle } = useSort(v.position.perClaim, CLAIM_SORT);
  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="victims-title" className="panel overflow-hidden">
        <div className="border-b border-line px-5 py-3.5">
          <h3 id="victims-title" className="text-section font-semibold tracking-tight text-ink">
            Position by Victim
          </h3>
          <p className="mt-0.5 text-label text-ink-2">Outstanding = loss minus confirmed refunds. Neither returned nor secured = outstanding minus confirmed allocations of held funds.</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] border-collapse text-left">
            <caption className="sr-only">Position by victim</caption>
            <thead className="bg-surface-muted">
              <tr className="border-b border-line text-label text-ink-2">
                <SortTh k="victim" sort={cSort} onSort={cToggle} className="px-4 py-2.5 font-medium">Victim</SortTh>
                <SortTh k="loss" sort={cSort} onSort={cToggle} className="px-4 py-2.5 text-right font-medium">Loss</SortTh>
                <SortTh k="returned" sort={cSort} onSort={cToggle} className="px-4 py-2.5 text-right font-medium">Returned</SortTh>
                <SortTh k="outstanding" sort={cSort} onSort={cToggle} className="px-4 py-2.5 text-right font-medium">Outstanding</SortTh>
                <SortTh k="secured" sort={cSort} onSort={cToggle} className="px-4 py-2.5 text-right font-medium">Secured</SortTh>
                <SortTh k="neither" sort={cSort} onSort={cToggle} className="px-4 py-2.5 text-right font-medium">Neither</SortTh>
                <SortTh k="proposed" sort={cSort} onSort={cToggle} className="px-4 py-2.5 text-right font-medium">Proposed, unresolved</SortTh>
              </tr>
            </thead>
            <tbody>
              {perClaim.map((c) => (
                <tr key={c.claimId} className="border-b border-line last:border-b-0">
                  <th scope="row" className="px-4 py-3 text-left text-body font-medium text-ink">
                    {claimLabel(c.claimId)}
                    <span className="block text-meta font-normal text-ink-3">{v.claims.find((x) => x.id === c.claimId)?.basis}</span>
                  </th>
                  <td className="px-4 py-3 text-right text-body"><AmountDisplay minor={c.lossMinor} /></td>
                  <td className="px-4 py-3 text-right text-body"><AmountDisplay minor={c.confirmedRefundsMinor} /></td>
                  <td className="px-4 py-3 text-right text-body"><AmountDisplay minor={c.outstandingMinor} /></td>
                  <td className="px-4 py-3 text-right text-body"><AmountDisplay minor={c.allocatedMinor} /></td>
                  <td className="px-4 py-3 text-right text-body font-semibold">
                    {needs ? <span className="inline-flex items-center gap-1 font-medium text-warning"><AlertTriangle aria-hidden="true" className="size-3.5" />Reconcile</span> : <AmountDisplay minor={c.neitherMinor} />}
                  </td>
                  <td className="px-4 py-3 text-right text-body text-ink-2">{c.proposedMinor !== "0" ? <AmountDisplay minor={c.proposedMinor} /> : "None"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="refunds-title" className="panel overflow-hidden">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-3.5">
          <div>
            <h3 id="refunds-title" className="text-section font-semibold tracking-tight text-ink">
              Refunds
            </h3>
            <p className="mt-0.5 text-label text-ink-2">Authorised, initiated and credited are separate stages. Only a confirmed credit counts as money returned.</p>
          </div>
          <Button size="sm" variant="secondary" icon={<Plus aria-hidden="true" />} onClick={() => setOpen(true)}>
            Record authorised refund
          </Button>
        </div>
        {v.refunds.length ? (
          <ul className="divide-y divide-line">
            {v.refunds.map((r) => (
              <li key={r.id} className="flex flex-col gap-3 px-5 py-4 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0">
                  <p className="text-body text-ink">
                    <AmountDisplay minor={r.amountMinor} className="font-semibold" /> to {claimLabel(r.claimId)}
                  </p>
                  <p className="text-label text-ink-2">Authority: {r.authorityReference}</p>
                  <ol className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-label">
                    <li className="text-ink-2">Authorised <DateTime iso={r.authorisedAt} mode="date" fallback="Not recorded" /></li>
                    <li className={r.initiatedAt ? "text-ink-2" : "text-ink-3"}>Initiated <DateTime iso={r.initiatedAt} mode="date" fallback="Not yet" /></li>
                    <li className={r.creditConfirmedAt ? "font-medium text-success" : "text-ink-3"}>Credit confirmed <DateTime iso={r.creditConfirmedAt} mode="date" fallback="Not yet" /></li>
                  </ol>
                  {r.note ? <p className="mt-1 text-label text-ink-3">{r.note}</p> : null}
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <StatusBadge kind="refund" value={r.status} />
                  {r.status === "AUTHORISED" ? (
                    <Button size="sm" variant="secondary" onClick={() => setAdvance({ id: r.id, to: "INITIATED" })}>
                      Record initiation
                    </Button>
                  ) : null}
                  {r.status === "INITIATED" ? (
                    <Button size="sm" variant="secondary" onClick={() => setAdvance({ id: r.id, to: "CREDIT_CONFIRMED" })}>
                      Record confirmed credit
                    </Button>
                  ) : null}
                  {r.status === "AUTHORISED" || r.status === "INITIATED" ? (
                    <Button size="sm" variant="ghost" onClick={() => setAdvance({ id: r.id, to: r.status === "AUTHORISED" ? "CANCELLED" : "FAILED" })}>
                      {r.status === "AUTHORISED" ? "Cancel refund" : "Record failure"}
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState compact title="No refunds recorded" description="Record a refund once the competent authority has authorised it. Held funds are not returned money." />
        )}
      </section>
      <RecordRefund caseId={caseId} v={v} open={open} onOpenChange={setOpen} />
      <ConfirmationDialog
        open={!!advance}
        onOpenChange={(o) => !o && setAdvance(null)}
        title={advance?.to === "CREDIT_CONFIRMED" ? "Record that the victim's account was credited?" : advance?.to === "INITIATED" ? "Record that the refund was initiated?" : "Record this refund outcome?"}
        description={advance?.to === "CREDIT_CONFIRMED" ? "This counts the money as returned and reduces the held and allocated amounts. Cite the confirmation." : "Recorded in the refund history and the activity log."}
        confirmLabel={advance?.to === "CREDIT_CONFIRMED" ? "Record confirmed credit" : advance?.to === "INITIATED" ? "Record initiation" : advance?.to === "CANCELLED" ? "Cancel refund" : "Record failure"}
        tone={advance?.to === "FAILED" || advance?.to === "CANCELLED" ? "danger" : "primary"}
        onConfirm={async () => (advance ? (await action.run([advance.id, { to: advance.to, at: adv.at, note: adv.note }], { success: "Refund updated", onSuccess: () => setAdv({ ...adv, note: "" }) })).ok : false)}
      >
        <div className="flex flex-col gap-3">
          <FormField label="Date and time (IST)" required error={action.fieldErrors.at}>
            <Input type="datetime-local" value={adv.at} onChange={(e) => setAdv({ ...adv, at: e.target.value })} />
          </FormField>
          <FormField label="Source and note" required error={action.fieldErrors.note}>
            <Textarea rows={2} value={adv.note} onChange={(e) => setAdv({ ...adv, note: e.target.value })} />
          </FormField>
        </div>
      </ConfirmationDialog>
    </div>
  );
}

function RecordRefund({ caseId, v, open, onOpenChange }: { caseId: string; v: LedgerView; open: boolean; onOpenChange: (o: boolean) => void }) {
  const action = useServerAction(recordRefundAction);
  const [f, setF] = useState({ claimId: v.claims[0]?.id ?? "", holdId: "", amountRupees: "", authorityReference: "", authorisedAt: utcToIstInput(new Date()) });
  const formId = "record-refund";
  return (
    <DetailDrawer
      open={open}
      onOpenChange={onOpenChange}
      title="Record an authorised refund"
      subtitle="Authorisation is not a return. The money counts as returned only when the credit is confirmed."
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form={formId} variant="primary" loading={action.pending}>
            Record refund
          </Button>
        </>
      }
    >
      <form id={formId} className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); action.run([caseId, { ...f, holdId: f.holdId || null }], { success: "Authorised refund recorded", onSuccess: () => onOpenChange(false) }); }}>
        <FormField label="Victim claim" required error={action.fieldErrors.claimId}>
          <Select value={f.claimId} onChange={(e) => setF({ ...f, claimId: e.target.value })}>
            {v.claims.map((c) => (
              <option key={c.id} value={c.id}>
                {c.victimLabel}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="From held funds in" optionalLabel error={action.fieldErrors.holdId}>
          <Select value={f.holdId} onChange={(e) => setF({ ...f, holdId: e.target.value })}>
            <option value="">Not from a recorded hold</option>
            {v.holds.filter((h) => h.status === "CONFIRMED_HELD").map((h) => (
              <option key={h.id} value={h.id}>
                {h.accountLabel} ({h.confirmedMinor ? formatInr(minorFromString(h.confirmedMinor)) : "amount unknown"})
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="Amount (₹)" required error={action.fieldErrors.amountRupees}>
          <Input inputMode="decimal" value={f.amountRupees} onChange={(e) => setF({ ...f, amountRupees: e.target.value })} />
        </FormField>
        <FormField label="Order or approval reference" required error={action.fieldErrors.authorityReference} hint="As recorded on the authorising document. T-CYBER does not generate legal authority references.">
          <Input value={f.authorityReference} onChange={(e) => setF({ ...f, authorityReference: e.target.value })} />
        </FormField>
        <FormField label="Authorised on (IST)" required error={action.fieldErrors.authorisedAt}>
          <Input type="datetime-local" value={f.authorisedAt} onChange={(e) => setF({ ...f, authorisedAt: e.target.value })} />
        </FormField>
      </form>
    </DetailDrawer>
  );
}

