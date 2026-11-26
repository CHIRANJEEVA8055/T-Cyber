"use client";

import { useEffect, useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { utcToIstDateInput } from "@/domain/time";
import { ITEM_TYPE_LABELS } from "@/lib/labels";
import { Button, IconButton } from "@/components/ui/button";
import { Checkbox, FormField, Input, Select, Textarea } from "@/components/ui/field";
import { InlineAlert } from "@/components/ui/feedback";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { useServerAction } from "@/features/shared/use-action";
import { useUnsavedGuard } from "@/features/shared/use-unsaved-guard";
import { setMailDefaultsAction, updateDraftAction, type DraftForm } from "@/features/requests/actions";
import type { RequestDetail } from "@/server/services/correspondence";
import { closingLines, joinClosing, splitClosing } from "@/domain/closing";

/** The letter is edited as its text and its closing block (the "Yours faithfully," section), and joined to save. */
type FormState = Omit<DraftForm, "expectedVersion" | "body"> & { text: string; closing: string };
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function initialForm(d: RequestDetail): FormState {
  const { text, closing } = splitClosing(d.current.body);
  return {
    recipientId: d.current.recipientId,
    fromAddress: d.current.fromAddress,
    subject: d.current.subject,
    text,
    closing,
    scope: d.current.scope,
    periodFrom: d.current.periodFrom ? utcToIstDateInput(new Date(d.current.periodFrom)) : "",
    periodTo: d.current.periodTo ? utcToIstDateInput(new Date(d.current.periodTo)) : "",
    items: d.current.items.map((i) => ({ label: i.label, itemType: i.itemType })),
    attachmentIds: d.current.attachmentIds,
    changeNote: "",
  };
}

const same = (a: FormState, b: FormState) => JSON.stringify({ ...a, changeNote: "" }) === JSON.stringify({ ...b, changeNote: "" });

export function RequestEditor({ d }: { d: RequestDetail }) {
  const server = useMemo(() => initialForm(d), [d]);
  const storageKey = `tcyber:draft:${d.id}:v${d.currentVersionNo}`;
  const [form, setForm] = useState<FormState>(server);
  const [restoredAt, setRestoredAt] = useState<string | null>(null);
  const save = useServerAction(updateDraftAction);
  const dirty = !same(form, server);
  const { dialog } = useUnsavedGuard(dirty && !save.pending);

  // Restore unsaved edits kept in this browser (per request and version).
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) return;
      const stored = JSON.parse(raw) as { form: FormState & { body?: string }; savedAt: string };
      // Edits kept before the closing had its own field: split them the same way.
      if (stored.form.body !== undefined && stored.form.text === undefined) {
        const { body, ...rest } = stored.form;
        stored.form = { ...rest, ...splitClosing(body), fromAddress: rest.fromAddress ?? server.fromAddress };
      }
      if (!same(stored.form, server)) {
        // Browser storage is only readable after hydration, so restoring a saved draft must happen in an effect.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setForm(stored.form);
        setRestoredAt(stored.savedAt);
      } else window.localStorage.removeItem(storageKey);
    } catch {
      /* storage unavailable: editing still works, edits just are not kept across reloads */
    }
  }, [storageKey, server]);

  // Keep a local copy of unsaved edits.
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        if (dirty) window.localStorage.setItem(storageKey, JSON.stringify({ form, savedAt: new Date().toISOString() }));
        else window.localStorage.removeItem(storageKey);
      } catch {
        /* ignore */
      }
    }, 600);
    return () => clearTimeout(t);
  }, [form, dirty, storageKey]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));
  const approvedWillBeWithdrawn = d.status === "APPROVED" || d.status === "AWAITING_APPROVAL" || d.status === "SUBMISSION_FAILED";
  const fe = save.fieldErrors;

  // After a save that changes the From address or the closing, the officer is asked whether new drafts should use it.
  const [offer, setOffer] = useState<null | { from: string | null; closing: string | null }>(null);
  const defaults = useServerAction(setMailDefaultsAction);
  const onSave = () => {
    const { text, closing, ...rest } = form;
    const fromChanged = form.fromAddress.trim().toLowerCase() !== d.mail.from.toLowerCase() && EMAIL.test(form.fromAddress.trim());
    const closingChanged = !!closingLines(closing).length && JSON.stringify(closingLines(closing)) !== JSON.stringify(d.mail.closing);
    save.run([d.id, { ...rest, body: joinClosing(text, closing), expectedVersion: d.version }], {
      success: `Saved as version ${d.currentVersionNo + 1}`,
      onSuccess: () => {
        try {
          window.localStorage.removeItem(storageKey);
        } catch {
          /* ignore */
        }
        setRestoredAt(null);
        if (fromChanged || closingChanged) setOffer({ from: fromChanged ? form.fromAddress.trim() : null, closing: closingChanged ? closingLines(closing).join("\n") : null });
      },
    });
  };

  return (
    <div className="flex flex-col gap-4">
      {dialog}
      <Dialog open={!!offer} onOpenChange={(o) => !o && setOffer(null)}>
        <DialogContent
          title={offer?.from && offer.closing ? "Use this From address and closing for your new drafts?" : offer?.from ? `Make ${offer.from} your default From address?` : "Use this closing for your new drafts?"}
          description="Saved on this draft. Your new drafts can start with it too; drafts already written keep what they have."
          size="md"
          footer={
            <>
              <Button variant="secondary" onClick={() => setOffer(null)}>
                Only this draft
              </Button>
              <Button
                variant="primary"
                loading={defaults.pending}
                onClick={() =>
                  offer &&
                  defaults.run([{ ...(offer.from ? { fromAddress: offer.from } : {}), ...(offer.closing ? { closing: offer.closing } : {}) }], {
                    success: "Your new drafts will use it",
                    onSuccess: () => setOffer(null),
                  })
                }
              >
                Make it my default
              </Button>
            </>
          }
        >
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-body">
            {offer?.from ? (
              <>
                <dt className="text-ink-2">From</dt>
                <dd className="min-w-0 break-words">
                  {offer.from} <span className="text-label text-ink-3">(your default now: {d.mail.from})</span>
                </dd>
              </>
            ) : null}
            {offer?.closing ? (
              <>
                <dt className="text-ink-2">Closing</dt>
                <dd className="min-w-0 whitespace-pre-line break-words">{offer.closing}</dd>
              </>
            ) : null}
          </dl>
          {defaults.error ? <p className="mt-3 text-label text-danger" role="alert">{defaults.error}</p> : null}
        </DialogContent>
      </Dialog>
      {restoredAt ? (
        <InlineAlert
          tone="info"
          title="Unsaved edits restored from this browser"
          action={
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setForm(server);
                setRestoredAt(null);
                try {
                  window.localStorage.removeItem(storageKey);
                } catch {
                  /* ignore */
                }
              }}
            >
              Discard restored edits
            </Button>
          }
        >
          These edits were made earlier and not saved. Save them as a new version or discard them.
        </InlineAlert>
      ) : null}
      {save.error && !Object.keys(fe).length ? <InlineAlert tone="danger">{save.error}</InlineAlert> : null}

      <FormField label="Recipient" required error={fe.recipientId} hint="From the station's routing directory. Unverified recipients block submission.">
        <Select value={form.recipientId} onChange={(e) => set("recipientId", e.target.value)}>
          {d.recipients.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
              {r.verified ? "" : " (not verified)"}
            </option>
          ))}
        </Select>
      </FormField>
      <FormField
        label="From"
        required
        error={fe.fromAddress}
        validate={(v) => (!v.trim() ? "Enter the mailbox this request is sent from." : EMAIL.test(v.trim()) ? null : "Enter an email address, like io.ps@police.gov.in.")}
        hint={d.gmail.on ? `Emails go from the linked Gmail account (${d.gmail.account ?? "not connected"}); this address is the station's reply address on the letter. The station mailbox is ${d.mail.stationFrom}.` : `The station mailbox is ${d.mail.stationFrom}${d.mail.own.from ? `; your default is ${d.mail.from}` : ""}. After saving a different address you can make it your default for new drafts.`}
      >
        <Input type="email" autoComplete="off" value={form.fromAddress} onChange={(e) => set("fromAddress", e.target.value)} />
      </FormField>
      <FormField label="Subject" required error={fe.subject}>
        <Input value={form.subject} onChange={(e) => set("subject", e.target.value)} />
      </FormField>
      <FormField label="Scope" required error={fe.scope} hint="What is being requested, in one or two lines.">
        <Textarea rows={2} value={form.scope} onChange={(e) => set("scope", e.target.value)} />
      </FormField>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <FormField label="Period from" optionalLabel error={fe.periodFrom} hint="Date in IST">
          <Input type="date" value={form.periodFrom} onChange={(e) => set("periodFrom", e.target.value)} />
        </FormField>
        <FormField label="Period to" optionalLabel error={fe.periodTo} hint="Date in IST">
          <Input type="date" value={form.periodTo} onChange={(e) => set("periodTo", e.target.value)} />
        </FormField>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1.5 text-label font-medium text-ink">
          Requested items<span className="ml-0.5 text-danger" aria-hidden="true">*</span>
        </legend>
        <p className="-mt-1 mb-1 text-meta text-ink-3">Each item becomes a line on the requested-versus-received checklist.</p>
        {form.items.map((item, i) => (
          <div key={i} className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <label className="sr-only" htmlFor={`item-${i}`}>
                Item {i + 1}
              </label>
              <Input id={`item-${i}`} value={item.label} onChange={(e) => set("items", form.items.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
            </div>
            <div className="w-44 shrink-0 md:w-48">
              <label className="sr-only" htmlFor={`item-type-${i}`}>
                Type of item {i + 1}
              </label>
              <Select id={`item-type-${i}`} value={item.itemType} onChange={(e) => set("items", form.items.map((x, j) => (j === i ? { ...x, itemType: e.target.value } : x)))}>
                {Object.entries(ITEM_TYPE_LABELS).map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </Select>
            </div>
            <IconButton label={`Remove item ${i + 1}`} onClick={() => set("items", form.items.filter((_, j) => j !== i))}>
              <Trash2 aria-hidden="true" />
            </IconButton>
          </div>
        ))}
        {fe.items ? <p className="text-label text-danger" role="alert">{fe.items}</p> : null}
        <div>
          <Button size="sm" variant="ghost" icon={<Plus aria-hidden="true" />} onClick={() => set("items", [...form.items, { label: "", itemType: "OTHER" }])}>
            Add item
          </Button>
        </div>
      </fieldset>

      <FormField label="Request text" required error={fe.body}>
        <Textarea rows={16} value={form.text} onChange={(e) => set("text", e.target.value)} className="leading-relaxed" />
      </FormField>
      <FormField label="Closing" optionalLabel hint={`Printed at the foot of the letter: the valediction, your name and rank, and the station's lines.${d.mail.own.closing ? " This draft started from your own default closing." : ""}`}>
        <Textarea rows={5} value={form.closing} onChange={(e) => set("closing", e.target.value)} placeholder={d.mail.closing.join("\n")} className="leading-relaxed" />
      </FormField>

      <fieldset>
        <legend className="mb-1.5 text-label font-medium text-ink">Attachments</legend>
        <p className="mb-2 text-meta text-ink-3">Originals from this case’s evidence library. Attachments are part of the approved content.</p>
        <div className="flex max-h-48 flex-col gap-2 overflow-y-auto rounded-[var(--radius-control)] border border-line p-3">
          {d.evidence.length ? (
            d.evidence.map((e) => (
              <Checkbox
                key={e.id}
                label={e.title}
                checked={form.attachmentIds.includes(e.id)}
                onChange={(ev) => set("attachmentIds", ev.target.checked ? [...form.attachmentIds, e.id] : form.attachmentIds.filter((x) => x !== e.id))}
              />
            ))
          ) : (
            <p className="text-label text-ink-3">No evidence in this case yet.</p>
          )}
        </div>
      </fieldset>

      <FormField label="Change note" optionalLabel hint="Recorded with the new version, for example why the period changed.">
        <Input value={form.changeNote} onChange={(e) => set("changeNote", e.target.value)} />
      </FormField>

      <div className="flex flex-col gap-3 border-t border-line pt-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-label text-ink-2">
          {dirty ? (approvedWillBeWithdrawn && d.status !== "DRAFT" ? "Saving creates a new version and withdraws the current approval or approval request." : "Unsaved changes. Saving creates a new version.") : `No unsaved changes. Current version: ${d.currentVersionNo}.`}
        </p>
        <div className="flex gap-2">
          {dirty ? (
            <Button variant="ghost" onClick={() => setForm(server)} disabled={save.pending}>
              Discard changes
            </Button>
          ) : null}
          <Button variant="primary" loading={save.pending} onClick={onSave}>
            Save as new version
          </Button>
        </div>
      </div>
    </div>
  );
}
