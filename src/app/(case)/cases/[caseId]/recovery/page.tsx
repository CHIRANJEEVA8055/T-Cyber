import type { Metadata } from "next";
import { requireUser } from "@/server/auth/current-user";
import { getDb } from "@/server/db";
import { orNotFound } from "@/server/not-found";
import { getRecoveryView } from "@/server/services/recovery-view";
import { previewSplit } from "@/server/services/allocation-decision";
import { getCaseWindow } from "@/server/services/case-home";
import { RecoveryScreen } from "@/features/case/components/recovery-screen";

export const metadata: Metadata = { title: "Transactions & recovery" };

export default async function RecoveryPage({ params }: { params: Promise<{ caseId: string }> }) {
  const user = await requireUser();
  const { caseId } = await params;
  const db = getDb();
  const [data, w, split] = await Promise.all([orNotFound(getRecoveryView(db, user, caseId)), orNotFound(getCaseWindow(db, user, caseId)), orNotFound(previewSplit(db, user, caseId))]);
  return <RecoveryScreen refLabel={w.ref} data={data} split={split} />;
}
