import { redirect } from "next/navigation";

/** The old investigation list is now Next actions; links that name a task open it there. */
export default async function InvestigationPage({ params, searchParams }: { params: Promise<{ caseId: string }>; searchParams: Promise<{ task?: string }> }) {
  const { caseId } = await params;
  const { task } = await searchParams;
  redirect(`/cases/${caseId}/actions${task ? `?task=${encodeURIComponent(task)}` : ""}`);
}
