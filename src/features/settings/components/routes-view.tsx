"use client";

import { useState } from "react";
import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DetailDrawer } from "@/components/ui/drawer";
import { FormField, Input, Select, Textarea } from "@/components/ui/field";
import { InlineAlert } from "@/components/ui/feedback";
import { DataTable } from "@/components/app/data-table";
import { IDENTIFIER_KIND_LABELS } from "@/contracts/case";
import { channelText, REQUEST_CATEGORY_LABELS } from "@/lib/labels";
import { useServerAction } from "@/features/shared/use-action";
import { updateRouteAction } from "@/features/settings/actions";
import type { RouteView } from "@/server/services/settings";

const APPROVAL_LABELS: Record<string, string> = {
  SUPERVISOR: "A supervisor",
  INVESTIGATING_OFFICER: "Any other officer (not the one who prepared it)",
};
/** Short forms for the table, where the editor's full wording would wrap. */
const APPROVAL_SHORT: Record<string, string> = {
  SUPERVISOR: "Supervisor",
  INVESTIGATING_OFFICER: "Another officer",
};

function RouteEditor({ route, onClose, gmail }: { route: RouteView | null; onClose: () => void; gmail: { on: boolean; connected: boolean; account: string | null } | null }) {
  const [form, setForm] = useState<{ approvalRole: string; followUpDays: string; procedureNote: string } | null>(null);
  const save = useServerAction(updateRouteAction);
  const current = form ?? (route ? { approvalRole: route.approvalRole, followUpDays: String(route.followUpDays), procedureNote: route.procedureNote } : null);
  const close = () => {
    setForm(null);
    save.reset();
    onClose();
  };
  const set = (k: "approvalRole" | "followUpDays" | "procedureNote", v: string) => setForm({ ...current!, [k]: v });
  return (
    <DetailDrawer
      open={!!route}
      onOpenChange={(o) => !o && !save.pending && close()}
      title={route?.name ?? "Route"}
      subtitle={route ? `${IDENTIFIER_KIND_LABELS[route.subjectKind] ?? route.subjectKind}, ${REQUEST_CATEGORY_LABELS[route.category] ?? route.category}` : undefined}
      footer={
        route && current ? (
          <>
            <Button variant="secondary" onClick={close} disabled={save.pending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={save.pending}
              onClick={() =>
                save.run([route.id, { approvalRole: current.approvalRole, followUpDays: Number(current.followUpDays), procedureNote: current.procedureNote, expectedUpdatedAt: route.updatedAt }], {
                  success: "Route saved",
                  onSuccess: close,
                })
              }
            >
              Save route
            </Button>
          </>
        ) : undefined
      }
    >
      {route && current ? (
        <div className="flex flex-col gap-5">
          <dl className="grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-4 gap-y-1.5 text-body">
            <dt className="text-ink-3">Recipient</dt>
            <dd className="text-ink">{route.recipientLabel}</dd>
            <dt className="text-ink-3">Channel</dt>
            <dd className="text-ink">{route.channel ? channelText(route.channel, gmail) : "From the recipient"}</dd>
            <dt className="text-ink-3">Template</dt>
            <dd className="text-ink">{route.templateName ?? "Standard wording for the request type"}</dd>
          </dl>
          {save.error && !Object.keys(save.fieldErrors).length ? <InlineAlert tone="danger">{save.error}</InlineAlert> : null}
          <FormField label="Who approves requests on this route" required error={save.fieldErrors.approvalRole}>
            <Select value={current.approvalRole} onChange={(e) => set("approvalRole", e.target.value)}>
              {Object.entries(APPROVAL_LABELS).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Follow up after (days)" required error={save.fieldErrors.followUpDays} hint="Counted from submission. Applies to requests submitted after you save; earlier follow-up dates do not change." validate={(v) => (/^\d+$/.test(v.trim()) && Number(v) >= 1 && Number(v) <= 60 ? null : "Enter a whole number of days from 1 to 60.")}>
            <Input type="number" inputMode="numeric" min={1} max={60} value={current.followUpDays} onChange={(e) => set("followUpDays", e.target.value)} className="max-w-[8rem]" />
          </FormField>
          <FormField label="Procedure note" required error={save.fieldErrors.procedureNote} hint="Shown to officers on each request that uses this route." validate={(v) => (v.trim().length < 10 ? "Describe the procedure in at least 10 characters." : null)}>
            <Textarea rows={4} value={current.procedureNote} onChange={(e) => set("procedureNote", e.target.value)} maxLength={500} />
          </FormField>
        </div>
      ) : null}
    </DetailDrawer>
  );
}

export function RoutesView({ routes, canManage, gmail = null }: { routes: RouteView[]; canManage: boolean; gmail?: { on: boolean; connected: boolean; account: string | null } | null }) {
  const [editing, setEditing] = useState<RouteView | null>(null);
  return (
    <>
      <DataTable<RouteView>
        caption="Routes"
        rows={routes}
        rowKey={(r) => r.id}
        minWidth={900}
        cardBelow="lg"
        columns={[
          {
            key: "route",
            header: "Route",
            cell: (r) => (
              <div className="min-w-0">
                <p className="font-medium text-ink">{r.name}</p>
                <p className="text-label text-ink-3">
                  {IDENTIFIER_KIND_LABELS[r.subjectKind] ?? r.subjectKind}, {(REQUEST_CATEGORY_LABELS[r.category] ?? r.category).toLowerCase()}
                </p>
              </div>
            ),
          },
          { key: "to", header: "Sent to", cell: (r) => <span className="text-ink-2">{r.recipientLabel}</span> },
          { key: "approval", header: "Approved by", cell: (r) => <span className="whitespace-nowrap text-ink-2">{APPROVAL_SHORT[r.approvalRole] ?? r.approvalRole}</span> },
          { key: "follow", header: "Follow-up", align: "right", cell: (r) => <span className="whitespace-nowrap tabular-nums">{r.followUpDays} days</span> },
          { key: "note", header: "Procedure note", hideBelow: "lg", className: "max-w-[22rem]", cell: (r) => <span className="text-label text-ink-2">{r.procedureNote}</span> },
          {
            key: "edit",
            header: <span className="sr-only">Actions</span>,
            cell: (r) =>
              canManage ? (
                <Button size="sm" variant="secondary" icon={<Pencil aria-hidden="true" />} onClick={() => setEditing(r)}>
                  Edit route
                </Button>
              ) : null,
          },
        ]}
        mobileCard={(r) => (
          <div className="flex flex-col gap-2">
            <p className="text-body font-medium text-ink">{r.name}</p>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-label">
              <dt className="text-ink-3">Sent to</dt>
              <dd className="text-ink-2">{r.recipientLabel}</dd>
              <dt className="text-ink-3">Approved by</dt>
              <dd className="text-ink-2">{APPROVAL_SHORT[r.approvalRole] ?? r.approvalRole}</dd>
              <dt className="text-ink-3">Follow-up</dt>
              <dd className="tabular-nums text-ink-2">{r.followUpDays} days after submission</dd>
            </dl>
            {canManage ? (
              <Button size="sm" variant="secondary" icon={<Pencil aria-hidden="true" />} className="self-start" onClick={() => setEditing(r)}>
                Edit route
              </Button>
            ) : null}
          </div>
        )}
      />
      <RouteEditor route={editing} onClose={() => setEditing(null)} gmail={gmail} />
    </>
  );
}
