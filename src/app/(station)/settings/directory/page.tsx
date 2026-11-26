import type { Metadata } from "next";
import { requireUser } from "@/server/auth/current-user";
import { getDb } from "@/server/db";
import { getConfigStatus } from "@/server/config";
import { listDirectory } from "@/server/services/settings";
import { canManageDirectory } from "@/domain/permissions";
import { PageBody, PageHeader } from "@/components/app/page";
import { InlineAlert } from "@/components/ui/feedback";
import { gmailChannel } from "@/server/gmail/view";
import { DirectoryView } from "@/features/settings/components/directory-view";

export const metadata: Metadata = { title: "Recipient directory" };

export default async function DirectoryPage() {
  const user = await requireUser();
  const entries = await listDirectory(getDb(), user);
  const file = getConfigStatus().file.replace(`${process.cwd()}/`, "");
  return (
    <PageBody>
      <PageHeader
        title="Recipient Directory"
        description="Who requests go to, by which channel. Requests cannot be submitted to a recipient that is not verified. All entries are synthetic demonstration contacts."
      />
      <InlineAlert tone="info" className="mt-6" title="Where these details come from">
        Names, addresses and channels come from <span className="font-mono">{file}</span>; edit the file to change them. Verification is recorded here, and a change of address in the file
        clears it until a supervisor verifies the new address.
        {canManageDirectory(user) ? null : " Only a supervisor can change verification."}
      </InlineAlert>
      <div className="mt-4">
        <DirectoryView entries={entries} canManage={canManageDirectory(user)} gmail={gmailChannel()} />
      </div>
    </PageBody>
  );
}
