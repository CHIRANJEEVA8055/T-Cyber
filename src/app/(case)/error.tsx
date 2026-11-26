"use client";

import { PageBody } from "@/components/app/page";
import { ErrorState } from "@/components/app/states";

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const details = JSON.stringify({ message: "Unexpected error while rendering this view", digest: error.digest ?? null, route: typeof window !== "undefined" ? window.location.pathname : null, at: new Date().toISOString() });
  return (
    <PageBody>
      <div className="panel">
        <ErrorState onRetry={reset} details={details} />
      </div>
    </PageBody>
  );
}
