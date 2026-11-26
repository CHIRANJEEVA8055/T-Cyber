"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { utcToIstInput } from "@/domain/time";
import { Button } from "@/components/ui/button";
import { FormField, Input, Select, Textarea } from "@/components/ui/field";
import { InlineAlert, useToast } from "@/components/ui/feedback";

interface CaseOption {
  id: string;
  label: string;
  requests: { id: string; label: string }[];
}

export function ImportResponseForm({ cases, initialCaseId, initialRequestId, mailbox }: { cases: CaseOption[]; initialCaseId: string; initialRequestId: string; mailbox: string }) {
  const router = useRouter();
  const toast = useToast();
  const [caseId, setCaseId] = useState(initialCaseId || cases[0]?.id || "");
  const [requestId, setRequestId] = useState(initialRequestId);
  const [receivedAt, setReceivedAt] = useState(() => utcToIstInput(new Date()));
  const [pending, setPending] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<{ responseId: string; caseId: string } | null>(null);
  const requests = cases.find((c) => c.id === caseId)?.requests ?? [];

  return (
    <form
      className="panel mt-6 flex flex-col gap-4 p-6"
      onSubmit={async (e) => {
        e.preventDefault();
        setPending(true);
        setError(null);
        setDuplicate(null);
        try {
          const res = await fetch("/api/correspondence/import", { method: "POST", body: new FormData(e.currentTarget) });
          const json = (await res.json()) as { ok: boolean; error?: string; fieldErrors?: Record<string, string>; data?: { status: string; responseId: string; caseId: string } };
          if (!json.ok || !json.data) {
            setFieldErrors(json.fieldErrors ?? {});
            setError(json.fieldErrors ? null : (json.error ?? "The message could not be imported. Nothing was changed."));
            return;
          }
          setFieldErrors({});
          if (json.data.status === "DUPLICATE") {
            setDuplicate({ responseId: json.data.responseId, caseId: json.data.caseId });
            return;
          }
          toast({ tone: "success", message: "Response imported. Review it before anything is applied." });
          router.push(`/cases/${json.data.caseId}/responses/${json.data.responseId}`);
        } catch {
          setError("The message could not be sent to the server. Check the connection and try again; nothing was imported.");
        } finally {
          setPending(false);
        }
      }}
    >
      {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
      {duplicate ? (
        <InlineAlert tone="warning" title="This message was already imported">
          Importing the same message again does not create a second record.{" "}
          <Link className="font-medium text-action underline" href={`/cases/${duplicate.caseId}/responses/${duplicate.responseId}`}>
            Open the existing response
          </Link>
        </InlineAlert>
      ) : null}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <FormField label="Case" required error={fieldErrors.caseId}>
          <Select
            name="caseId"
            value={caseId}
            onChange={(e) => {
              setCaseId(e.target.value);
              setRequestId("");
            }}
          >
            {cases.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="In reply to" error={fieldErrors.requestId} hint="Leave on automatic to match by the quoted reference and sender. Uncertain matches go to the review queue.">
          <Select name="requestId" value={requestId} onChange={(e) => setRequestId(e.target.value)}>
            <option value="">Match automatically</option>
            {requests.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="From" required error={fieldErrors.fromAddress}>
          <Input name="fromAddress" type="email" placeholder="nodal@bank.example.invalid" autoComplete="off" />
        </FormField>
        <FormField label="To" hint="Station mailbox from the configuration file">
          <Input name="toAddress" type="email" defaultValue={mailbox} />
        </FormField>
        <FormField label="Received at (IST)" required error={fieldErrors.receivedAt}>
          <Input name="receivedAt" type="datetime-local" value={receivedAt} onChange={(e) => setReceivedAt(e.target.value)} />
        </FormField>
      </div>
      <FormField label="Subject" required error={fieldErrors.subject}>
        <Input name="subject" />
      </FormField>
      <FormField label="Message text" required error={fieldErrors.bodyText} hint="Paste the full message, including any reference the sender quoted.">
        <Textarea name="bodyText" rows={10} />
      </FormField>
      <FormField label="Attachments" optionalLabel error={fieldErrors.attachments} hint="PDF, CSV, TXT, EML, PNG, JPG, DOCX or XLSX; up to 5 files of 10 MB each. Originals are stored and hashed.">
        <Input name="attachments" type="file" multiple accept=".pdf,.csv,.txt,.eml,.png,.jpg,.jpeg,.docx,.xlsx" className="h-auto py-2 file:mr-3 file:rounded file:border-0 file:bg-surface-sunken file:px-3 file:py-1.5 file:text-label file:font-medium file:text-ink" />
      </FormField>
      <div className="flex justify-end gap-2 border-t border-line pt-4">
        <Button asChild variant="secondary">
          <Link href="/correspondence">Cancel</Link>
        </Button>
        <Button type="submit" variant="primary" loading={pending}>
          Import response
        </Button>
      </div>
    </form>
  );
}
