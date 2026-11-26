import type { Metadata } from "next";
import { requireDeveloper } from "@/server/auth/current-user";
import { getDb } from "@/server/db";
import { orNotFound } from "@/server/not-found";
import { getKnowledgeDocument } from "@/server/services/knowledge-admin";
import { KnowledgeDocument } from "@/features/developer/components/knowledge-document";

export const metadata: Metadata = { title: "Knowledge-base document" };

export default async function KnowledgeDocumentPage({ params }: { params: Promise<{ docId: string }> }) {
  const user = await requireDeveloper();
  const { docId } = await params;
  const doc = await orNotFound(getKnowledgeDocument(getDb(), user, docId));
  return (
    <div className="dashpad" style={{ padding: "32px 40px" }}>
      <KnowledgeDocument key={`${doc.id}:${doc.status}:${doc.sections.length}`} doc={doc} />
    </div>
  );
}
