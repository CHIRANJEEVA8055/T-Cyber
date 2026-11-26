"use client";

import { FlaskConical, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tag } from "@/components/app/status-badge";
import { DateTime } from "@/components/app/datetime";
import { useServerAction } from "@/features/shared/use-action";
import { setFailureSimulationAction } from "@/features/settings/actions";
import type { IntegrationView } from "@/server/services/settings";

const MODE_LABELS: Record<string, string> = { SIMULATED: "Simulated", DEMO_LOCAL: "Rules first, then the local model (Ollama) when running" };

function FailureControl({ i, canManage }: { i: IntegrationView; canManage: boolean }) {
  const set = useServerAction(setFailureSimulationAction);
  return (
    <div className="mt-3 flex flex-col gap-2 rounded-[var(--radius-control)] border border-line bg-surface-muted p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 text-label">
        <p className={i.failNextSubmission ? "font-medium text-warning" : "text-ink-2"}>
          {i.failNextSubmission ? "The next simulated submission on this route will fail once, then the setting clears itself." : "Simulated submissions on this route succeed."}
        </p>
        {i.updatedBy ? (
          <p className="text-ink-3">
            Last changed by {i.updatedBy}, <DateTime iso={i.updatedAt} />
          </p>
        ) : null}
      </div>
      {canManage ? (
        i.failNextSubmission ? (
          <Button size="sm" variant="secondary" icon={<Undo2 aria-hidden="true" />} loading={set.pending} onClick={() => set.run([i.key, false], { success: "Simulated failure cancelled" })}>
            Cancel the simulated failure
          </Button>
        ) : (
          <Button size="sm" variant="secondary" icon={<FlaskConical aria-hidden="true" />} loading={set.pending} onClick={() => set.run([i.key, true], { success: "The next submission will fail once" })}>
            Make the next submission fail
          </Button>
        )
      ) : null}
    </div>
  );
}

export function IntegrationsView({ items, canManage }: { items: IntegrationView[]; canManage: boolean }) {
  return (
    <ul className="flex flex-col gap-4">
      {items.map((i) => (
        <li key={i.key} className="panel p-5">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <h2 className="text-section font-semibold tracking-tight text-ink">{i.label}</h2>
              <p className="mt-1 max-w-[75ch] text-body text-ink-2">{i.note}</p>
            </div>
            <Tag tone="neutral">{MODE_LABELS[i.mode] ?? i.mode}</Tag>
          </div>
          {i.supportsFailureSimulation ? <FailureControl i={i} canManage={canManage} /> : null}
        </li>
      ))}
    </ul>
  );
}
