import type { Metadata } from "next";
import { requireUser } from "@/server/auth/current-user";
import { getDb } from "@/server/db";
import { orNotFound } from "@/server/not-found";
import { getNextActions } from "@/server/services/next-actions";
import { previewSplit } from "@/server/services/allocation-decision";
import { getCaseWindow } from "@/server/services/case-home";
import { NextActionsScreen } from "@/features/case/components/next-actions-screen";

export const metadata: Metadata = { title: "Next actions" };

/** Next actions (design: NextActions artboard): ranked, each opening its draft, decision or what it waits on. */
export default async function NextActionsPage({ params, searchParams }: { params: Promise<{ caseId: string }>; searchParams: Promise<{ a?: string; task?: string }> }) {
  const user = await requireUser();
  const { caseId } = await params;
  const sp = await searchParams;
  const db = getDb();
  const [data, w] = await Promise.all([orNotFound(getNextActions(db, user, caseId)), orNotFound(getCaseWindow(db, user, caseId))]);
  const hasSplit = data.actions.some((a) => a.ruleId === "FUNDS_ALLOCATION_BASIS");
  const split = hasSplit ? await previewSplit(db, user, caseId) : null;
  const byTask = sp.task ? data.actions.find((a) => a.taskId === sp.task)?.rank : undefined;
  const rank = byTask ?? Number(sp.a);
  return <NextActionsScreen caseId={caseId} refLabel={w.ref} data={data} split={split} canWrite={w.canWrite} initialRank={Number.isInteger(rank) && rank > 0 ? rank : null} />;
}
