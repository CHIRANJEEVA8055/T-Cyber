import Link from "next/link";
import { FolderX } from "lucide-react";
import { PageBody } from "@/components/app/page";
import { EmptyState } from "@/components/app/states";
import { Button } from "@/components/ui/button";

export default function CaseNotFound() {
  return (
    <PageBody>
      <div className="panel">
        <EmptyState
          icon={<FolderX aria-hidden="true" />}
          title="This case does not exist or you do not have access to it"
          description="Case access follows your assignments. Ask the station supervisor if you need to work on this case."
          action={
            <Button asChild variant="primary">
              <Link href="/">Go to the dashboard</Link>
            </Button>
          }
        />
      </div>
    </PageBody>
  );
}
