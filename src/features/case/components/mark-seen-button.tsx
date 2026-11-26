"use client";

import { useState, useTransition } from "react";
import { markOverviewSeenAction } from "../actions";

/** Marks the overview as seen, so only later changes are listed. Shows a plain message if it fails. */
export function MarkSeenButton({ caseId }: { caseId: string }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="row" style={{ gap: 8 }}>
      {error ? (
        <span role="alert" className="mut" style={{ fontSize: 13 }}>
          {error}
        </span>
      ) : null}
      <button
        className="btn sm"
        type="button"
        aria-busy={pending}
        onClick={() =>
          start(async () => {
            setError(null);
            const r = await markOverviewSeenAction(caseId);
            if (!r.ok) setError(r.error);
          })
        }
      >
        {pending ? "Marking…" : "Mark as seen"}
      </button>
    </span>
  );
}
