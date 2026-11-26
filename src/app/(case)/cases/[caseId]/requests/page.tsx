import type { Metadata } from "next";
import { requireUser } from "@/server/auth/current-user";
import { getDb } from "@/server/db";
import { orNotFound } from "@/server/not-found";
import { getRequestsView } from "@/server/services/requests-view";
import { getCaseWindow } from "@/server/services/case-home";
import { RequestsScreen } from "@/features/case/components/requests-screen";
import { gmailChannel } from "@/server/gmail/view";

export const metadata: Metadata = { title: "Requests & responses" };

/**
 * Requests & responses (design: Requests artboard). `?inbox=1` opens "Import a reply"; `&from=file` opens it on
 * "From a file or letter", with `&requestId=` chosen as the request it answers.
 */
export default async function CaseRequestsPage({ params, searchParams }: { params: Promise<{ caseId: string }>; searchParams: Promise<{ inbox?: string; import?: string; from?: string; requestId?: string }> }) {
  const user = await requireUser();
  const { caseId } = await params;
  const sp = await searchParams;
  const db = getDb();
  const [data, w] = await Promise.all([orNotFound(getRequestsView(db, user, caseId)), orNotFound(getCaseWindow(db, user, caseId))]);
  const open = sp.inbox === "1" || sp.import === "1";
  const from = sp.from === "file" || (open && !data.inbox.length) ? "file" : "inbox";
  return <RequestsScreen refLabel={w.ref} data={data} openImport={open ? { from, requestId: sp.requestId ?? null } : null} mailOn={gmailChannel().on} />;
}
