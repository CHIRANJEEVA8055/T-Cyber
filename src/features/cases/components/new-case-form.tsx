"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Plus, ScanText, Trash2 } from "lucide-react";
import { IDENTIFIER_KIND_LABELS, INTAKE_IDENTIFIER_KINDS, PARTY_ROLES, PARTY_ROLE_LABELS, type CreateCaseInput } from "@/contracts/case";
import { Button, IconButton } from "@/components/ui/button";
import { Checkbox, FormField, Input, Select, Textarea } from "@/components/ui/field";
import { InlineAlert, useToast } from "@/components/ui/feedback";
import { useServerAction } from "@/features/shared/use-action";
import { createCaseAction } from "@/features/cases/actions";
import { cn } from "@/lib/cn";
import { formatDateTimeIST, utcToIstInput } from "@/domain/time";
import type { FirProposal } from "@/domain/extraction/fir-intake";

type Party = { name: string; role: (typeof PARTY_ROLES)[number]; lossRupees: string };
type Ident = { kind: (typeof INTAKE_IDENTIFIER_KINDS)[number]; value: string; role: string; bank: string };
interface FormState {
  referenceType: "FIR" | "COMPLAINT";
  firNumber: string;
  firYear: string;
  complaintRef: string;
  investigatingOfficerId: string;
  title: string;
  fraudCategory: string;
  incidentStart: string;
  incidentEnd: string;
  reportedAt: string;
  narrative: string;
  legalSections: string;
  parties: Party[];
  identifiers: Ident[];
}

const DRAFT_KEY = "tcyber:draft:new-case";

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <fieldset className="panel p-6">
      <legend className="sr-only">{title}</legend>
      <h2 className="text-section font-semibold tracking-tight text-ink" aria-hidden="true">
        {title}
      </h2>
      {description ? <p className="mt-0.5 text-label text-ink-2">{description}</p> : null}
      <div className="mt-4 flex flex-col gap-4">{children}</div>
    </fieldset>
  );
}

