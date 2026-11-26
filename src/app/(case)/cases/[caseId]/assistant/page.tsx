import type { Metadata } from "next";
import { requireUser } from "@/server/auth/current-user";
import { getDb } from "@/server/db";
import { orNotFound } from "@/server/not-found";
import { getThread, listThreads } from "@/server/services/chats";
import { getCaseWindow } from "@/server/services/case-home";
import { ChatScreen } from "@/features/assistant/components/chat-screen";

export const metadata: Metadata = { title: "Case assistant" };

/** Case assistant (design: CaseAssistant artboard): saved chats about this case, rules first, local model next. */
export default async function CaseAssistantPage({ params, searchParams }: { params: Promise<{ caseId: string }>; searchParams: Promise<{ t?: string }> }) {
  const user = await requireUser();
  const { caseId } = await params;
  const sp = await searchParams;
  const db = getDb();
  const [w, threads, thread] = await Promise.all([orNotFound(getCaseWindow(db, user, caseId)), orNotFound(listThreads(db, user, { kind: "CASE", caseId })), sp.t ? orNotFound(getThread(db, user, sp.t)) : null]);
  return <ChatScreen kind="CASE" caseId={caseId} refLabel={w.ref} threads={threads} thread={thread?.caseId === caseId ? thread : null} sources={[]} suggestions={["What changed recently?", "What is still missing?", "What is supported by evidence?", "How much money is held?", "What should I review next?"]} />;
}
