import type { Metadata } from "next";
import { requireUser } from "@/server/auth/current-user";
import { getDb } from "@/server/db";
import { orNotFound } from "@/server/not-found";
import { getThread, listThreads } from "@/server/services/chats";
import { loadLibrary } from "@/server/ai/library";
import { listPromptTemplates } from "@/server/services/prompt-templates";
import { canWorkCases } from "@/domain/permissions";
import { ProcedureAssistant } from "@/features/assistant/components/procedure-assistant";

export const metadata: Metadata = { title: "Procedure assistant" };

/** Procedure assistant (design: Dashboard artboard, Procedure assistant tab): saved chats over the approved sources. */
export default async function ProcedureAssistantPage({ searchParams }: { searchParams: Promise<{ t?: string; ask?: string }> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const db = getDb();
  const [threads, library, thread, templates] = await Promise.all([listThreads(db, user, { kind: "PROCEDURE" }), loadLibrary(db), sp.t ? orNotFound(getThread(db, user, sp.t)) : null, listPromptTemplates(db, user)]);
  const docs = library.map((d) => ({ id: d.id, title: d.title, docNumber: d.docNumber, issuingBody: d.issuingBody, version: d.version, effectiveFrom: d.effectiveFrom, status: d.status, category: d.category, reviewNote: d.reviewNote, jurisdiction: d.jurisdiction }));
  const initials = user.displayName
    .replace(/^[A-Z]\.\s*/, "")
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return (
    <ProcedureAssistant
      threads={threads}
      thread={thread?.kind === "PROCEDURE" ? thread : null}
      docs={docs}
      templates={templates.map((t) => ({ id: t.id, title: t.title, question: t.question, sourceLabel: t.sourceLabel }))}
      viewer={{ initials: `${user.rank === "Sub-Inspector" ? "S" : user.rank.charAt(0)}${initials.charAt(0)}` }}
      canUseCases={canWorkCases(user)}
      initialQuestion={sp.t ? null : (sp.ask ?? null)}
    />
  );
}
