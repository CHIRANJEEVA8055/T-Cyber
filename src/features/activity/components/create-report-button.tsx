"use client";

import { useRouter } from "next/navigation";
import { FilePlus2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useServerAction } from "@/features/shared/use-action";
import { createReportAction } from "@/features/activity/actions";
import type { ReportKind } from "@/server/services/reports";

/** Drafts a report from the current case records and opens it for review. */
export function CreateReportButton({ caseId, kind, label, variant = "secondary" }: { caseId: string; kind: ReportKind; label: string; variant?: "primary" | "secondary" }) {
  const router = useRouter();
  const create = useServerAction(createReportAction);
  return (
    <Button
      variant={variant}
      icon={<FilePlus2 aria-hidden="true" />}
      loading={create.pending}
      onClick={() =>
        create.run([caseId, kind], {
          success: "Draft ready for review",
          onSuccess: (r) => router.push(`/cases/${caseId}/activity/reports/${r.reportId}`),
        })
      }
    >
      {label}
    </Button>
  );
}
