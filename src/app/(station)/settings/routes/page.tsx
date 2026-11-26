import type { Metadata } from "next";
import { requireUser } from "@/server/auth/current-user";
import { getDb } from "@/server/db";
import { listRoutes } from "@/server/services/settings";
import { canManageDirectory } from "@/domain/permissions";
import { PageBody, PageHeader } from "@/components/app/page";
import { InlineAlert } from "@/components/ui/feedback";
import { gmailChannel } from "@/server/gmail/view";
import { RoutesView } from "@/features/settings/components/routes-view";

export const metadata: Metadata = { title: "Routes" };

export default async function RoutesPage() {
  const user = await requireUser();
  const routes = await listRoutes(getDb(), user);
  const canManage = canManageDirectory(user);
  return (
    <PageBody>
      <PageHeader
        title="Routes"
        description="Which recipient, channel and wording each kind of request uses, who approves it and when to follow up. These are local demonstration procedures, not verified universal rules."
      />
      {!canManage ? (
        <InlineAlert tone="info" className="mt-6">
          You can read the routes. Only a supervisor can change them.
        </InlineAlert>
      ) : null}
      <div className="mt-4">
        <RoutesView routes={routes} canManage={canManage} gmail={gmailChannel()} />
      </div>
    </PageBody>
  );
}
