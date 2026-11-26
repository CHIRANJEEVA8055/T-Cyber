import Link from "next/link";
import { FileText } from "lucide-react";
import { cn } from "@/lib/cn";
import { citationLabel, evidenceHref } from "@/lib/evidence-href";

export interface SourceRef {
  evidenceId: string;
  evidenceTitle?: string;
  locator: string;
  excerpt?: string | null;
  stance?: string;
}

/** Links a fact to the exact place in the original document it came from. */
export function EvidenceLink({ caseId, source, className, showExcerpt = false }: { caseId: string; source: SourceRef; className?: string; showExcerpt?: boolean }) {
  const href = evidenceHref(caseId, source.evidenceId, source.locator);
  const contradicts = source.stance === "CONTRADICTS";
  return (
    <span className={cn("inline-flex min-w-0 flex-col", className)}>
      <Link href={href} className="inline-flex min-w-0 items-center gap-1.5 text-label font-medium text-action hover:underline">
        <FileText aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="truncate">{citationLabel(source.evidenceTitle, source.locator)}</span>
        {contradicts ? <span className="shrink-0 rounded-[var(--radius-chip)] bg-danger-tint px-1 text-meta text-danger">contradicts</span> : null}
      </Link>
      {showExcerpt && source.excerpt ? <span className="mt-0.5 line-clamp-2 font-mono text-meta text-ink-3">{source.excerpt}</span> : null}
    </span>
  );
}
