"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { AlertTriangle, MapPin } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DetailDrawer } from "@/components/ui/drawer";
import { FormField, Input, Select, Textarea } from "@/components/ui/field";
import { StatusBadge, Tag } from "@/components/app/status-badge";
import { DateTime } from "@/components/app/datetime";
import { AmountDisplay } from "@/components/app/amount";
import { EvidenceLink } from "@/components/app/evidence-link";
import { EmptyState } from "@/components/app/states";
import { useServerAction } from "@/features/shared/use-action";
import { addRelationshipAction, setEntityVerificationAction, setLocationCorroborationAction } from "@/features/investigation/actions";
import { IDENTIFIER_KIND_LABELS } from "@/contracts/case";
import { isDateOnlyObservation } from "@/domain/time";
import { PARTY_ROLE_TEXT, RELATIONSHIP_LABELS, REQUEST_CATEGORY_LABELS } from "@/lib/labels";
import type { PeopleData } from "@/server/services/investigation";
import { SortTh, useSort, type SortValue } from "@/components/design/sort";

type Entity = PeopleData["people"][number];

function useEntityParam() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const set = (id: string | null) => {
    const next = new URLSearchParams(params.toString());
    if (id) next.set("record", id);
    else next.delete("record");
    router.replace(`${pathname}${next.size ? `?${next}` : ""}`, { scroll: false });
  };
  return { open: params.get("record"), set };
}

