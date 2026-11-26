import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireUser } from "@/server/auth/current-user";
import { getDb } from "@/server/db";
import { AppError } from "@/server/errors";
import { getResponseReview } from "@/server/services/correspondence";
import { PageBody } from "@/components/app/page";
import { StatusBadge } from "@/components/app/status-badge";
import { DateTime } from "@/components/app/datetime";
import { ResponseReviewWorkspace } from "@/features/responses/components/response-review";

export const metadata: Metadata = { title: "Review response" };

export default async function ResponsePage({ params, searchParams }: { params: Promise<{ caseId: string; responseId: string }>; searchParams: Promise<{ returnTo?: string }> }) {
  const user = await requireUser();
  const { caseId, responseId } = await params;
  const { returnTo } = await searchParams;
  let r;
  try {
    r = await getResponseReview(getDb(), user, responseId);
  } catch (err) {
    if (err instanceof AppError && err.code === "NOT_FOUND") notFound();
    throw err;
  }
  if (r.caseId !== caseId) notFound();
  const back = returnTo && returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : `/cases/${caseId}/requests?view=inbox`;
  return (
    <PageBody>
      <Link href={back} className="inline-flex items-center gap-1.5 text-label font-medium text-action hover:underline">
        <ArrowLeft aria-hidden="true" className="size-4" />
        {back.startsWith("/correspondence") ? "Back to correspondence" : "Back to inbox"}
      </Link>
      <div className="mt-3 flex flex-col gap-2 border-b border-line pb-5">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-title font-semibold tracking-tight text-ink">
            {r.reference ? <span className="tabular-nums">{r.reference} · </span> : null}Response from {r.request?.recipient ?? r.fromAddress}
          </h2>
          <StatusBadge kind={r.matchStatus === "MATCHED" ? "review" : "match"} value={r.matchStatus === "MATCHED" ? r.reviewStatus : r.matchStatus} />
        </div>
        <p className="text-body text-ink-2">
          Received <DateTime iso={r.receivedAt} />
          {r.request ? (
            <>
              {" "}
              in reply to{" "}
              <Link href={`/cases/${caseId}/requests/${r.request.id}`} className="font-medium text-action hover:underline">
                {r.request.reference}
              </Link>{" "}
              (now <StatusBadge kind="request" value={r.request.status} className="align-middle" />)
            </>
          ) : null}
          {r.appliedAt ? (
            <>
              . Reviewed by {r.appliedBy} <DateTime iso={r.appliedAt} />
            </>
          ) : null}
        </p>
        {r.matchStatus === "MATCHED" ? <p className="text-label text-ink-3">Match basis: {r.matchBasis}</p> : null}
      </div>
      <div className="mt-6">
        <ResponseReviewWorkspace r={r} />
      </div>
    </PageBody>
  );
}
