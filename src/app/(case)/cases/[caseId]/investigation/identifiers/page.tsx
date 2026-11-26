import { redirect } from "next/navigation";

/** People and identifiers now share one screen. */
export default async function OldPeoplePage({ params }: { params: Promise<{ caseId: string }> }) {
  const { caseId } = await params;
  redirect(`/cases/${caseId}/people`);
}
