import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/server/auth/current-user";
import { getDb } from "@/server/db";
import { listTemplates } from "@/server/services/settings";
import { canManageDirectory } from "@/domain/permissions";
import { PageBody, PageHeader } from "@/components/app/page";
import { DataTable } from "@/components/app/data-table";
import { DateTime } from "@/components/app/datetime";
import { InlineAlert } from "@/components/ui/feedback";
import type { TemplateView } from "@/server/services/settings";

export const metadata: Metadata = { title: "Templates" };

export default async function TemplatesPage() {
  const user = await requireUser();
  const templates = await listTemplates(getDb(), user);
  const canManage = canManageDirectory(user);
  return (
    <PageBody>
      <PageHeader title="Templates" description="Standard wording for each kind of request. A change applies to drafts prepared afterwards; drafts already prepared keep their text." />
      {!canManage ? (
        <InlineAlert tone="info" className="mt-6">
          You can read the templates. Only a supervisor can change them.
        </InlineAlert>
      ) : null}
      <DataTable<TemplateView>
        className="mt-4"
        caption="Templates"
        rows={templates}
        rowKey={(t) => t.id}
        rowHref={(t) => `/settings/templates/${t.id}`}
        minWidth={760}
        columns={[
          { key: "name", header: "Template", cell: (t) => <span className="font-medium text-ink">{t.name}</span> },
          { key: "subject", header: "Subject", hideBelow: "lg", cell: (t) => <span className="text-label text-ink-2">{t.subjectTemplate}</span> },
          { key: "routes", header: "Used by", cell: (t) => <span className="text-label text-ink-2">{t.routes.join(", ") || "Requests of this kind"}</span> },
          { key: "version", header: "Version", align: "right", cell: (t) => <span className="tabular-nums">{t.version}</span> },
          { key: "updated", header: "Last changed", hideBelow: "md", cell: (t) => <DateTime iso={t.updatedAt} className="text-ink-2" /> },
        ]}
        mobileCard={(t) => (
          <div className="flex flex-col gap-1">
            <span className="text-body font-medium text-ink">{t.name}</span>
            <span className="text-label text-ink-2">Version {t.version}. {t.routes.join(", ") || "Requests of this kind"}</span>
          </div>
        )}
      />
      <p className="mt-3 text-label text-ink-3">
        {canManage ? "Open a template to edit it." : "Open a template to read it."} Placeholders such as <span className="font-mono">{"{{caseReference}}"}</span> are filled from the case when a draft is prepared.{" "}
        <Link href="/settings/routes" className="font-medium text-action hover:underline">
          See which route uses which template
        </Link>
        .
      </p>
    </PageBody>
  );
}
