"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useRef, useState } from "react";
import { ChevronRight, LockOpen, Lock, PencilLine } from "lucide-react";
import { cn } from "@/lib/cn";
import { useRevealCurrent } from "@/components/app/use-reveal-current";
import { StatusBadge, Tag } from "@/components/app/status-badge";
import { DateTime } from "@/components/app/datetime";
import { ActionMenu, ActionMenuItem } from "@/components/ui/menu";
import { Dialog, DialogContent, ConfirmationDialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { FormField, Input, Select, Textarea } from "@/components/ui/field";
import { MO_VERTICALS } from "@/domain/mo-verticals";
import { useServerAction } from "@/features/shared/use-action";
import { setCaseStatusAction, updateCaseDetailsAction } from "@/features/cases/actions";
import type { CaseHeaderData } from "@/server/services/overview";
import { formatSections } from "@/domain/legal-sections";

const TABS = [
  { href: "", label: "Overview" },
  { href: "/investigation", label: "Investigation" },
  { href: "/funds", label: "Funds" },
  { href: "/requests", label: "Requests" },
  { href: "/evidence", label: "Evidence" },
  { href: "/graph", label: "Graph" },
  { href: "/activity", label: "Activity & reports" },
  { href: "/assistant", label: "Case AI" },
];

export function CaseHeader({ c }: { c: CaseHeaderData }) {
  const pathname = usePathname();
  const sectionStrip = useRef<HTMLElement>(null);
  useRevealCurrent(sectionStrip, pathname);
  const base = `/cases/${c.id}`;
  return (
    <div className="no-print border-b border-line bg-surface">
      <div className="mx-auto w-full max-w-[1440px] px-4 pt-4 sm:px-6 lg:px-8">
        <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-label text-ink-3">
          <Link href="/cases" className="hover:text-ink hover:underline">
            Cases
          </Link>
          <ChevronRight aria-hidden="true" className="size-3.5" />
          <span aria-current="page" className="text-ink-2">
            {c.reference}
          </span>
        </nav>
        <div className="mt-2 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-title font-semibold tracking-tight text-ink">{c.reference}</h1>
              <StatusBadge kind="case" value={c.status} />
              {c.referenceType === "COMPLAINT" ? <Tag tone="warning">FIR not yet available</Tag> : null}
              {c.isDemo ? <Tag>Synthetic demonstration case</Tag> : null}
            </div>
            <p className="mt-1 text-body text-ink-2">{c.title}</p>
            <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1.5 text-label">
              <div className="flex gap-1.5">
                <dt className="text-ink-3">Station</dt>
                <dd className="text-ink">{c.stationName}</dd>
              </div>
              <div className="flex gap-1.5">
                <dt className="text-ink-3">Investigating officer</dt>
                <dd className="text-ink">{c.investigatingOfficer}</dd>
              </div>
              <div className="flex gap-1.5">
                <dt className="text-ink-3">{c.referenceType === "FIR" ? "Registered" : "Opened"}</dt>
                <dd className="text-ink">
                  <DateTime iso={c.registeredAt} mode="date" />
                </dd>
              </div>
              <div className="flex gap-1.5">
                <dt className="text-ink-3">Legal sections</dt>
                <dd className={c.legalSections ? "text-ink" : "text-ink-3"}>{c.legalSections ? formatSections(c.legalSections) : "Not entered by an officer"}</dd>
              </div>
            </dl>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <CaseActions c={c} />
          </div>
        </div>
        {c.status === "CLOSED" && c.closureReason ? <p className="mt-3 text-label text-ink-2">Closed: {c.closureReason}</p> : null}
        <nav ref={sectionStrip} aria-label="Case sections" className="-mx-4 mt-3 overflow-x-auto px-4 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
          <ul className="flex min-w-max gap-1">
            {TABS.map((t) => {
              const href = `${base}${t.href}`;
              const active = t.href === "" ? pathname === base : pathname.startsWith(href);
              return (
                <li key={t.label}>
                  <Link
                    href={href}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "relative inline-flex h-11 items-center gap-1.5 px-3 text-body font-medium",
                      active ? "text-action after:absolute after:inset-x-2 after:bottom-0 after:h-[2px] after:rounded-full after:bg-action" : "text-ink-2 hover:text-ink",
                    )}
                  >
                    {t.label}
                    {t.href === "/requests" && c.responsesToReview > 0 ? (
                      <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-warning-tint px-1.5 text-meta font-semibold text-warning">
                        {c.responsesToReview}
                        <span className="sr-only"> responses to review</span>
                      </span>
                    ) : null}
                    {t.href === "/evidence" && c.candidatesPending > 0 ? (
                      <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-surface-sunken px-1.5 text-meta font-semibold text-ink-2">
                        {c.candidatesPending}
                        <span className="sr-only"> extracted items to review</span>
                      </span>
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </div>

    </div>
  );
}

/** Edit details and close/reopen: one menu, shared by the case header (narrow screens) and the case sidebar. */
export function CaseActions({ c, triggerClassName }: { c: CaseHeaderData; triggerClassName?: string }) {
  const [editOpen, setEditOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [reason, setReason] = useState("");
  const statusAction = useServerAction(setCaseStatusAction);
  const closing = c.status === "OPEN";
  return (
    <>
      <ActionMenu label="Case actions" triggerClassName={triggerClassName}>
        <ActionMenuItem icon={<PencilLine aria-hidden="true" />} onSelect={() => setEditOpen(true)} description="Title, category, legal sections, narrative">
          Edit case details
        </ActionMenuItem>
        <ActionMenuItem icon={closing ? <Lock aria-hidden="true" /> : <LockOpen aria-hidden="true" />} onSelect={() => setStatusOpen(true)} description={closing ? "Explicit officer decision with a reason" : "Resume work on this case"}>
          {closing ? "Close case" : "Reopen case"}
        </ActionMenuItem>
      </ActionMenu>
      <EditCaseDialog c={c} open={editOpen} onOpenChange={setEditOpen} />
      <ConfirmationDialog
        open={statusOpen}
        onOpenChange={(o) => {
          setStatusOpen(o);
          if (!o) {
            setReason("");
            statusAction.reset();
          }
        }}
        title={closing ? `Close ${c.reference}?` : `Reopen ${c.reference}?`}
        description={closing ? "Closing is an officer decision. Financial and investigation records stay on the case, and open actions remain on record." : "The case returns to the open list and work can continue."}
        confirmLabel={closing ? "Close case" : "Reopen case"}
        tone={closing ? "danger" : "primary"}
        onConfirm={async () => {
          const r = await statusAction.run([c.id, { expectedVersion: c.version, status: closing ? "CLOSED" : "OPEN", reason }], { success: closing ? "Case closed" : "Case reopened" });
          return r.ok;
        }}
      >
        <FormField label="Reason" required error={statusAction.fieldErrors.reason} hint="Recorded in the activity log.">
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} />
        </FormField>
      </ConfirmationDialog>
    </>
  );
}

function EditCaseDialog({ c, open, onOpenChange }: { c: CaseHeaderData; open: boolean; onOpenChange: (o: boolean) => void }) {
  const action = useServerAction(updateCaseDetailsAction);
  const initial = () => ({ title: c.title, fraudCategory: c.fraudCategory ?? "", legalSections: c.legalSections ?? "", narrative: c.narrative, moVertical: c.mo.vertical ?? "", moSubtype: c.mo.subtype ?? "" });
  const [form, setForm] = useState(initial);
  const kinds = MO_VERTICALS.find((v) => v.key === form.moVertical)?.kinds ?? [];
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (o) setForm(initial());
      }}
    >
      <DialogContent
        title={`Edit ${c.reference}`}
        description="Changes are recorded in the activity log with the previous values."
        size="lg"
        footer={
          <>
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={action.pending}
              onClick={() =>
                action.run([c.id, { expectedVersion: c.version, title: form.title, narrative: form.narrative, legalSections: form.legalSections || null, fraudCategory: form.fraudCategory || null, moVertical: form.moVertical || null, moSubtype: form.moSubtype || null }], {
                  success: "Case details saved",
                  onSuccess: () => onOpenChange(false),
                })
              }
            >
              Save changes
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {action.error && !Object.keys(action.fieldErrors).length ? <p className="text-body text-danger">{action.error}</p> : null}
          <FormField label="Case title" required error={action.fieldErrors.title}>
            <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </FormField>
          <FormField label="Category" optionalLabel>
            <Input value={form.fraudCategory} onChange={(e) => setForm({ ...form, fraudCategory: e.target.value })} />
          </FormField>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              label="Investigation vertical"
              error={action.fieldErrors.moVertical}
              hint={
                !form.moVertical
                  ? "On saving, the FIR is classified again: as it states the MO, or else by the local model from its brief (this can take a few seconds)."
                  : form.moVertical === c.mo.vertical && form.moSubtype === (c.mo.subtype ?? "")
                    ? c.mo.line
                    : "Your choice, recorded as set by an officer."
              }
            >
              <Select value={form.moVertical} onChange={(e) => setForm({ ...form, moVertical: e.target.value, moSubtype: "" })}>
                <option value="">Classify again from the FIR</option>
                {MO_VERTICALS.map((v) => (
                  <option key={v.key} value={v.key}>
                    {v.label}
                  </option>
                ))}
              </Select>
            </FormField>
            {form.moVertical && kinds.length ? (
              <FormField label="Kind of fraud" optionalLabel hint={`As the MO table lists under ${MO_VERTICALS.find((v) => v.key === form.moVertical)?.label}.`}>
                <Select value={form.moSubtype} onChange={(e) => setForm({ ...form, moSubtype: e.target.value })}>
                  <option value="">Not specified</option>
                  {kinds.map((k) => (
                    <option key={k.label} value={k.label}>
                      {k.label}
                    </option>
                  ))}
                </Select>
              </FormField>
            ) : null}
          </div>
          <FormField label="Legal sections" optionalLabel hint="Enter only the sections recorded on the FIR or decided by an officer. T-CYBER never suggests sections.">
            <Input value={form.legalSections} onChange={(e) => setForm({ ...form, legalSections: e.target.value })} />
          </FormField>
          <FormField label="Narrative" hint="A short factual summary of the complaint.">
            <Textarea value={form.narrative} onChange={(e) => setForm({ ...form, narrative: e.target.value })} rows={6} />
          </FormField>
        </div>
      </DialogContent>
    </Dialog>
  );
}
