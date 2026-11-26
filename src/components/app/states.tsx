"use client";

import { useState, type ReactNode } from "react";
import { AlertOctagon, Copy, Check } from "lucide-react";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";
import { copyText } from "@/lib/browser";

/** Empty state: what belongs here, why it matters, and one action. Keeps the frame of the view. */
export function EmptyState({ title, description, action, secondaryAction, icon, className, compact }: { title: string; description: ReactNode; action?: ReactNode; secondaryAction?: ReactNode; icon?: ReactNode; className?: string; compact?: boolean }) {
  return (
    <div className={cn("flex flex-col items-center px-6 text-center", compact ? "py-8" : "py-14", className)}>
      {icon ? <div className="mb-3 text-ink-3 [&_svg]:size-6">{icon}</div> : null}
      <h3 className="text-section font-semibold text-ink">{title}</h3>
      <p className="mt-1 max-w-md text-body text-ink-2">{description}</p>
      {action || secondaryAction ? (
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          {action}
          {secondaryAction}
        </div>
      ) : null}
    </div>
  );
}

/** Error state for a view or panel: plain explanation, recovery step, and copyable details for support. */
export function ErrorState({ title = "This view could not be loaded", description = "Nothing was changed. Reload the page; if it keeps failing, copy the error details for the system administrator.", details, onRetry, className }: { title?: string; description?: string; details?: string; onRetry?: () => void; className?: string }) {
  const [copied, setCopied] = useState<boolean | null>(null);
  return (
    <div role="alert" className={cn("flex flex-col items-center px-6 py-14 text-center", className)}>
      <AlertOctagon aria-hidden="true" className="mb-3 size-6 text-danger" />
      <h3 className="text-section font-semibold text-ink">{title}</h3>
      <p className="mt-1 max-w-md text-body text-ink-2">{description}</p>
      <div className="mt-4 flex flex-wrap justify-center gap-2">
        {onRetry ? (
          <Button variant="primary" onClick={onRetry}>
            Try again
          </Button>
        ) : null}
        {details ? (
          <Button
            variant="secondary"
            icon={copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
            onClick={async () => {
              setCopied(await copyText(details));
            }}
          >
            {copied ? "Error details copied" : "Copy error details"}
          </Button>
        ) : null}
      </div>
      {details && copied === false ? (
        <div className="mt-4 w-full max-w-xl text-left">
          <p className="text-label text-ink-2">This browser blocked copying. Select the details below and copy them.</p>
          <textarea readOnly aria-label="Error details" value={details} rows={4} onFocus={(e) => e.currentTarget.select()} className="mt-1.5 w-full rounded-[var(--radius-control)] border border-line-input bg-surface p-2 font-mono text-meta text-ink" />
        </div>
      ) : null}
    </div>
  );
}
