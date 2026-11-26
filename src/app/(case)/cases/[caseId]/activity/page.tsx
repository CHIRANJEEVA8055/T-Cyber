import type { Metadata } from "next";
import { requireUser } from "@/server/auth/current-user";
import { getDb } from "@/server/db";
import { orNotFound } from "@/server/not-found";
import { listActivity } from "@/server/services/activity";
import { ACTIVITY_CATEGORIES, type ActivityCategory } from "@/domain/activity";
import { PageBody, PageHeader } from "@/components/app/page";
import { FilterBar } from "@/components/app/filter-bar";
import { ActivityFeed } from "@/features/activity/components/activity-feed";

export const metadata: Metadata = { title: "Activity" };

export default async function ActivityPage({ params, searchParams }: { params: Promise<{ caseId: string }>; searchParams: Promise<{ category?: string; who?: string; q?: string; cursor?: string }> }) {
  const user = await requireUser();
  const { caseId } = await params;
  const sp = await searchParams;
  const category = sp.category && sp.category in ACTIVITY_CATEGORIES ? (sp.category as ActivityCategory) : undefined;
  const who = sp.who === "OFFICERS" || sp.who === "SYSTEM" ? sp.who : undefined;
  const data = await orNotFound(listActivity(getDb(), user, caseId, { category, who, q: sp.q, cursor: sp.cursor }));

  return (
    <PageBody>
      <PageHeader title="Activity" description="Everything recorded in this case, newest first. Entries are never edited or removed: a correction is added as a new entry linked to the one it corrects." />
      <FilterBar
        className="mt-6"
        searchLabel="Search activity"
        searchHint="e.g. REQ-412/2026-002 or Account B"
        resetParams={["cursor"]}
        selects={[
          {
            param: "category",
            label: "Kind of change",
            allValue: "",
            options: [{ value: "", label: "All kinds" }, ...(Object.entries(ACTIVITY_CATEGORIES) as [ActivityCategory, string][]).map(([value, label]) => ({ value, label }))],
          },
          {
            param: "who",
            label: "Recorded by",
            allValue: "",
            options: [
              { value: "", label: "Officers and automatic" },
              { value: "OFFICERS", label: "Officers" },
              { value: "SYSTEM", label: "Automatic updates" },
            ],
          },
        ]}
      />
      <ActivityFeed caseId={caseId} events={data.events} filtered={!!(category || who || sp.q)} nextCursor={data.nextCursor} isFirstPage={!sp.cursor} />
    </PageBody>
  );
}
