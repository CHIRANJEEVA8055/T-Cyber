import { AlertTriangle } from "lucide-react";
import { AmountDisplay } from "./amount";
import { DateTime } from "./datetime";
import { cn } from "@/lib/cn";

export interface LedgerSummary {
  victimCount: number;
  totalLossMinor: string;
  confirmedRefundsMinor: string;
  outstandingLossMinor: string;
  allocatedConfirmedMinor: string;
  confirmedHeldMinor: string;
  unallocatedHeldMinor: string | null;
  neitherMinor: string | null;
  refundsInPipelineMinor: string;
  reconciliation: "CONSISTENT" | "NEEDS_RECONCILIATION";
  issues: string[];
  unknownHolds: string[];
  competing: boolean;
  asOf: string | null;
}

function Line({ label, minor, sign, strong, hint }: { label: string; minor: string | null; sign?: "minus"; strong?: boolean; hint?: string }) {
  return (
    <div className={cn("flex items-baseline justify-between gap-4 py-2", strong && "py-2.5")}>
      <dt className={cn("min-w-0 text-body", strong ? "font-semibold text-ink" : "text-ink-2")}>
        {label}
        {hint ? <span className="block text-meta font-normal text-ink-3">{hint}</span> : null}
      </dt>
      <dd className={cn("shrink-0 text-right tabular-nums", strong ? "text-heading font-semibold text-ink" : "text-body font-medium text-ink")}>
        {sign === "minus" ? <span className="mr-1 text-ink-3" aria-hidden="true">−</span> : null}
        {sign === "minus" ? <span className="sr-only">minus </span> : null}
        <AmountDisplay minor={minor} />
      </dd>
    </div>
  );
}

/**
 * The recovery arithmetic, laid out like a statement so every figure is explainable:
 * loss − confirmed refunds = outstanding; outstanding − allocated confirmed holds = neither returned nor secured.
 * Computed by the deterministic ledger; nothing here is estimated.
 */
export function LedgerStatement({ l }: { l: LedgerSummary }) {
  const needs = l.reconciliation === "NEEDS_RECONCILIATION";
  return (
    <div>
      <dl>
        <Line label={`Reported loss`} hint={`${l.victimCount} ${l.victimCount === 1 ? "victim" : "victims"}`} minor={l.totalLossMinor} />
        <Line label="Returned to victims" hint="Only refunds with confirmed credit" minor={l.confirmedRefundsMinor} sign="minus" />
        <div className="border-t border-line-strong" role="presentation" />
        <Line label="Outstanding victim loss" minor={l.outstandingLossMinor} />
        <Line label="Secured for victims" hint="Confirmed holds, allocated to claims" minor={l.allocatedConfirmedMinor} sign="minus" />
        <div className="border-t-2 border-double border-[rgb(21_35_59/0.2)]" role="presentation" />
        {needs ? (
          <div className="flex items-start justify-between gap-4 py-2.5">
            <dt className="text-body font-semibold text-ink">Neither returned nor secured</dt>
            <dd className="inline-flex items-center gap-1.5 text-body font-semibold text-warning">
              <AlertTriangle aria-hidden="true" className="size-4" />
              Needs reconciliation
            </dd>
          </div>
        ) : (
          <Line label="Neither returned nor secured" minor={l.neitherMinor} strong />
        )}
      </dl>
      {needs ? (
        <ul className="mt-1 list-disc space-y-1 rounded-[var(--radius-control)] bg-warning-tint py-2 pl-8 pr-3 text-label text-warning">
          {l.issues.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      ) : null}
      <div className="mt-3 space-y-1.5 border-t border-line pt-3 text-label">
        <p className="text-meta font-medium text-ink-3">Also recorded, not counted above</p>
        <div className="flex justify-between gap-4 text-ink-2">
          <span>Held, not yet allocated{l.competing ? " (competing claims)" : ""}</span>
          <AmountDisplay minor={l.unallocatedHeldMinor} className="text-ink" />
        </div>
        <div className="flex justify-between gap-4 text-ink-2">
          <span>Refunds authorised or initiated, not yet credited</span>
          <AmountDisplay minor={l.refundsInPipelineMinor} className="text-ink" />
        </div>
        {l.unknownHolds.length ? (
          <div className="flex justify-between gap-4 text-ink-2">
            <span>Holds requested, amount not confirmed</span>
            <span className="text-right text-ink">{l.unknownHolds.join(", ")}</span>
          </div>
        ) : null}
      </div>
      <p className="mt-3 text-meta text-ink-3">
        {l.asOf ? (
          <>
            Latest bank confirmation <DateTime iso={l.asOf} />.{" "}
          </>
        ) : null}
        Computed from confirmed records only.
      </p>
    </div>
  );
}