function EntityDrawerBody({ caseId, e, data, onOpen }: { caseId: string; e: Entity; data: PeopleData; onOpen: (id: string) => void }) {
  const [status, setStatus] = useState(e.verificationStatus);
  const [note, setNote] = useState("");
  const [rel, setRel] = useState({ toEntityId: "", type: "POTENTIALLY_ASSOCIATED_WITH", statement: "" });
  const verify = useServerAction(setEntityVerificationAction);
  const addRel = useServerAction(addRelationshipAction);
  const attrs = Object.entries(e.attributes).filter(([k, v]) => typeof v === "string" && ["bank", "ifsc", "holderNameOnRecord"].includes(k));
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap gap-1.5">
        <Tag>{IDENTIFIER_KIND_LABELS[e.kind] ?? e.kind}</Tag>
        <StatusBadge kind="verification" value={e.verificationStatus} />
        {e.isMasked ? <Tag tone="warning">Masked value</Tag> : null}
        {e.roles.map((r) => (
          <Tag key={r.role} tone="info">
            {PARTY_ROLE_TEXT[r.role] ?? r.role}
          </Tag>
        ))}
      </div>
      <dl className="grid grid-cols-1 gap-3 text-body sm:grid-cols-2">
        <div className="sm:col-span-2">
          <dt className="text-label text-ink-3">Value as recorded</dt>
          <dd className="break-all font-mono text-ink">{e.value}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-label text-ink-3">Role in this case</dt>
          <dd className="text-ink">{e.caseRole ?? (e.roles.length ? e.roles.map((r) => `${PARTY_ROLE_TEXT[r.role]} (${r.basis})`).join("; ") : "Not stated")}</dd>
        </div>
        {attrs.map(([k, v]) => (
          <div key={k}>
            <dt className="text-label text-ink-3">{k === "ifsc" ? "IFSC" : k === "bank" ? "Bank" : "Holder on record"}</dt>
            <dd className="text-ink">{String(v)}</dd>
          </div>
        ))}
        <div>
          <dt className="text-label text-ink-3">First recorded</dt>
          <dd className="text-ink">
            <DateTime iso={e.discoveredAt} /> (discovery phase {e.discoveryPhase})
          </dd>
        </div>
        {e.lossMinor ? (
          <div>
            <dt className="text-label text-ink-3">Recorded loss</dt>
            <dd className="text-ink">
              <AmountDisplay minor={e.lossMinor} />
            </dd>
          </div>
        ) : null}
      </dl>
      {e.roles.some((r) => r.role === "ACCOUNT_HOLDER_ON_RECORD") ? (
        <p className="flex gap-2 rounded-[var(--radius-control)] bg-surface-muted px-3 py-2 text-label text-ink-2">
          <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-ink-3" />
          Recorded as the account holder by a bank. This is a registration record, not a finding that this person committed the offence.
        </p>
      ) : null}

      <section>
        <h3 className="text-label font-semibold text-ink-2">Relationships</h3>
        {e.relationships.length ? (
          <ul className="mt-2 flex flex-col gap-2">
            {e.relationships.map((r) => (
              <li key={r.id} className="rounded-[var(--radius-control)] border border-line p-3">
                <p className="flex flex-wrap items-center gap-1.5 text-label">
                  <Tag>{RELATIONSHIP_LABELS[r.type] ?? r.type}</Tag>
                  <button type="button" onClick={() => onOpen(r.otherId)} className="font-medium text-action hover:underline">
                    {r.other}
                  </button>
                  <span className="text-ink-3">{r.status.toLowerCase()}</span>
                </p>
                <p className="mt-1 text-body text-ink">{r.statement}</p>
                {r.sources.map((s, i) => (
                  <EvidenceLink key={i} caseId={caseId} source={s} className="mt-1" />
                ))}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-body text-ink-2">No relationships recorded.</p>
        )}
      </section>

      <section>
        <h3 className="text-label font-semibold text-ink-2">Sources</h3>
        {e.sources.length ? (
          <ul className="mt-2 flex flex-col gap-2">
            {e.sources.map((s, i) => (
              <li key={i}>
                <EvidenceLink caseId={caseId} source={s} showExcerpt />
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-body text-ink-2">Recorded at intake without a document source.</p>
        )}
      </section>

      {e.requests.length ? (
        <section>
          <h3 className="text-label font-semibold text-ink-2">Requests About This Record</h3>
          <ul className="mt-2 flex flex-col gap-1.5">
            {e.requests.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-2">
                <Link href={`/cases/${caseId}/requests/${r.id}`} className="text-body font-medium text-action hover:underline">
                  {r.reference} <span className="font-normal text-ink-2">{REQUEST_CATEGORY_LABELS[r.category]}</span>
                </Link>
                <StatusBadge kind="request" value={r.status} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="rounded-[var(--radius-control)] border border-line p-3">
        <h3 className="text-label font-semibold text-ink-2">Verification</h3>
        <p className="mt-0.5 text-label text-ink-3">A separate decision from extraction review. Record what corroborates or disputes this record.</p>
        {e.verificationNote ? <p className="mt-1 text-label text-ink-2">Current note: {e.verificationNote}</p> : null}
        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-[11rem_1fr]">
          <FormField label="Status">
            <Select value={status} onChange={(ev) => setStatus(ev.target.value)}>
              <option value="UNVERIFIED">Unverified</option>
              <option value="CORROBORATED">Corroborated</option>
              <option value="DISPUTED">Disputed</option>
            </Select>
          </FormField>
          <FormField label="Basis" error={verify.fieldErrors.note}>
            <Input value={note} onChange={(ev) => setNote(ev.target.value)} />
          </FormField>
        </div>
        <Button className="mt-2" size="sm" variant="secondary" loading={verify.pending} onClick={() => verify.run([e.id, status as "UNVERIFIED" | "CORROBORATED" | "DISPUTED", note], { success: "Verification recorded", onSuccess: () => setNote("") })}>
          Record verification
        </Button>
      </section>

      <section className="rounded-[var(--radius-control)] border border-line p-3">
        <h3 className="text-label font-semibold text-ink-2">Record a Relationship</h3>
        <p className="mt-0.5 text-label text-ink-3">Names or contact frequency alone never establish a relationship. Describe exactly what the source shows.</p>
        <div className="mt-2 flex flex-col gap-2">
          <FormField label="Type">
            <Select value={rel.type} onChange={(ev) => setRel({ ...rel, type: ev.target.value })}>
              {Object.entries(RELATIONSHIP_LABELS).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Other record" error={addRel.fieldErrors.toEntityId}>
            <Select value={rel.toEntityId} onChange={(ev) => setRel({ ...rel, toEntityId: ev.target.value })}>
              <option value="">Choose a record</option>
              {data.entityOptions
                .filter((o) => o.id !== e.id)
                .map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
            </Select>
          </FormField>
          <FormField label="What the source shows" error={addRel.fieldErrors.statement}>
            <Textarea rows={2} value={rel.statement} onChange={(ev) => setRel({ ...rel, statement: ev.target.value })} />
          </FormField>
          <div>
            <Button size="sm" variant="secondary" loading={addRel.pending} onClick={() => addRel.run([caseId, { fromEntityId: e.id, toEntityId: rel.toEntityId, type: rel.type, statement: rel.statement, evidenceId: null, locator: null }], { success: "Relationship recorded", onSuccess: () => setRel({ ...rel, statement: "", toEntityId: "" }) })}>
              Record relationship
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}

function EntityDrawer({ caseId, data, all }: { caseId: string; data: PeopleData; all: Entity[] }) {
  const { open, set } = useEntityParam();
  const e = all.find((x) => x.id === open) ?? null;
  return (
    <DetailDrawer open={!!e} onOpenChange={(o) => !o && set(null)} title={e?.label ?? "Record"} subtitle={e ? (IDENTIFIER_KIND_LABELS[e.kind] ?? e.kind) : undefined} width="lg">
      {e ? <EntityDrawerBody key={e.id} caseId={caseId} e={e} data={data} onOpen={set} /> : null}
    </DetailDrawer>
  );
}

export function PeopleView({ caseId, data }: { caseId: string; data: PeopleData }) {
  const { set } = useEntityParam();
  const all = [...data.people, ...data.identifiers];
  return (
    <>
      <div className="panel overflow-hidden">
        {data.people.length ? (
          <ul className="divide-y divide-line">
            {data.people.map((p) => (
              <li key={p.id} className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <button type="button" onClick={() => set(p.id)} className="text-left text-body font-semibold text-ink hover:text-action hover:underline">
                    {p.label}
                  </button>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {p.roles.map((r) => (
                      <Tag key={r.role} tone={r.role === "VICTIM" || r.role === "COMPLAINANT" ? "info" : "neutral"}>
                        {PARTY_ROLE_TEXT[r.role]}
                      </Tag>
                    ))}
                  </div>
                  <p className="mt-1 text-label text-ink-2">
                    {p.relationships.length ? p.relationships.map((r) => `${RELATIONSHIP_LABELS[r.type]}: ${r.other}`).join("; ") : "No linked identifiers recorded"}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-3 text-label text-ink-2 sm:flex-col sm:items-end">
                  {p.lossMinor ? (
                    <span>
                      Loss <AmountDisplay minor={p.lossMinor} className="font-medium text-ink" />
                    </span>
                  ) : null}
                  <span>{p.sources.length} {p.sources.length === 1 ? "source" : "sources"}</span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title="No people recorded" description="People are added at intake or from reviewed documents and responses. Each stays a separate record." />
        )}
      </div>
      <EntityDrawer caseId={caseId} data={data} all={all} />
    </>
  );
}

function CorroborationControl({ locationId, current }: { locationId: string; current: string }) {
  const [value, setValue] = useState(current);
  const [note, setNote] = useState("");
  const action = useServerAction(setLocationCorroborationAction);
  return (
    <div className="flex w-full flex-col gap-2">
      <FormField label="Corroboration">
        <Select value={value} onChange={(e) => setValue(e.target.value)}>
          <option value="UNCORROBORATED">Uncorroborated</option>
          <option value="CORROBORATED">Corroborated</option>
          <option value="CONTRADICTED">Contradicted</option>
        </Select>
      </FormField>
      <FormField label="Basis" error={action.fieldErrors.note}>
        <Input value={note} onChange={(e) => setNote(e.target.value)} />
      </FormField>
      <Button size="sm" variant="secondary" loading={action.pending} onClick={() => action.run([locationId, value as "UNCORROBORATED" | "CORROBORATED" | "CONTRADICTED", note], { success: "Corroboration recorded", onSuccess: () => setNote("") })}>
        Record corroboration
      </Button>
    </div>
  );
}

type IdRow = PeopleData["identifiers"][number];
const IDV_SORT: Record<string, (i: IdRow) => SortValue> = {
  label: (i) => i.label,
  kind: (i) => IDENTIFIER_KIND_LABELS[i.kind] ?? i.kind,
  role: (i) => i.caseRole,
  verification: (i) => i.verificationStatus,
  first: (i) => (i.discoveredAt ? new Date(i.discoveredAt) : null),
  requests: (i) => i.requests.length,
};

export function IdentifiersView({ caseId, data }: { caseId: string; data: PeopleData }) {
  const { set } = useEntityParam();
  const { rows: identifiers, sort, toggle } = useSort(data.identifiers, IDV_SORT);
  const all = [...data.people, ...data.identifiers];
  return (
    <>
      <section aria-labelledby="ids-title" className="panel overflow-hidden">
        <div className="border-b border-line px-5 py-3.5">
          <h3 id="ids-title" className="text-section font-semibold tracking-tight text-ink">
            Identifiers
          </h3>
          <p className="mt-0.5 text-label text-ink-2">Accounts, numbers, addresses, profiles, websites, IP addresses and devices. Values are shown exactly as recorded.</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] border-collapse text-left">
            <caption className="sr-only">Identifiers</caption>
            <thead className="bg-surface-muted">
              <tr className="border-b border-line text-label text-ink-2">
                <SortTh k="label" sort={sort} onSort={toggle} className="px-4 py-2.5 font-medium">Identifier</SortTh>
                <SortTh k="kind" sort={sort} onSort={toggle} className="px-4 py-2.5 font-medium">Kind</SortTh>
                <SortTh k="role" sort={sort} onSort={toggle} className="px-4 py-2.5 font-medium">Role in this case</SortTh>
                <SortTh k="verification" sort={sort} onSort={toggle} className="px-4 py-2.5 font-medium">Verification</SortTh>
                <SortTh k="first" sort={sort} onSort={toggle} className="px-4 py-2.5 font-medium">First recorded</SortTh>
                <SortTh k="requests" sort={sort} onSort={toggle} className="px-4 py-2.5 text-right font-medium">Requests</SortTh>
              </tr>
            </thead>
            <tbody>
              {identifiers.map((i) => (
                <tr key={i.id} className="border-b border-line align-top last:border-b-0 hover:bg-surface-muted">
                  <td className="px-4 py-3">
                    <button type="button" onClick={() => set(i.id)} className="text-left font-medium text-ink hover:text-action hover:underline">
                      {i.label}
                    </button>
                    {i.label !== i.value ? <span className="block font-mono text-label text-ink-2">{i.value}</span> : null}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-body text-ink-2">{IDENTIFIER_KIND_LABELS[i.kind] ?? i.kind}</td>
                  <td className="max-w-[30ch] px-4 py-3 text-body text-ink-2">{i.caseRole ?? "Not stated"}</td>
                  <td className="px-4 py-3">
                    <StatusBadge kind="verification" value={i.verificationStatus} />
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-body text-ink-2">
                    <DateTime iso={i.discoveredAt} mode="date" />
                    <span className="block text-meta text-ink-3">Phase {i.discoveryPhase}</span>
                  </td>
                  <td className="px-4 py-3 text-right text-body text-ink-2">{i.requests.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="loc-title" className="panel mt-6 overflow-hidden">
        <div className="border-b border-line px-5 py-3.5">
          <h3 id="loc-title" className="text-section font-semibold tracking-tight text-ink">
            Location Leads
          </h3>
          <p className="mt-0.5 text-label text-ink-2">Historical observations with the time of the event and the time it was received. None of these is a current location, and there is no live tracking.</p>
        </div>
        {data.locations.length ? (
          <ol className="divide-y divide-line">
            {data.locations.map((l) => (
              <li key={l.id} className="grid grid-cols-1 gap-3 px-5 py-4 lg:grid-cols-[12rem_1fr_14rem]">
                <div className="text-label">
                  <p className="font-medium text-ink">{l.eventAt ? <DateTime iso={l.eventAt} mode={isDateOnlyObservation(l.observationType) ? "date" : "datetime"} /> : "Event time unknown"}</p>
                  <p className="text-ink-3">{l.eventAtNote ?? "Time of the event"}</p>
                  <p className="mt-1 text-ink-3">
                    Received <DateTime iso={l.receivedAt} mode="date" />
                  </p>
                </div>
                <div className="min-w-0">
                  <p className="flex items-start gap-1.5 text-body font-medium text-ink">
                    <MapPin aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-ink-3" />
                    {l.description}
                  </p>
                  <p className="mt-0.5 text-body text-ink">{l.locationText}</p>
                  <p className="text-label text-ink-2">Precision: {l.precision}</p>
                  {l.limitations ? <p className="mt-1 text-label text-warning">{l.limitations}</p> : null}
                  {l.entityLabel ? <p className="mt-1 text-label text-ink-3">Relates to {l.entityLabel}</p> : null}
                  {l.sources.map((s, i) => (
                    <EvidenceLink key={i} caseId={caseId} source={s} className="mt-1" />
                  ))}
                </div>
                <div className="flex flex-col items-start gap-2">
                  <StatusBadge kind="corroboration" value={l.corroboration} />
                  {l.corroborationNote ? <p className="text-label text-ink-2">{l.corroborationNote}</p> : null}
                  <CorroborationControl locationId={l.id} current={l.corroboration} />
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <EmptyState compact title="No location observations" description="Login records, KYC addresses and other location information from reviewed responses appear here with their times and limits." />
        )}
      </section>
      <EntityDrawer caseId={caseId} data={data} all={all} />
    </>
  );
}
