import type { Metadata } from "next";
import { requireUser } from "@/server/auth/current-user";
import { canResetDemo } from "@/domain/permissions";
import { PageBody, PageHeader, Panel } from "@/components/app/page";
import { InlineAlert } from "@/components/ui/feedback";
import { DemoReset } from "@/features/settings/components/demo-reset";

export const metadata: Metadata = { title: "Demonstration data" };

export default async function DemoDataPage() {
  const user = await requireUser();
  return (
    <PageBody>
      <PageHeader title="Demonstration Data" description="Every case, person, account, document and contact in this build is synthetic. Reset the data to start a demonstration again from the beginning." />
      <div className="mt-6 max-w-3xl">
        <Panel title="Reset to the Starting Demonstration">
          <ul className="ml-5 flex list-disc flex-col gap-1.5 text-body text-ink-2">
            <li>FIR 1/2026: investment fraud with a ₹20,00,000 loss, Bank A’s response applied and Bank B’s partial response waiting for review.</li>
            <li>FIR 2/2026: a job scam with two victims and competing claims on held funds.</li>
            <li>A complaint workspace assigned to a second officer.</li>
          </ul>
          <div className="mt-5">
            {canResetDemo(user) ? (
              <DemoReset />
            ) : (
              <InlineAlert tone="info">Only a supervisor can reset the demonstration data, because it signs everyone out and deletes all work done since the last reset.</InlineAlert>
            )}
          </div>
        </Panel>
      </div>
    </PageBody>
  );
}
