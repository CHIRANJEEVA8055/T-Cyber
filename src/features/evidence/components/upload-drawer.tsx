"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Upload } from "lucide-react";
import { utcToIstInput } from "@/domain/time";
import { EVIDENCE_CATEGORY_LABELS } from "@/lib/labels";
import { Button } from "@/components/ui/button";
import { DetailDrawer } from "@/components/ui/drawer";
import { Checkbox, FormField, Input, Select } from "@/components/ui/field";
import { InlineAlert, useToast } from "@/components/ui/feedback";

/** Upload an original. The file is validated, hashed (SHA-256) and stored outside the public web root. */
export function UploadEvidenceButton({ caseId }: { caseId: string }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [receivedAt, setReceivedAt] = useState("");
  const formId = "upload-evidence-form";
  return (
    <>
      <Button
        variant="primary"
        icon={<Upload aria-hidden="true" />}
        onClick={() => {
          setReceivedAt(utcToIstInput(new Date()));
          setFieldErrors({});
          setError(null);
          setOpen(true);
        }}
      >
        Upload document
      </Button>
      <DetailDrawer
        open={open}
        onOpenChange={(o) => !pending && setOpen(o)}
        title="Upload a document"
        subtitle="The original is kept unchanged, hashed and stored outside the public web root."
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" form={formId} variant="primary" loading={pending}>
              Upload document
            </Button>
          </>
        }
      >
        <form
          id={formId}
          className="flex flex-col gap-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setPending(true);
            setError(null);
            try {
              const res = await fetch(`/api/cases/${caseId}/evidence`, { method: "POST", body: new FormData(e.currentTarget) });
              const json = (await res.json()) as { ok: boolean; error?: string; fieldErrors?: Record<string, string>; data?: { evidenceId: string; processingStatus: string } };
              if (!json.ok || !json.data) {
                setFieldErrors(json.fieldErrors ?? {});
                if (!json.fieldErrors) setError(json.error ?? "The document could not be uploaded. Nothing was stored.");
                return;
              }
              setOpen(false);
              toast({ tone: "success", message: "Document uploaded" });
              router.push(`/cases/${caseId}/evidence/${json.data.evidenceId}`);
            } catch {
              setError("The upload could not reach the server. Check the connection and try again; nothing was stored.");
            } finally {
              setPending(false);
            }
          }}
        >
          {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
          <FormField label="File" required error={fieldErrors.file} hint="PDF, CSV, TXT, EML, PNG, JPG, DOCX or XLSX, up to 10 MB. Text PDFs, CSV, TXT and EML can be read; images and Office files are stored but not parsed.">
            <Input name="file" type="file" accept=".pdf,.csv,.txt,.eml,.png,.jpg,.jpeg,.docx,.xlsx" className="h-auto py-2 file:mr-3 file:rounded file:border-0 file:bg-surface-sunken file:px-3 file:py-1.5 file:text-label file:font-medium file:text-ink" />
          </FormField>
          <FormField label="Title" optionalLabel hint="Defaults to the file name.">
            <Input name="title" />
          </FormField>
          <FormField label="Kind of document" required error={fieldErrors.category}>
            <Select name="category" defaultValue="OTHER">
              {Object.entries(EVIDENCE_CATEGORY_LABELS).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Source" required error={fieldErrors.sourceDescription} hint="Who provided it and how, for example 'Produced by the complainant at the station'.">
            <Input name="sourceDescription" />
          </FormField>
          <FormField label="Received at (IST)" required error={fieldErrors.receivedAt}>
            <Input name="receivedAt" type="datetime-local" value={receivedAt} onChange={(e) => setReceivedAt(e.target.value)} />
          </FormField>
          <Checkbox name="runExtraction" defaultChecked label="Propose items for review" description="Rule-based reading of identifiers, amounts and references. Nothing is added to the case until you review it." />
        </form>
      </DetailDrawer>
    </>
  );
}
