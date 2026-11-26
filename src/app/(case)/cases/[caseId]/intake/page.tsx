import type { Metadata } from "next";
import { requireUser } from "@/server/auth/current-user";
import { getDb } from "@/server/db";
import { orNotFound } from "@/server/not-found";
import { getIntakeView } from "@/server/services/intake-view";
import { getCaseWindow } from "@/server/services/case-home";
import { IntakeScreen } from "@/features/case/components/intake-screen";

export const metadata: Metadata = { title: "Intake & evidence" };

/** Intake (design: Intake artboard). The New FIR window lands here after opening the case. */
export default async function IntakePage({ params }: { params: Promise<{ caseId: string }> }) {
  const user = await requireUser();
  const { caseId } = await params;
  const db = getDb();
  const [data, w] = await Promise.all([orNotFound(getIntakeView(db, user, caseId)), orNotFound(getCaseWindow(db, user, caseId))]);
  return <IntakeScreen refLabel={w.ref} data={data} />;
}
