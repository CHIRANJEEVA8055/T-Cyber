import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/server/auth/current-user";
import { getDb } from "@/server/db";
import { AppError } from "@/server/errors";
import { getReport, type ReportDetail } from "@/server/services/reports";
import { PageBody } from "@/components/app/page";
import { ReportView } from "@/features/activity/components/report-view";

export const metadata: Metadata = { title: "Report" };

export default async function ReportPage({ params, searchParams }: { params: Promise<{ caseId: string; reportId: string }>; searchParams: Promise<{ version?: string }> }) {
  const user = await requireUser();
  const { caseId, reportId } = await params;
  const { version } = await searchParams;
  const versionNo = version && /^\d+$/.test(version) ? Number(version) : undefined;
  let d: ReportDetail;
  try {
    d = await getReport(getDb(), user, reportId, versionNo);
  } catch (err) {
    if (err instanceof AppError && err.code === "NOT_FOUND") notFound();
    throw err;
  }
  if (d.report.caseId !== caseId) notFound();
  return (
    <PageBody>
      <ReportView d={d} />
    </PageBody>
  );
}
