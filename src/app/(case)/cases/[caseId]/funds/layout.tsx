import { requireUser } from "@/server/auth/current-user";
import { getDb } from "@/server/db";
import { orNotFound } from "@/server/not-found";
import { getLedgerView } from "@/server/services/funds";
import { SubNav } from "@/components/app/sub-nav";
import { AmountDisplay } from "@/components/app/amount";
import { DateTime } from "@/components/app/datetime";
import { AlertTriangle } from "lucide-react";

/** Funds sections share a compact statement of the case's financial position (from the ledger). */
export default async function FundsLayout({ children, params }: { children: React.ReactNode; params: Promise<{ caseId: string }> }) {
  const user = await requireUser();
  const { caseId } = await params;
  const v = await orNotFound(getLedgerView(getDb(), user, caseId));
  const p = v.position;
  const base = `/cases/${caseId}/funds`;
  const items = [
    { label: "Reported loss", minor: p.totalLossMinor },
    { label: "Returned (credit confirmed)", minor: p.confirmedRefundsMinor },
    { label: "Outstanding loss", minor: p.outstandingLossMinor },
    { label: "Secured for victims", minor: p.allocatedConfirmedMinor },
  ];
  return (
    <>
      <div className="mx-auto w-full max-w-[1440px] px-4 pt-6 sm:px-6 lg:px-8">
        <section aria-label="Financial position" className="panel grid grid-cols-2 divide-line sm:grid-cols-3 lg:grid-cols-5 lg:divide-x">
          {items.map((i) => (
            <div key={i.label} className="px-5 py-3.5">
              <p className="text-label text-ink-3">{i.label}</p>
              <p className="mt-0.5 text-section font-semibold text-ink">
                <AmountDisplay minor={i.minor} />
              </p>
            </div>
          ))}
          <div className="col-span-2 bg-surface-muted px-5 py-3.5 sm:col-span-1">
            <p className="text-label font-medium text-ink-2">Neither returned nor secured</p>
            {p.reconciliation.status === "CONSISTENT" ? (
              <p className="mt-0.5 text-heading font-semibold text-ink">
                <AmountDisplay minor={p.neitherReturnedNorSecuredMinor} />
              </p>
            ) : (
              <p className="mt-0.5 inline-flex items-center gap-1.5 text-section font-semibold text-warning">
                <AlertTriangle aria-hidden="true" className="size-4" />
                Needs reconciliation
              </p>
            )}
          </div>
        </section>
        <p className="mt-2 text-meta text-ink-3">
          Computed by the ledger from confirmed records only{v.asOf ? <>; latest record <DateTime iso={v.asOf} /></> : null}. Onward transfers are never added to the loss.
        </p>
      </div>
      <SubNav
        label="Funds sections"
        items={[
          { href: base, label: "Transactions", exact: true },
          { href: `${base}/holds`, label: "Holds and allocations" },
          { href: `${base}/returns`, label: "Returns to victims" },
        ]}
      />
      {children}
    </>
  );
}
