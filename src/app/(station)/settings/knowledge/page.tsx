import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/server/auth/current-user";
import { getDb } from "@/server/db";
import { getGuidanceLibrary } from "@/server/services/assistant";
import { PageBody, PageHeader } from "@/components/app/page";
import { Button } from "@/components/ui/button";
import { LibraryPanel } from "@/features/assistant/components/guidance-assistant";

export const metadata: Metadata = { title: "Knowledge library" };

export default async function KnowledgePage() {
  const user = await requireUser();
  const library = await getGuidanceLibrary(getDb(), user);
  return (
    <PageBody>
      <PageHeader
        title="Knowledge Library"
        description="The approved documents that AI guidance and Case AI quote, with their versions, dates and status. They are synthetic and load with the demonstration data; this build does not add or edit documents."
        actions={
          <Button asChild variant="secondary">
            <Link href="/guidance">Ask AI guidance</Link>
          </Button>
        }
      />
      <div className="mt-6 max-w-3xl">
        <LibraryPanel library={library} />
      </div>
    </PageBody>
  );
}