export function NewCaseForm({ station, currentUserId, officers, year }: { station: string; currentUserId: string; officers: { id: string; label: string }[]; year: number }) {
  const router = useRouter();
  const toast = useToast();
  const empty: FormState = {
    referenceType: "FIR",
    firNumber: "",
    firYear: String(year),
    complaintRef: "",
    investigatingOfficerId: officers.some((o) => o.id === currentUserId) ? currentUserId : (officers[0]?.id ?? ""),
    title: "",
    fraudCategory: "",
    incidentStart: "",
    incidentEnd: "",
    reportedAt: "",
    narrative: "",
    legalSections: "",
    parties: [{ name: "", role: "VICTIM", lossRupees: "" }],
    identifiers: [],
  };
  const [form, setForm] = useState<FormState>(empty);
  const [restored, setRestored] = useState(false);
  const [uploadExtraction, setUploadExtraction] = useState(true);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [reading, setReading] = useState(false);
  const [readResult, setReadResult] = useState<{ fileName: string; proposal: FirProposal | null; note: string | null; filled: number } | null>(null);
  const action = useServerAction(createCaseAction);
  const fe = action.fieldErrors;

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(DRAFT_KEY);
      if (raw) {
        // Browser storage is only readable after hydration, so restoring a saved draft must happen in an effect.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setForm({ ...empty, ...(JSON.parse(raw) as Partial<FormState>) });
        setRestored(true);
      }
    } catch {
      /* storage unavailable */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      try {
        if (JSON.stringify(form) !== JSON.stringify(empty)) window.localStorage.setItem(DRAFT_KEY, JSON.stringify(form));
      } catch {
        /* ignore */
      }
    }, 500);
    return () => clearTimeout(t);
  });

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));
  const setParty = (i: number, p: Partial<Party>) => set("parties", form.parties.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const setIdent = (i: number, p: Partial<Ident>) => set("identifiers", form.identifiers.map((x, j) => (j === i ? { ...x, ...p } : x)));

  /** Reads the chosen FIR copy (in memory, nothing stored) and fills the form with what it states. */
  const readFir = async () => {
    setUploadError(null);
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setUploadError("Choose the FIR copy to read.");
      return;
    }
    setReading(true);
    try {
      const fd = new FormData();
      fd.set("file", file);
      const res = await fetch("/api/cases/intake/read", { method: "POST", body: fd });
      const json = (await res.json()) as { ok: boolean; error?: string; fieldErrors?: Record<string, string>; data?: { readable: boolean; note: string | null; proposal: FirProposal | null } };
      if (!json.ok || !json.data) {
        setUploadError(json.fieldErrors?.file ?? json.error ?? "The copy could not be read. Try again, or enter the details by hand.");
        return;
      }
      const p = json.data.proposal;
      if (p) {
        setForm((f) => ({
          ...f,
          ...(p.fields.firNumber ? { referenceType: "FIR" as const } : {}),
          firNumber: p.fields.firNumber ?? f.firNumber,
          firYear: p.fields.firYear ?? f.firYear,
          complaintRef: p.fields.complaintRef ?? f.complaintRef,
          reportedAt: p.fields.reportedAt ?? f.reportedAt,
          incidentStart: p.fields.incidentStart ?? f.incidentStart,
          incidentEnd: p.fields.incidentEnd ?? f.incidentEnd,
          narrative: p.fields.narrative ?? f.narrative,
          legalSections: p.fields.legalSections ?? f.legalSections,
          parties: p.parties.length
            ? [...f.parties.filter((x) => x.name.trim() && !p.parties.some((y) => y.name === x.name)), ...p.parties.map((x) => ({ name: x.name, role: x.role, lossRupees: x.lossRupees ?? "" }))]
            : f.parties,
        }));
      }
      setReadResult({ fileName: file.name, proposal: p, note: json.data.note, filled: p ? Object.values(p.fields).filter(Boolean).length + p.parties.length : 0 });
    } catch {
      setUploadError("The copy could not be read: the connection failed. Try again, or enter the details by hand.");
    } finally {
      setReading(false);
    }
  };

  const submit = async () => {
    setUploadError(null);
    const input: CreateCaseInput = {
      ...form,
      complaintRef: form.complaintRef || undefined,
      firNumber: form.referenceType === "FIR" ? form.firNumber : undefined,
      parties: form.parties.filter((p) => p.name.trim()).map((p) => ({ name: p.name, role: p.role, lossRupees: p.role === "VICTIM" && p.lossRupees ? p.lossRupees : undefined })),
      identifiers: form.identifiers.filter((i) => i.value.trim()).map((i) => ({ kind: i.kind, value: i.value, role: i.role || undefined, bank: i.bank || undefined })),
    };
    const res = await action.run([input]);
    if (!res.ok) {
      document.querySelector("[aria-invalid='true'], [role='alert']")?.scrollIntoView({ block: "center" });
      return;
    }
    try {
      window.localStorage.removeItem(DRAFT_KEY);
    } catch {
      /* ignore */
    }
    const file = fileRef.current?.files?.[0];
    if (file) {
      const fd = new FormData();
      fd.set("file", file);
      fd.set("title", form.referenceType === "FIR" ? `FIR ${form.firNumber}/${form.firYear} copy` : `Complaint ${form.complaintRef}`);
      fd.set("category", form.referenceType === "FIR" ? "FIR_COPY" : "COMPLAINT");
      fd.set("sourceDescription", "Uploaded at intake");
      fd.set("receivedAt", utcToIstInput(new Date()));
      fd.set("runExtraction", uploadExtraction ? "true" : "false");
      const up = await fetch(`/api/cases/${res.data.caseId}/evidence`, { method: "POST", body: fd });
      const json = (await up.json()) as { ok: boolean; error?: string; fieldErrors?: Record<string, string>; data?: { evidenceId: string } };
      if (!json.ok || !json.data) {
        toast({ tone: "danger", message: `The case was created, but the document was not stored: ${json.fieldErrors?.file ?? json.error ?? "upload failed"}. Upload it from the Evidence tab.` });
        router.push(`/cases/${res.data.caseId}/evidence`);
        return;
      }
      toast({ tone: "success", message: "Case created. Review the items read from the document." });
      router.push(uploadExtraction ? `/cases/${res.data.caseId}/evidence/${json.data.evidenceId}/review` : `/cases/${res.data.caseId}/evidence/${json.data.evidenceId}`);
      return;
    }
    toast({ tone: "success", message: "Case created" });
    router.push(`/cases/${res.data.caseId}`);
  };

  return (
    <form
      className="mt-6 flex flex-col gap-6"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {restored ? (
        <InlineAlert
          tone="info"
          title="Unsaved intake restored from this browser"
          action={
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setForm(empty);
                setRestored(false);
                try {
                  window.localStorage.removeItem(DRAFT_KEY);
                } catch {
                  /* ignore */
                }
              }}
            >
              Discard draft
            </Button>
          }
        >
          Continue where you left off, or discard it and start again.
        </InlineAlert>
      ) : null}
      {action.error && !Object.keys(fe).length ? <InlineAlert tone="danger">{action.error}</InlineAlert> : null}
      {action.error && (fe.firNumber || fe.complaintRef) ? <InlineAlert tone="danger" title="Duplicate reference">{action.error}</InlineAlert> : null}

      <Section
        title={form.referenceType === "FIR" ? "Start from the FIR copy" : "Complaint document"}
        description={
          form.referenceType === "FIR"
            ? "Read a text copy of the FIR to fill this form. Nothing is saved until you create the case; the copy is then kept as evidence, and each identifier and payment is confirmed against its line before requests are drafted."
            : "Optional. The original is hashed and stored; items read from it go to review before anything enters the case."
        }
      >
        <FormField label={form.referenceType === "FIR" ? "FIR copy" : "File"} optionalLabel error={uploadError} hint="Text PDFs and TXT can be read. Scanned PDFs and images are stored but not read (no OCR in this build).">
          <Input
            ref={fileRef}
            type="file"
            accept=".pdf,.csv,.txt,.eml,.png,.jpg,.jpeg,.docx,.xlsx"
            onChange={() => {
              setReadResult(null);
              setUploadError(null);
            }}
            className="h-auto py-2 file:mr-3 file:rounded file:border-0 file:bg-surface-sunken file:px-3 file:py-1.5 file:text-label file:font-medium file:text-ink"
          />
        </FormField>
        {form.referenceType === "FIR" ? (
          <div>
            <Button variant="secondary" icon={<ScanText aria-hidden="true" />} loading={reading} onClick={() => void readFir()}>
              {reading ? "Reading the FIR…" : "Read FIR and fill the form"}
            </Button>
          </div>
        ) : null}
        {readResult ? (
          readResult.proposal ? (
            <InlineAlert tone="success" title={`Filled ${readResult.filled} ${readResult.filled === 1 ? "detail" : "details"} from ${readResult.fileName}`}>
              Check each one against the document before you create the case. Empty fields were not stated on the copy.
            </InlineAlert>
          ) : (
            <InlineAlert tone="warning" title="Nothing could be read from this copy">
              {readResult.note ?? "Enter the details by hand."} The file is still kept as evidence when you create the case.
            </InlineAlert>
          )
        ) : null}
        {readResult?.proposal && (readResult.proposal.found.length > 0 || readResult.proposal.payments.length > 0) ? <FirPreview p={readResult.proposal} /> : null}
        <Checkbox checked={uploadExtraction} onChange={(e) => setUploadExtraction(e.target.checked)} label="Open the review of this document after creating the case" description="Identifiers and payments are confirmed beside the document; requests for them are then drafted for your review." />
      </Section>

      <Section title="Reference" description={`Station: ${station}. Case references are unique per station and year.`}>
        <div role="radiogroup" aria-label="Reference type" className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {(["FIR", "COMPLAINT"] as const).map((t) => (
            <label key={t} className={cn("flex cursor-pointer gap-3 rounded-[var(--radius-control)] border p-3", form.referenceType === t ? "border-action bg-action-tint" : "border-line-input bg-surface")}>
              <input type="radio" name="referenceType" value={t} checked={form.referenceType === t} onChange={() => set("referenceType", t)} className="mt-1 accent-[var(--color-action)]" />
              <span>
                <span className="block text-body font-medium text-ink">{t === "FIR" ? "FIR registered" : "Complaint workspace"}</span>
                <span className="block text-label text-ink-2">{t === "FIR" ? "An FIR number has been assigned." : "Start work before an FIR copy is available."}</span>
              </span>
            </label>
          ))}
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {form.referenceType === "FIR" ? (
            <FormField label="FIR number" required error={fe.firNumber}>
              <Input inputMode="numeric" value={form.firNumber} onChange={(e) => set("firNumber", e.target.value)} />
            </FormField>
          ) : null}
          <FormField label="Year" required error={fe.firYear}>
            <Input inputMode="numeric" value={form.firYear} onChange={(e) => set("firYear", e.target.value)} />
          </FormField>
          <FormField label="Complaint or NCRP reference" required={form.referenceType === "COMPLAINT"} optionalLabel={form.referenceType === "FIR"} error={fe.complaintRef}>
            <Input value={form.complaintRef} onChange={(e) => set("complaintRef", e.target.value)} />
          </FormField>
        </div>
        <FormField label="Investigating officer" required error={fe.investigatingOfficerId}>
          <Select value={form.investigatingOfficerId} onChange={(e) => set("investigatingOfficerId", e.target.value)}>
            {officers.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </Select>
        </FormField>
      </Section>

      <Section title="Incident" description="Times are entered in IST.">
        <FormField label="Case title" required error={fe.title} hint="A short factual description, for example 'Investment fraud through a fake trading group'.">
          <Input value={form.title} onChange={(e) => set("title", e.target.value)} />
        </FormField>
        <FormField label="Category" optionalLabel>
          <Input value={form.fraudCategory} onChange={(e) => set("fraudCategory", e.target.value)} />
        </FormField>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <FormField label="Incident from" optionalLabel error={fe.incidentStart}>
            <Input type="datetime-local" value={form.incidentStart} onChange={(e) => set("incidentStart", e.target.value)} />
          </FormField>
          <FormField label="Incident to" optionalLabel error={fe.incidentEnd}>
            <Input type="datetime-local" value={form.incidentEnd} onChange={(e) => set("incidentEnd", e.target.value)} />
          </FormField>
          <FormField label="Reported at" optionalLabel error={fe.reportedAt}>
            <Input type="datetime-local" value={form.reportedAt} onChange={(e) => set("reportedAt", e.target.value)} />
          </FormField>
        </div>
        <FormField label="Narrative" optionalLabel hint="What the complainant reported, in brief.">
          <Textarea rows={5} value={form.narrative} onChange={(e) => set("narrative", e.target.value)} />
        </FormField>
        <FormField label="Legal sections" optionalLabel hint="Only sections recorded on the FIR or decided by an officer. T-CYBER never suggests sections.">
          <Input value={form.legalSections} onChange={(e) => set("legalSections", e.target.value)} />
        </FormField>
      </Section>

      <Section title="People" description="Each person is a separate record. People are never merged by name.">
        {form.parties.map((p, i) => (
          <div key={i} className="grid grid-cols-1 gap-3 rounded-[var(--radius-control)] border border-line p-3 sm:grid-cols-[1fr_12rem_10rem_auto] sm:items-end">
            <FormField label={`Person ${i + 1} name`} error={fe[`parties.${i}.name`]}>
              <Input value={p.name} onChange={(e) => setParty(i, { name: e.target.value })} />
            </FormField>
            <FormField label="Role">
              <Select value={p.role} onChange={(e) => setParty(i, { role: e.target.value as Party["role"] })}>
                {PARTY_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {PARTY_ROLE_LABELS[r]}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField label="Loss (₹)" optionalLabel={p.role === "VICTIM"} error={fe[`parties.${i}.lossRupees`]}>
              <Input inputMode="decimal" value={p.lossRupees} disabled={p.role !== "VICTIM"} placeholder={p.role === "VICTIM" ? "20,00,000" : "Victims only"} onChange={(e) => setParty(i, { lossRupees: e.target.value })} />
            </FormField>
            <IconButton label={`Remove person ${i + 1}`} onClick={() => set("parties", form.parties.filter((_, j) => j !== i))}>
              <Trash2 aria-hidden="true" />
            </IconButton>
          </div>
        ))}
        <div>
          <Button size="sm" variant="ghost" icon={<Plus aria-hidden="true" />} onClick={() => set("parties", [...form.parties, { name: "", role: "VICTIM", lossRupees: "" }])}>
            Add person
          </Button>
        </div>
      </Section>

      <Section title="Identifiers" description="Accounts, numbers, emails and profiles known at intake. Record exactly as written; leading zeros and masks are kept.">
        {form.identifiers.map((idf, i) => (
          <div key={i} className="grid grid-cols-1 gap-3 rounded-[var(--radius-control)] border border-line p-3 sm:grid-cols-[11rem_1fr_1fr_auto] sm:items-end">
            <FormField label="Kind">
              <Select value={idf.kind} onChange={(e) => setIdent(i, { kind: e.target.value as Ident["kind"] })}>
                {INTAKE_IDENTIFIER_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {IDENTIFIER_KIND_LABELS[k]}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField label={`Identifier ${i + 1}`} error={fe[`identifiers.${i}.value`]}>
              <Input value={idf.value} onChange={(e) => setIdent(i, { value: e.target.value })} className="font-mono" />
            </FormField>
            <FormField label="Role in this case" optionalLabel>
              <Input value={idf.role} onChange={(e) => setIdent(i, { role: e.target.value })} placeholder="Beneficiary account" />
            </FormField>
            <IconButton label={`Remove identifier ${i + 1}`} onClick={() => set("identifiers", form.identifiers.filter((_, j) => j !== i))}>
              <Trash2 aria-hidden="true" />
            </IconButton>
          </div>
        ))}
        <div>
          <Button size="sm" variant="ghost" icon={<Plus aria-hidden="true" />} onClick={() => set("identifiers", [...form.identifiers, { kind: "BANK_ACCOUNT", value: "", role: "", bank: "" }])}>
            Add identifier
          </Button>
        </div>
      </Section>


      <div className="flex flex-col-reverse gap-2 border-t border-line pt-5 sm:flex-row sm:justify-end">
        <Button
          variant="secondary"
          onClick={() => {
            router.push("/cases");
          }}
        >
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={action.pending}>
          {form.referenceType === "FIR" ? "Create FIR workspace" : "Create complaint workspace"}
        </Button>
      </div>
    </form>
  );
}

/** What the FIR states, listed before the case exists. These are confirmed against the copy on the review screen. */
function FirPreview({ p }: { p: FirProposal }) {
  return (
    <div className="rounded-[var(--radius-control)] border border-line bg-surface-muted p-4">
      <p className="text-label font-semibold text-ink">Found in the FIR</p>
      <p className="mt-0.5 text-meta text-ink-3">You confirm these against the cited lines on the next screen. Requests for them (bank nodal officers, UNICROSS, NPCI, provider portals) are then drafted for your review; nothing is sent.</p>
      {p.found.length ? (
        <ul className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
          {p.found.map((f) => (
            <li key={`${f.kind}:${f.value}`} className="min-w-0 text-label">
              <span className="text-ink-3">{IDENTIFIER_KIND_LABELS[f.kind] ?? f.kind}: </span>
              <span className="break-all font-medium text-ink">{f.value}</span>
              <span className="block text-meta text-ink-3">
                {f.note ? `${f.note}, ` : ""}
                {f.source}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {p.payments.length ? (
        <>
          <p className="mt-4 text-label font-semibold text-ink">
            Payments{p.totalLoss ? <span className="font-normal text-ink-2">, total stated {p.totalLoss}</span> : null}
          </p>
          <ul className="mt-1.5 flex flex-col gap-1">
            {p.payments.map((x, i) => (
              <li key={i} className="text-label text-ink-2">
                <span className="font-medium tabular-nums text-ink">{x.amount}</span>
                {x.to ? ` to ${x.to}` : ""}
                {x.when ? `, ${formatDateTimeIST(new Date(x.when))}` : ""}
                {x.reference ? `, ref ${x.reference}` : ""} <span className="text-meta text-ink-3">({x.source})</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
