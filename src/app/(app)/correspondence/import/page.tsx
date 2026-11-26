import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireUser } from "@/server/auth/current-user";
import { getDb } from "@/server/db";
import { caseAccessWhere } from "@/server/auth/access";
import { caseReference } from "@/server/services/cases";
import { PageBody, PageHeader } from "@/components/app/page";
import { InlineAlert } from "@/components/ui/feedback";
import { ImportResponseForm } from "@/features/responses/components/import-form";
import { getAppConfig } from "@/server/config";

export const metadata: Metadata = { title: "Import response" };

export default async function ImportResponsePage({ searchParams }: { searchParams: Promise<{ caseId?: string; requestId?: string }> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const db = getDb();
  const cases = await db.case.findMany({
    where: caseAccessWhere(user),
    include: { requests: { where: { status: { in: ["SUBMITTED", "ACKNOWLEDGED", "PARTIAL_RESPONSE", "COMPLETE_RESPONSE"] } }, include: { recipient: true }, orderBy: { reference: "asc" } } },
    orderBy: { createdAt: "asc" },
  });
  const options = cases.map((c) => ({
    id: c.id,
    label: `${caseReference(c)}: ${c.title}`,
    requests: c.requests.map((r) => ({ id: r.id, label: `${r.reference}, ${r.recipient.organisation}` })),
  }));
  return (
    <PageBody className="max-w-[880px]">
      <Link href="/correspondence" className="inline-flex items-center gap-1.5 text-label font-medium text-action hover:underline">
        <ArrowLeft aria-hidden="true" className="size-4" />
        Back to correspondence
      </Link>
      <PageHeader className="mt-3" title="Import a Response" description="Record a reply received outside T-CYBER (email, portal download or letter). The original text and files are preserved as evidence." />
      <InlineAlert tone="info" className="mt-5" title="Simulated mailbox">
        This build has no live mailbox connection. Imported messages are treated as untrusted data: their contents are only read for facts that you review, and nothing in them is executed.
      </InlineAlert>
      <ImportResponseForm cases={options} initialCaseId={sp.caseId ?? ""} initialRequestId={sp.requestId ?? ""} mailbox={getAppConfig().mailbox.fromAddress} />
    </PageBody>
  );
}
