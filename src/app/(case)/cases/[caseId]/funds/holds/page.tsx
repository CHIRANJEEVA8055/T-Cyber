import type { Metadata } from "next";
import { requireUser } from "@/server/auth/current-user";
import { getDb } from "@/server/db";
import { orNotFound } from "@/server/not-found";
import { getFundsFormOptions, getLedgerView } from "@/server/services/funds";
import { PageBody } from "@/components/app/page";
import { HoldsView } from "@/features/funds/components/funds-views";

export const metadata: Metadata = { title: "Funds: holds and allocations" };

export default async function HoldsPage({ params }: { params: Promise<{ caseId: string }> }) {
  const user = await requireUser();
  const { caseId } = await params;
  const [v, options] = await orNotFound(Promise.all([getLedgerView(getDb(), user, caseId), getFundsFormOptions(getDb(), user, caseId)]));
  return (
    <PageBody className="pt-5">
      <HoldsView caseId={caseId} v={v} options={options} />
    </PageBody>
  );
}
