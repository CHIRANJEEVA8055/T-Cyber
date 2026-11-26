import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { requireUser } from "@/server/auth/current-user";
import { getDb } from "@/server/db";
import { listTemplates } from "@/server/services/settings";
import { canManageDirectory } from "@/domain/permissions";
import { PageBody, PageHeader, Panel } from "@/components/app/page";
import { InlineAlert } from "@/components/ui/feedback";
import { PlaceholderList, TemplateEditor } from "@/features/settings/components/template-editor";

export const metadata: Metadata = { title: "Template" };

export default async function TemplatePage({ params }: { params: Promise<{ templateId: string }> }) {
  const user = await requireUser();
  const { templateId } = await params;
  const template = (await listTemplates(getDb(), user)).find((t) => t.id === templateId);
  if (!template) notFound();
  const canManage = canManageDirectory(user);
  return (
    <PageBody>
      <Link href="/settings/templates" className="inline-flex items-center gap-1 text-label font-medium text-action hover:underline">
        <ChevronLeft aria-hidden="true" className="size-4" />
        All templates
      </Link>
      <PageHeader className="mt-3" title={template.name} description={`Version ${template.version}. ${template.routes.length ? `Used by: ${template.routes.join(", ")}.` : "Used by requests of this kind."}`} />
      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-12">
        <div className="min-w-0 lg:col-span-8">
          {canManage ? (
            <TemplateEditor template={template} />
          ) : (
            <div className="flex flex-col gap-4">
              <InlineAlert tone="info">You can read this template. Only a supervisor can change it.</InlineAlert>
              <Panel title="Subject">
                <p className="text-body text-ink">{template.subjectTemplate}</p>
              </Panel>
              <Panel title="Body">
                <p className="whitespace-pre-wrap text-body text-ink">{template.bodyTemplate}</p>
              </Panel>
            </div>
          )}
        </div>
        <aside className="min-w-0 lg:col-span-4" aria-label="Placeholders">
          <Panel title="Placeholders for This Template" description="Each is replaced with case details when a draft is prepared.">
            <PlaceholderList placeholders={template.placeholders} />
          </Panel>
        </aside>
      </div>
    </PageBody>
  );
}
