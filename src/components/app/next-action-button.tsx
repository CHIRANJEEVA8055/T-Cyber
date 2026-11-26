"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { useServerAction } from "@/features/shared/use-action";
import { prepareDraftAction } from "@/features/tasks/actions";

export interface NextActionLite {
  id: string;
  kind: string;
  status: string;
  requestId: string | null;
  responseId: string | null;
  requestCategory: string | null;
  ruleId?: string | null;
}

/** The single contextual action for a recommended next step. It never sends anything externally. */
export function NextActionButton({ caseId, task, size = "sm" }: { caseId: string; task: NextActionLite; size?: "sm" | "md" }) {
  const router = useRouter();
  const prepare = useServerAction(prepareDraftAction);
  if (task.kind === "REVIEW" && task.responseId) {
    return (
      <Button asChild size={size} variant="secondary">
        <Link href={`/cases/${caseId}/responses/${task.responseId}`}>{task.ruleId === "MATCH_RESPONSE" ? "Confirm match" : "Review response"}</Link>
      </Button>
    );
  }
  if (task.requestId && (task.status === "DRAFT_PREPARED" || task.status === "WAITING")) {
    return (
      <Button asChild size={size} variant="secondary">
        <Link href={`/cases/${caseId}/requests/${task.requestId}`}>{task.status === "DRAFT_PREPARED" ? "Open draft" : "View request"}</Link>
      </Button>
    );
  }
  if (task.requestCategory && (task.status === "OPEN" || task.status === "DEFERRED")) {
    return (
      <Button
        size={size}
        variant="secondary"
        loading={prepare.pending}
        onClick={() =>
          prepare.run([task.id], {
            success: "Draft prepared. Review it before requesting approval.",
            onSuccess: (d) => router.push(`/cases/${caseId}/requests/${d.requestId}`),
          })
        }
      >
        Prepare draft
      </Button>
    );
  }
  return null;
}
