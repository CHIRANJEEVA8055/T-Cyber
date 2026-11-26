import type { Metadata } from "next";
import Link from "next/link";
import { requireDeveloper } from "@/server/auth/current-user";
import { getDb } from "@/server/db";
import { listKnowledge } from "@/server/services/knowledge-admin";
import { KnowledgeUpload } from "@/features/developer/components/knowledge-upload";

export const metadata: Metadata = { title: "Upload a document" };

export default async function NewKnowledgePage() {
  const user = await requireDeveloper();
  const { rows } = await listKnowledge(getDb(), user, { status: "CURRENT" });
  return (
    <div className="dashpad" style={{ padding: "32px 40px", display: "flex", flexDirection: "column", gap: 20 }}>
      <div>
        <Link href="/developer/knowledge" className="more">
          Knowledge base
        </Link>
        <h1 className="h" style={{ fontSize: 28, margin: "6px 0 0" }}>Upload a Document</h1>
        <p className="sec" style={{ margin: "6px 0 0", maxWidth: "70ch" }}>A circular, SOP, provider guide or other procedure the assistant should answer from.</p>
      </div>
      <KnowledgeUpload current={rows.map((r) => ({ id: r.id, title: r.title, version: r.version }))} />
    </div>
  );
}
