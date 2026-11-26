"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { FormField, Input, Textarea } from "@/components/ui/field";
import { InlineAlert } from "@/components/ui/feedback";
import { useServerAction } from "@/features/shared/use-action";
import { useUnsavedGuard } from "@/features/shared/use-unsaved-guard";
import { updateTemplateAction } from "@/features/settings/actions";
import type { TemplateView } from "@/server/services/settings";

export const PLACEHOLDER_HELP: Record<string, string> = {
  caseReference: "Case reference, for example FIR 1/2026",
  station: "Station name",
  officerName: "Name of the officer preparing the request",
  officerRank: "Rank of the officer preparing the request",
  relevance: "Why the record matters to the case, from the next action",
  requestReference: "This request's reference, for example REQ-412/2026-002 (the FIR and the request's number in it)",
  signature: "Mailbox signature from the configuration file",
  stationAddress: "Station address from the configuration file",
  stationPhone: "Station phone from the configuration file",
  stationEmail: "Station email from the configuration file",
  fromAddress: "Mailbox address requests are sent from",
  subjectLabel: "Name of the account or identifier",
  subjectValue: "Recorded value of the account or identifier",
  bank: "Bank named on the account",
  transactions: "Recorded transfers into the account, one per line",
  items: "Items requested, one per line",
  periodFrom: "Start of the requested period",
  periodTo: "End of the requested period",
  scope: "Scope of the request, from the next action",
  parentReference: "Reference of the original request",
  outstandingItems: "Items still outstanding from the original request",
  responseDate: "Date the original request was sent",
};

export function PlaceholderList({ placeholders }: { placeholders: string[] }) {
  return (
    <dl className="flex flex-col gap-2">
      {placeholders.map((p) => (
        <div key={p}>
          <dt className="font-mono text-label text-ink">{`{{${p}}}`}</dt>
          <dd className="text-label text-ink-2">{PLACEHOLDER_HELP[p] ?? "Filled when the draft is prepared"}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Mirrors the server check: a placeholder drafting cannot fill is reported as soon as the field is left. */
function placeholderProblem(text: string, allowed: string[]): string | null {
  const unknown = [...new Set([...text.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)].map((m) => m[1]!).filter((k) => !allowed.includes(k)))];
  return unknown.length ? `Not available for this template: ${unknown.map((k) => `{{${k}}}`).join(", ")}.` : null;
}

export function TemplateEditor({ template }: { template: TemplateView }) {
  const router = useRouter();
  const [subject, setSubject] = useState(template.subjectTemplate);
  const [body, setBody] = useState(template.bodyTemplate);
  const save = useServerAction(updateTemplateAction);
  const dirty = subject !== template.subjectTemplate || body !== template.bodyTemplate;
  // Template edits are not kept in the browser, so the warning says they will be lost.
  const { dialog } = useUnsavedGuard(dirty && !save.pending, { keptInBrowser: false });
  return (
    <div className="panel flex flex-col gap-4 p-5">
      {dialog}
      {save.error && !save.fieldErrors.subjectTemplate && !save.fieldErrors.bodyTemplate ? <InlineAlert tone="danger">{save.error}</InlineAlert> : null}
      <FormField label="Subject" required error={save.fieldErrors.subjectTemplate} validate={(v) => (v.trim().length < 5 ? "Enter a subject of at least 5 characters." : placeholderProblem(v, template.placeholders))}>
        <Input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} />
      </FormField>
      <FormField label="Body" required error={save.fieldErrors.bodyTemplate} hint="Use only the placeholders listed beside the editor; each is filled when a draft is prepared." validate={(v) => (v.trim().length < 20 ? "Enter a body of at least 20 characters." : placeholderProblem(v, template.placeholders))}>
        <Textarea rows={20} value={body} onChange={(e) => setBody(e.target.value)} className="leading-relaxed" />
      </FormField>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button asChild variant="secondary">
          <Link href="/settings/templates">Cancel</Link>
        </Button>
        <Button
          variant="primary"
          loading={save.pending}
          onClick={() =>
            save.run([template.id, { subjectTemplate: subject, bodyTemplate: body, expectedVersion: template.version }], {
              success: `Saved as version ${template.version + 1}`,
              onSuccess: () => router.push("/settings/templates"),
            })
          }
        >
          Save as version {template.version + 1}
        </Button>
      </div>
    </div>
  );
}
