import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireUser } from "@/server/auth/current-user";
import { getDb } from "@/server/db";
import { AppError } from "@/server/errors";
import { getExtractionReview } from "@/server/services/evidence-views";
import { PageBody } from "@/components/app/page";
import { StatusBadge } from "@/components/app/status-badge";
import { ExtractionReviewWorkspace } from "@/features/evidence/components/extraction-review";

export const metadata: Metadata = { title: "Extraction review" };

export default async function ExtractionReviewPage({ params }: { params: Promise<{ caseId: string; evidenceId: string }> }) {
  const user = await requireUser();
  const { caseId, evidenceId } = await params;
  let d;
  try {
    d = await getExtractionReview(getDb(), user, evidenceId);
  } catch (err) {
    if (err instanceof AppError && err.code === "NOT_FOUND") notFound();
    throw err;
  }
  if (d.caseId !== caseId) notFound();
  return (
    <PageBody>
      <Link href={`/cases/${caseId}/evidence/${evidenceId}`} className="inline-flex items-center gap-1.5 text-label font-medium text-action hover:underline">
        <ArrowLeft aria-hidden="true" className="size-4" />
        Back to {d.title}
      </Link>
      <div className="mt-3 flex flex-wrap items-center gap-2 border-b border-line pb-5">
        <h2 className="text-title font-semibold tracking-tight text-ink">Extraction review: {d.title}</h2>
        <StatusBadge kind="evidenceReview" value={d.reviewStatus} />
      </div>
      <div className="mt-6">
        <ExtractionReviewWorkspace d={d} />
      </div>
    </PageBody>
  );
}
