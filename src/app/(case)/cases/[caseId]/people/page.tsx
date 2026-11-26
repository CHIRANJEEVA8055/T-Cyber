import type { Metadata } from "next";
import { requireUser } from "@/server/auth/current-user";
import { getDb } from "@/server/db";
import { orNotFound } from "@/server/not-found";
import { getPeopleView } from "@/server/services/people-view";
import { getCaseWindow } from "@/server/services/case-home";
import { PeopleScreen } from "@/features/case/components/people-screen";

export const metadata: Metadata = { title: "People & identifiers" };

export default async function PeoplePage({ params }: { params: Promise<{ caseId: string }> }) {
  const user = await requireUser();
  const { caseId } = await params;
  const db = getDb();
  const [data, w] = await Promise.all([orNotFound(getPeopleView(db, user, caseId)), orNotFound(getCaseWindow(db, user, caseId))]);
  return <PeopleScreen refLabel={w.ref} data={data} />;
}
