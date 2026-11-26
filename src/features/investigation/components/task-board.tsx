"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { CheckCircle2, Circle, Plus, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DetailDrawer } from "@/components/ui/drawer";
import { FormField, Input, Select, Textarea } from "@/components/ui/field";
import { InlineAlert } from "@/components/ui/feedback";
import { StatusBadge, Tag } from "@/components/app/status-badge";
import { DateTime } from "@/components/app/datetime";
import { EvidenceLink } from "@/components/app/evidence-link";
import { EmptyState } from "@/components/app/states";
import { NextActionButton } from "@/components/app/next-action-button";
import { useServerAction } from "@/features/shared/use-action";
import { assignTaskAction, completeTaskAction, createOfficerTaskAction, deferTaskAction, dismissTaskAction, reopenTaskAction } from "@/features/tasks/actions";
import { refreshRecommendationsAction } from "@/features/cases/actions";
import { OBJECTIVE_LABELS, REQUEST_CATEGORY_LABELS } from "@/lib/labels";
import type { TaskListData } from "@/server/services/investigation";
import { cn } from "@/lib/cn";
import { formatDateIST } from "@/domain/time";

type Task = TaskListData["tasks"][number];

function TaskDetails({ caseId, t, data, onDone }: { caseId: string; t: Task; data: TaskListData; onDone: () => void }) {
  const [mode, setMode] = useState<null | "defer" | "dismiss" | "complete">(null);
  const [reason, setReason] = useState("");
  const [until, setUntil] = useState("");
  const [evidenceId, setEvidenceId] = useState("");
  const assign = useServerAction(assignTaskAction);
  const defer = useServerAction(deferTaskAction);
  const dismiss = useServerAction(dismissTaskAction);
  const complete = useServerAction(completeTaskAction);
  const reopen = useServerAction(reopenTaskAction);
  const closed = ["COMPLETED", "SUPERSEDED", "DISMISSED"].includes(t.status);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap gap-1.5">
        <StatusBadge kind="task" value={t.status} />
        <Tag>{OBJECTIVE_LABELS[t.objective] ?? t.objective}</Tag>
        {t.priority === "HIGH" ? <Tag tone="warning">High priority</Tag> : null}
        {t.kind === "MISSING_INFORMATION" ? <Tag tone="warning">Missing information</Tag> : null}
        {t.generatedBy === "OFFICER" ? <Tag>Added by an officer</Tag> : <Tag>Proposed by next-action rules</Tag>}
      </div>
      {t.statusReason ? <InlineAlert tone={t.status === "SUPERSEDED" ? "info" : "warning"} title={t.status === "SUPERSEDED" ? "Superseded" : "Status note"}>{t.statusReason}</InlineAlert> : null}
      <dl className="flex flex-col gap-3 text-body">
        {[
          ["Unresolved question", t.question],
          ["Purpose", t.purpose],
          ["Why it matters now", t.relevance],
          ["Intended recipient and channel", t.recipientHint ? `${t.recipientHint}${t.requestCategory ? ` (${REQUEST_CATEGORY_LABELS[t.requestCategory]})` : ""}` : "No external request involved"],
          ["Requested scope", t.scope ?? "Not applicable"],
          ["Expected clarification", t.expectedClarification],
          ["Priority basis", t.priorityReason],
        ].map(([k, v]) => (
          <div key={k}>
            <dt className="text-label text-ink-3">{k}</dt>
            <dd className="mt-0.5 text-ink">{v}</dd>
          </div>
        ))}
        {t.periodFrom ? (
          <div>
            <dt className="text-label text-ink-3">Period</dt>
            <dd className="mt-0.5 text-ink">
              <DateTime iso={t.periodFrom} mode="date" /> to <DateTime iso={t.periodTo} mode="date" />
            </dd>
          </div>
        ) : null}
      </dl>
      {t.prerequisites.length ? (
        <div>
          <h3 className="text-label font-semibold text-ink-2">Prerequisites</h3>
          <ul className="mt-1.5 flex flex-col gap-1.5">
            {t.prerequisites.map((p) => (
              <li key={p.label} className="flex gap-2 text-body">
                {p.met ? <CheckCircle2 aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-success" /> : <Circle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-[#c07a1c]" />}
                <span>
                  <span className="text-ink">{p.label}</span>
                  <span className="sr-only">{p.met ? " (met)" : " (not met)"}</span>
                  <span className="block text-label text-ink-2">{p.basis}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div>
        <h3 className="text-label font-semibold text-ink-2">Supporting Sources</h3>
        {t.sources.length ? (
          <ul className="mt-1.5 flex flex-col gap-2">
            {t.sources.map((s, i) => (
              <li key={i}>
                <EvidenceLink caseId={caseId} source={s} showExcerpt />
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-body text-ink-2">No document source is attached to this action.</p>
        )}
      </div>
      {t.request ? (
        <p className="text-body text-ink-2">
          Linked request:{" "}
          <Link href={`/cases/${caseId}/requests/${t.request.id}`} className="font-medium text-action hover:underline">
            {t.request.reference}
          </Link>{" "}
          <StatusBadge kind="request" value={t.request.status} className="align-middle" />
        </p>
      ) : null}

      <div className="border-t border-line pt-4">
        <FormField label="Assigned to">
          <Select value={t.assigneeId ?? ""} onChange={(e) => assign.run([t.id, t.version, e.target.value || null], { success: "Assignment saved" })}>
            <option value="">Not assigned</option>
            {data.assignable.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </Select>
        </FormField>
      </div>

      {mode === "defer" ? (
        <div className="flex flex-col gap-3 rounded-[var(--radius-control)] border border-line p-3">
          <FormField label="Defer until" optionalLabel>
            <Input type="date" value={until} onChange={(e) => setUntil(e.target.value)} />
          </FormField>
          <FormField label="Reason" required error={defer.fieldErrors.reason}>
            <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
          </FormField>
          <div className="flex gap-2">
            <Button size="sm" variant="primary" loading={defer.pending} onClick={() => defer.run([t.id, t.version, until, reason], { success: "Action deferred", onSuccess: onDone })}>
              Defer action
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setMode(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : mode === "dismiss" ? (
        <div className="flex flex-col gap-3 rounded-[var(--radius-control)] border border-line p-3">
          <FormField label="Reason for dismissing" required error={dismiss.fieldErrors.reason} hint="Kept on record. Dismissed actions are not proposed again.">
            <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
          </FormField>
          <div className="flex gap-2">
            <Button size="sm" variant="danger" loading={dismiss.pending} onClick={() => dismiss.run([t.id, t.version, reason], { success: "Action dismissed", onSuccess: onDone })}>
              Dismiss action
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setMode(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : mode === "complete" ? (
        <div className="flex flex-col gap-3 rounded-[var(--radius-control)] border border-line p-3">
          <FormField label="What was done" required error={complete.fieldErrors.note}>
            <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
          </FormField>
          <FormField label="Evidence of completion" optionalLabel error={complete.fieldErrors.evidenceId}>
            <Select value={evidenceId} onChange={(e) => setEvidenceId(e.target.value)}>
              <option value="">No document</option>
              {data.evidence.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.title}
                </option>
              ))}
            </Select>
          </FormField>
          <div className="flex gap-2">
            <Button size="sm" variant="primary" loading={complete.pending} onClick={() => complete.run([t.id, t.version, reason, evidenceId || null], { success: "Action completed", onSuccess: onDone })}>
              Mark complete
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setMode(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {closed ? (
            <Button size="sm" variant="secondary" loading={reopen.pending} onClick={() => reopen.run([t.id, t.version], { success: "Action reopened" })}>
              Reopen action
            </Button>
          ) : (
            <>
              <NextActionButton caseId={caseId} task={t} />
              <Button size="sm" variant="secondary" onClick={() => setMode("complete")}>
                Mark complete
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setMode("defer")}>
                Defer
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setMode("dismiss")}>
                Dismiss
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function NewTask({ caseId, data, open, onOpenChange }: { caseId: string; data: TaskListData; open: boolean; onOpenChange: (o: boolean) => void }) {
  const create = useServerAction(createOfficerTaskAction);
  const [f, setF] = useState({ title: "", objective: "IDENTITY", question: "", purpose: "", dueDate: "", assigneeId: "" });
  const formId = "new-task-form";
  return (
    <DetailDrawer
      open={open}
      onOpenChange={onOpenChange}
      title="Add a task"
      subtitle="For work the rules did not propose. State the question it answers."
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form={formId} variant="primary" loading={create.pending}>
            Add task
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          create.run([caseId, { ...f, assigneeId: f.assigneeId || null }], { success: "Task added", onSuccess: () => onOpenChange(false) });
        }}
      >
        <FormField label="Title" required error={create.fieldErrors.title}>
          <Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
        </FormField>
        <FormField label="Objective" required error={create.fieldErrors.objective}>
          <Select value={f.objective} onChange={(e) => setF({ ...f, objective: e.target.value })}>
            {Object.entries(OBJECTIVE_LABELS).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="Question this answers" required error={create.fieldErrors.question}>
          <Textarea rows={2} value={f.question} onChange={(e) => setF({ ...f, question: e.target.value })} />
        </FormField>
        <FormField label="Purpose" optionalLabel>
          <Textarea rows={2} value={f.purpose} onChange={(e) => setF({ ...f, purpose: e.target.value })} />
        </FormField>
        <FormField label="Follow up by" optionalLabel error={create.fieldErrors.dueDate} hint="A working reminder, not a legal deadline.">
          <Input type="date" value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} />
        </FormField>
        <FormField label="Assign to" optionalLabel>
          <Select value={f.assigneeId} onChange={(e) => setF({ ...f, assigneeId: e.target.value })}>
            <option value="">Not assigned</option>
            {data.assignable.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </Select>
        </FormField>
      </form>
    </DetailDrawer>
  );
}

export function TaskBoard({ caseId, data }: { caseId: string; data: TaskListData }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const openId = params.get("task");
  const selected = data.tasks.find((t) => t.id === openId) ?? null;
  const [newOpen, setNewOpen] = useState(false);
  const refresh = useServerAction(refreshRecommendationsAction);
  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    router.replace(`${pathname}${next.size ? `?${next}` : ""}`, { scroll: false });
  };
  const groups = [
    { title: "Need action", items: data.tasks.filter((t) => t.status === "OPEN" || t.status === "DRAFT_PREPARED") },
    { title: "Waiting on a reply", items: data.tasks.filter((t) => t.status === "WAITING") },
    { title: "Deferred", items: data.tasks.filter((t) => t.status === "DEFERRED") },
    { title: "Closed", items: data.tasks.filter((t) => ["COMPLETED", "SUPERSEDED", "DISMISSED"].includes(t.status)) },
  ].filter((g) => g.items.length);
  const statusView = params.get("status") ?? "active";

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div className="flex flex-wrap items-end gap-3">
          <FormField label="Show">
            <Select value={statusView} onChange={(e) => setParam("status", e.target.value === "active" ? null : e.target.value)}>
              <option value="active">Active actions</option>
              <option value="closed">Closed actions</option>
              <option value="all">All actions</option>
            </Select>
          </FormField>
          <FormField label="Objective">
            <Select value={params.get("objective") ?? ""} onChange={(e) => setParam("objective", e.target.value || null)}>
              <option value="">All objectives</option>
              {Object.entries(OBJECTIVE_LABELS).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
          </FormField>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" icon={<RefreshCw aria-hidden="true" />} loading={refresh.pending} onClick={() => refresh.run([caseId], { success: "Next actions rechecked against the current case facts" })}>
            Recheck next actions
          </Button>
          <Button variant="primary" icon={<Plus aria-hidden="true" />} onClick={() => setNewOpen(true)}>
            Add task
          </Button>
        </div>
      </div>

      {groups.length ? (
        groups.map((g) => (
          <section key={g.title} aria-labelledby={`g-${g.title}`} className="panel">
            <h3 id={`g-${g.title}`} className="border-b border-line px-5 py-3 text-section font-semibold tracking-tight text-ink">
              {g.title} <span className="font-normal text-ink-3">{g.items.length}</span>
            </h3>
            <ul className="divide-y divide-line">
              {g.items.map((t) => (
                <li key={t.id} className={cn("flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-start", t.id === openId && "bg-surface-muted")}>
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-meta text-ink-3">
                      <span>{OBJECTIVE_LABELS[t.objective]}</span>
                      {t.priority === "HIGH" ? <span className="font-medium text-warning">High priority</span> : null}
                      {t.kind === "MISSING_INFORMATION" ? <span className="font-medium text-ink-2">Missing information</span> : null}
                      {t.assignee ? <span>Assigned to {t.assignee}</span> : null}
                    </p>
                    <button type="button" onClick={() => setParam("task", t.id)} className="mt-0.5 text-left font-medium text-ink hover:text-action hover:underline">
                      {t.title}
                    </button>
                    <p className="mt-0.5 text-body text-ink-2">{t.question}</p>
                    {t.statusReason && g.title === "Closed" ? <p className="mt-1 text-label text-ink-3">{t.statusReason}</p> : null}
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-2 sm:flex-col sm:items-end">
                    <StatusBadge kind="task" value={t.status} />
                    <div className="flex gap-2">
                      <NextActionButton caseId={caseId} task={t} />
                      <Button size="sm" variant="ghost" onClick={() => setParam("task", t.id)}>
                        Details
                      </Button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))
      ) : (
        <div className="panel">
          <EmptyState title={statusView === "closed" ? "No closed actions" : "No active actions"} description="Actions appear here as facts are recorded and responses are reviewed. Recheck if you have just added information." />
        </div>
      )}

      <DetailDrawer open={!!selected} onOpenChange={(o) => !o && setParam("task", null)} title={selected?.title ?? "Action"} subtitle={selected ? `Proposed ${formatDateIST(new Date(selected.createdAt))}` : undefined} width="lg">
        {selected ? <TaskDetails caseId={caseId} t={selected} data={data} onDone={() => setParam("task", null)} /> : null}
      </DetailDrawer>
      <NewTask caseId={caseId} data={data} open={newOpen} onOpenChange={setNewOpen} />
    </div>
  );
}
