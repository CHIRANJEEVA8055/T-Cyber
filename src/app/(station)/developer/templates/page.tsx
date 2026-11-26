import type { Metadata } from "next";
import { requireDeveloper } from "@/server/auth/current-user";
import { getDb } from "@/server/db";
import { listPromptTemplates } from "@/server/services/prompt-templates";
import { TemplatesView } from "@/features/developer/components/templates-view";

export const metadata: Metadata = { title: "Ready questions" };

export default async function TemplatesPage() {
  const user = await requireDeveloper();
  const templates = await listPromptTemplates(getDb(), user, { all: true });
  return (
    <div className="dashpad" style={{ padding: "32px 40px", display: "flex", flexDirection: "column", gap: 20 }}>
      <div>
        <h1 className="h" style={{ fontSize: 28, margin: 0 }}>Ready Questions</h1>
        <p className="sec" style={{ margin: "6px 0 0", maxWidth: "70ch" }}>The question cards officers see when they start a procedure-assistant chat. Each is answered from the knowledge base like any other question.</p>
      </div>
      <TemplatesView templates={templates} />
    </div>
  );
}
