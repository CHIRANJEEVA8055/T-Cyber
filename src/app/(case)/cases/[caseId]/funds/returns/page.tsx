import type { Metadata } from "next";
import { requireUser } from "@/server/auth/current-user";
import { getDb } from "@/server/db";
import { orNotFound } from "@/server/not-found";
import { getLedgerView } from "@/server/services/funds";
import { PageBody } from "@/components/app/page";
import { ReturnsView } from "@/features/funds/components/funds-views";

export const metadata: Metadata = { title: "Funds: returns" };

export default async function ReturnsPage({ params }: { params: Promise<{ caseId: string }> }) {
  const user = await requireUser();
  const { caseId } = await params;
  const v = await orNotFound(getLedgerView(getDb(), user, caseId));
  return (
    <PageBody className="pt-5">
      <ReturnsView caseId={caseId} v={v} />
    </PageBody>
  );
}
