import type { Metadata } from "next";
import { requireUser } from "@/server/auth/current-user";
import { getDb } from "@/server/db";
import { listNodal } from "@/server/services/nodal";
import { PageBody, PageHeader } from "@/components/app/page";
import { InlineAlert } from "@/components/ui/feedback";
import { NodalView } from "@/features/settings/components/nodal-view";

export const metadata: Metadata = { title: "Nodal officers" };

export default async function NodalPage({ searchParams }: { searchParams: Promise<{ q?: string; type?: string; page?: string; sort?: string; dir?: string }> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const data = await listNodal(getDb(), user, { q: sp.q, type: sp.type, page: Number(sp.page ?? 1), sort: sp.sort, dir: sp.dir });
  return (
    <PageBody>
      <PageHeader title="Nodal Officers" description="Who to write to at each bank, wallet, telecom operator, platform and other provider, from the CrimeOS nodal officer list." />
      <InlineAlert tone="info" className="mt-6" title="A reference list">
        A contact here is not a recipient yet: {user.role === "SUPERVISOR" ? "add an address to the recipient directory, then verify it there before requests go to it." : "a supervisor adds an address to the recipient directory and verifies it before requests go to it."} Email
        sending in this build is simulated; nothing is sent to these addresses.
      </InlineAlert>
      <div className="mt-4 scr-dashboard">
        <NodalView data={data} q={sp.q ?? ""} type={sp.type ?? "ALL"} canAdd={user.role === "SUPERVISOR"} />
      </div>
    </PageBody>
  );
}
