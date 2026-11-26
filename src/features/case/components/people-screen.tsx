"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Icon } from "@/components/ui/icon";
import { C } from "@/components/design/tokens";
import { DesignModal, ModalTitle } from "@/components/design/modal";
import { SortTh, useSort, type SortValue } from "@/components/design/sort";
import type { PeopleViewData } from "@/server/services/people-view";
import { addPeopleEntryAction, updateIdentifierNotesAction, updatePersonDetailsAction } from "../actions";

type Row = PeopleViewData["rows"][number];
type Person = PeopleViewData["people"][number];
const ID_SORT: Record<string, (r: Row) => SortValue> = {
  name: (r) => r.name,
  what: (r) => r.what,
  requests: (r) => r.requests,
  also: (r) => r.alsoIn.length || null,
  status: (r) => r.status.text,
};
type Group = "all" | "phone" | "account" | "online";
/** Who it belongs to in the money trail: the accused's side, one level of the trail, or the victim's own. */
type Trail = "all" | "accused" | "victim" | number;
const trailLabel = (t: Trail) => (t === "accused" ? "Accused / suspect" : t === "victim" ? "Victim’s own" : t === "all" ? "Everyone" : `Level ${t}`);
type Belongs = "SUSPECT" | "VICTIM" | "WITNESS" | "UNKNOWN";
const BELONGS: { v: Belongs; label: string }[] = [
  { v: "SUSPECT", label: "Suspect" },
  { v: "VICTIM", label: "Victim" },
  { v: "WITNESS", label: "Witness" },
  { v: "UNKNOWN", label: "Unknown" },
];
const belongsLabel = (b: string | null) => BELONGS.find((x) => x.v === b)?.label ?? "Not set";

function Pill({ s }: { s: { text: string; tone: string } }) {
  return <span className={`pill ${s.tone}`}>{s.text}</span>;
}

/** People & identifiers (design: People artboard). */
export function PeopleScreen({ refLabel, data }: { refLabel: string; data: PeopleViewData }) {
  const [group, setGroup] = useState<Group>("all");
  const [trail, setTrail] = useState<Trail>("all");
  const [openId, setOpenId] = useState<string | null>(null);
  const [personId, setPersonId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const b = `/cases/${data.caseId}`;
  const inTrail = (r: Row, t: Trail) => t === "all" || (t === "accused" ? r.side === "ACCUSED" : t === "victim" ? r.side === "VICTIM" : r.trail?.level === t);
  const filtered = data.rows.filter((r) => (group === "all" || r.group === group) && inTrail(r, trail));
  const { rows, sort, toggle } = useSort(filtered, ID_SORT);
  const trailTabs: Trail[] = ["all", "accused", ...Array.from({ length: data.deepest }, (_, i) => i + 1), "victim"];
  const open = openId ? (data.rows.find((r) => r.id === openId) ?? null) : null;
  const person = personId ? (data.people.find((p) => p.id === personId) ?? null) : null;
  const mine = data.rows.filter((r) => r.officerEntry).length + data.people.filter((p) => p.officerEntry).length;
  const tabs: { k: Group; label: string }[] = [
    { k: "all", label: "All" },
    { k: "phone", label: "Phones" },
    { k: "account", label: "Accounts" },
    { k: "online", label: "Online" },
  ];
  return (
    <>
      <header className="casehead" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 16 }}>
        <div style={{ flex: "1 1 360px", minWidth: 0 }}>
          <div className="mut" style={{ fontSize: 13 }}>
            <Link href={b}>{refLabel}</Link>
            <span style={{ margin: "0 6px" }} aria-hidden="true">
              /
            </span>
            People &amp; Identifiers
          </div>
          <h1 className="h" style={{ fontSize: 28 }}>
            People and Identifiers
          </h1>
        </div>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          {data.canWrite ? (
            <button className="btn" type="button" aria-haspopup="dialog" onClick={() => setAdding(true)}>
              Add a person or identifier
            </button>
          ) : null}
          <Link className="btn primary" href={`${b}/graph`}>
            See the graph
          </Link>
        </div>
      </header>

      <div className="casepad" style={{ display: "flex", flexDirection: "column", gap: 24, maxWidth: 1240, width: "100%" }}>
        <section aria-label="People" className="partygrid" style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 16 }}>
          {data.people.map((p) => (
            <button key={p.id} type="button" className="card party partybtn" aria-haspopup="dialog" aria-label={`${p.label}: open the person card`} onClick={() => setPersonId(p.id)}>
              <div className="row" style={{ gap: 12 }}>
                <span className="avatar" aria-hidden="true">
                  {p.initials}
                </span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 600 }}>{p.label}</div>
                  <div className="sec" style={{ fontSize: 13 }}>
                    {p.sub}
                  </div>
                </div>
              </div>
              <div className="sec" style={{ fontSize: 14 }}>
                {p.what} {p.officerEntry ? <span className="pill you">{p.officerEntry}</span> : null}
              </div>
            </button>
          ))}
        </section>

        <section className="card" style={{ display: "flex", flexDirection: "column" }} aria-labelledby="ids">
          <div style={{ padding: "20px 28px", display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
            <h2 id="ids" className="h" style={{ fontSize: 18, flex: "1 1 200px" }}>
              Numbers, Accounts and Profiles
            </h2>
            <div className="row" role="tablist" aria-label="Filter identifiers by kind" style={{ flexWrap: "wrap", gap: 4 }}>
              {tabs.map((t) => (
                <button key={t.k} className={`tab${group === t.k ? " on" : ""}`} type="button" role="tab" aria-selected={group === t.k} onClick={() => setGroup(t.k)}>
                  {t.label} <span className="num mut">{data.counts[t.k]}</span>
                </button>
              ))}
            </div>
          </div>
          <div style={{ padding: "0 28px 16px", display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
            <span className="lbl" id="trail-filter" style={{ marginRight: 4 }}>
              In the money trail
            </span>
            <div className="row" role="group" aria-labelledby="trail-filter" style={{ flexWrap: "wrap", gap: 4 }}>
              {trailTabs.map((t) => {
                const n = data.rows.filter((r) => (group === "all" || r.group === group) && inTrail(r, t)).length;
                return (
                  <button
                    key={String(t)}
                    className={`tab${trail === t ? " on" : ""}`}
                    type="button"
                    aria-pressed={trail === t}
                    title={typeof t === "number" ? (t === 1 ? "Accounts the victim paid directly, and the numbers and UPI IDs linked to them" : `Accounts the money reached from level ${t - 1}, and what is linked to them`) : t === "accused" ? "Named as the accused’s or a suspect’s, or the victim’s money reached it" : t === "victim" ? "The victim’s own accounts and numbers" : "Every identifier"}
                    onClick={() => setTrail(t)}
                  >
                    {trailLabel(t)} <span className="num mut">{n}</span>
                  </button>
                );
              })}
            </div>
            {data.deepest === 0 ? (
              <span className="mut" style={{ fontSize: 13 }}>
                Levels appear once a payment or transfer is recorded.
              </span>
            ) : null}
          </div>
          <div style={{ overflowX: "auto" }}>
            <table className="table wide">
              <thead>
                <tr>
                  <SortTh k="name" sort={sort} onSort={toggle}>Identifier</SortTh>
                  <SortTh k="what" sort={sort} onSort={toggle}>What it is in this case</SortTh>
                  <SortTh k="requests" sort={sort} onSort={toggle}>Requests</SortTh>
                  <SortTh k="also" sort={sort} onSort={toggle}>Also in</SortTh>
                  <SortTh k="status" sort={sort} onSort={toggle}>Status</SortTh>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="r" onClick={() => setOpenId(r.id)}>
                    <td>
                      <button className="rowbtn" type="button" aria-haspopup="dialog" onClick={(e) => { e.stopPropagation(); setOpenId(r.id); }}>
                        {r.name}
                      </button>
                      <span className="sub">
                        {r.nickname ? `“${r.nickname}”` : (r.alias ?? r.kindLabel)}
                        {r.trail ? ` · Level ${r.trail.level}${r.trail.linkedTo ? `, linked to ${r.trail.linkedTo}` : ""}` : r.side === "ACCUSED" ? " · Accused’s side" : ""}
                      </span>
                    </td>
                    <td>
                      {r.what}
                      <span className="sub">{r.whatSub}</span>
                    </td>
                    <td>
                      {r.requests ? <span className="num">{r.requests}</span> : <span className="mut">None yet</span>}
                      <span className="sub">{r.requestsSub}</span>
                    </td>
                    <td>
                      {r.alsoIn.length ? (
                        <>
                          <span className="pill info">
                            {r.alsoIn.length} other {r.alsoIn.length === 1 ? "case" : "cases"}
                          </span>
                          <span className="sub">
                            {r.alsoIn.map((c) => c.ref).join(", ")} · same {r.group === "phone" ? "number" : r.group === "account" ? "account" : "identifier"}
                          </span>
                        </>
                      ) : (
                        <>
                          <span className="mut">—</span>
                          <span className="sub">{r.status.text === "Incomplete" ? "Not searched until it is complete" : "No match in the station’s cases"}</span>
                        </>
                      )}
                    </td>
                    <td>
                      <Pill s={r.status} />
                    </td>
                  </tr>
                ))}
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={5} style={{ padding: "40px 16px", textAlign: "center" }}>
                      <div style={{ fontSize: 15, fontWeight: 500, color: C.fg }}>
                        {group === "all" && trail === "all" ? "No numbers, accounts or profiles yet" : `No ${group === "all" ? "identifiers" : tabs.find((t) => t.k === group)!.label.toLowerCase()}${trail === "all" ? "" : ` at “${trailLabel(trail)}”`} in this case`}
                      </div>
                      <div className="sec">Add one from the button above, or pick another filter.</div>
                      {group !== "all" || trail !== "all" ? (
                        <button className="btn sm" type="button" style={{ marginTop: 12 }} onClick={() => { setGroup("all"); setTrail("all"); }}>
                          Show all
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
          <p className="mut" style={{ margin: 0, padding: "14px 28px", fontSize: 13 }}>
            {data.rows.length} {data.rows.length === 1 ? "identifier" : "identifiers"}
            {mine ? `, ${mine} added by an officer` : ""}. Click a row for its details, requests and other cases.
          </p>
        </section>

        <section className="stack-narrow" style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 24 }}>
          <article className="card cardpad" style={{ padding: "24px 28px", display: "flex", flexDirection: "column", gap: 4 }}>
            <h2 className="h" style={{ fontSize: 18 }}>
              What the Records Say
            </h2>
            {data.statements.length ? (
              <ul className="list">
                {data.statements.map((s) => (
                  <li key={s.id}>
                    <span className="t">
                      {s.title}
                      <span className="s">{s.sub}</span>
                    </span>
                    <Pill s={s.pill} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="sec" style={{ margin: "8px 0 0", fontSize: 14 }}>
                No record links a person to a number or account yet. Replies you apply add what they state here.
              </p>
            )}
          </article>
          <div style={{ display: "flex", flexDirection: "column", gap: 24, minWidth: 0 }}>
            <article className="card cardpad" style={{ padding: "24px 28px", display: "flex", flexDirection: "column", gap: 4 }}>
              <h2 className="h" style={{ fontSize: 18 }}>
                Where Anyone Was Seen
              </h2>
              {data.sightings.length ? (
                <ul className="list">
                  {data.sightings.map((s) => (
                    <li key={s.id}>
                      <span className="t">
                        {s.title}
                        <span className="s">{s.sub}</span>
                      </span>
                      <Pill s={s.pill} />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="sec" style={{ margin: "8px 0 0", fontSize: 14 }}>
                  No sighting is recorded yet.
                </p>
              )}
              {data.sightingsNote ? (
                <p className="mut" style={{ margin: "8px 0 0", fontSize: 13 }}>
                  {data.sightingsNote}
                </p>
              ) : null}
            </article>
            <article className="card cardpad" style={{ padding: "24px 28px", display: "flex", flexDirection: "column", gap: 4 }}>
              <h2 className="h" style={{ fontSize: 18 }}>
                Still to Establish
              </h2>
              {data.open.length ? (
                <ul className="list">
                  {data.open.map((q) => (
                    <li key={q}>
                      <span className="t">{q}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="sec" style={{ margin: "8px 0 0", fontSize: 14 }}>
                  Nothing open: every account with a named holder has a record of who used it.
                </p>
              )}
            </article>
          </div>
        </section>
      </div>

      <DesignModal open={!!open} onClose={() => setOpenId(null)} scope="scr-people" maxWidth={720}>
        {open ? <Detail key={open.id} r={open} caseId={data.caseId} canWrite={data.canWrite} onClose={() => setOpenId(null)} /> : null}
      </DesignModal>
      <DesignModal open={!!person} onClose={() => setPersonId(null)} scope="scr-people" maxWidth={720}>
        {person ? (
          <PersonCard
            key={person.id}
            p={person}
            data={data}
            onClose={() => setPersonId(null)}
            onOpenIdentifier={(id) => {
              setPersonId(null);
              setOpenId(id);
            }}
          />
        ) : null}
      </DesignModal>
      <DesignModal open={adding} onClose={() => setAdding(false)} scope="scr-people" maxWidth={600}>
        {adding ? <AddEntry caseId={data.caseId} onClose={() => setAdding(false)} /> : null}
      </DesignModal>
    </>
  );
}

type PersonForm = { name: string; alias: string; relative: string; age: string; gender: string; address: string; occupation: string; notes: string; belongsTo: Belongs };
const PERSON_FIELDS: { k: Exclude<keyof PersonForm, "belongsTo" | "notes" | "address">; label: string; hint: string; max: number }[] = [
  { k: "name", label: "Name", hint: "P. Kiran", max: 120 },
  { k: "alias", label: "Alias", hint: "Kiran bhai", max: 60 },
  { k: "relative", label: "Father’s or husband’s name", hint: "P. Ramesh", max: 120 },
  { k: "age", label: "Age", hint: "About 30", max: 20 },
  { k: "gender", label: "Gender", hint: "Male", max: 20 },
  { k: "occupation", label: "Occupation", hint: "Not known", max: 120 },
];
const formOf = (p: Person): PersonForm => ({
  name: p.card.officer.name ?? "",
  alias: p.card.officer.alias ?? "",
  relative: p.card.officer.relative ?? "",
  age: p.card.officer.age ?? "",
  gender: p.card.officer.gender ?? "",
  address: p.card.officer.address ?? "",
  occupation: p.card.officer.occupation ?? "",
  notes: p.card.officer.notes ?? "",
  belongsTo: (p.card.officer.belongsTo as Belongs | null) ?? (p.victim ? "VICTIM" : "UNKNOWN"),
});

/**
 * A person's card: what the records say about them (each fact with where it came from), the numbers and accounts
 * linked to them, the requests about those, and the officer's own details, which an officer can change. The records'
 * facts update as replies are applied; the officer's details are kept beside them, never over them, and logged.
 */
function PersonCard({ p, data, onClose, onOpenIdentifier }: { p: Person; data: PeopleViewData; onClose: () => void; onOpenIdentifier: (id: string) => void }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState(false);
  const [f, setF] = useState<PersonForm>(() => formOf(p));
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();
  // The version this card last saved: newer than the page's until the refreshed page catches up, so a second save
  // straight after the first is not refused as someone else's change.
  const [savedVersion, setSavedVersion] = useState<string | null>(null);
  const version = savedVersion && savedVersion > p.card.version ? savedVersion : p.card.version;
  const linked = p.card.linked.map((id) => data.rows.find((r) => r.id === id)).filter((r): r is Row => !!r);
  const requests = [...new Map(linked.flatMap((r) => r.requestList).map((q) => [q.id, q])).values()];
  const statements = data.statements.filter((s) => p.card.statementIds.includes(s.id));
  const o = p.card.officer;
  const officerRows: [string, string | null][] = [
    ["Name", o.name],
    ["Alias", o.alias],
    ["Father’s or husband’s name", o.relative],
    ["Age", o.age],
    ["Gender", o.gender],
    ["Address", o.address],
    ["Occupation", o.occupation],
    ["Notes", o.notes],
  ];
  const anyOfficer = officerRows.some(([, v]) => !!v) || (o.belongsTo && o.belongsTo !== "UNKNOWN");
  const set = (k: keyof PersonForm, v: string) => {
    setF((x) => ({ ...x, [k]: v }));
    if (fieldErrors[k]) setFieldErrors(({ [k]: _drop, ...rest }) => rest);
  };
  const save = () =>
    start(async () => {
      setError(null);
      setFieldErrors({});
      const res = await updatePersonDetailsAction(p.id, {
        version,
        name: f.name.trim() || null,
        alias: f.alias.trim() || null,
        relative: f.relative.trim() || null,
        age: f.age.trim() || null,
        gender: f.gender.trim() || null,
        address: f.address.trim() || null,
        occupation: f.occupation.trim() || null,
        notes: f.notes.trim() || null,
        belongsTo: f.belongsTo,
      });
      if (!res.ok) {
        setError(res.error);
        setFieldErrors(res.fieldErrors ?? {});
        return;
      }
      setSavedVersion(res.data.version);
      setEditing(false);
      setSaved(true);
      router.refresh();
    });
  const fieldProps = (k: keyof PersonForm) => ({ "aria-invalid": fieldErrors[k] ? true : undefined, "aria-describedby": fieldErrors[k] ? `pe-${k}-err` : undefined });
  const err = (k: keyof PersonForm) => (fieldErrors[k] ? <span id={`pe-${k}-err`} className="fielderr">{fieldErrors[k]}</span> : null);
  return (
    <>
      <div className="mhead">
        <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
          <span className="lbl">{p.victim ? "Victim" : "Person"}</span>
          <span className="pill info">{p.code}</span>
          {p.officerEntry ? <span className="pill you">{p.officerEntry}</span> : null}
        </div>
        <ModalTitle style={{ fontSize: 20, margin: 0 }}>{p.label}</ModalTitle>
        <p className="sec" style={{ margin: 0, fontSize: 14 }}>
          {p.sub}. {p.what}
        </p>
      </div>
      <div className="mbody">
        {saved ? (
          <div className="banner ok" role="status">
            <Icon name="check" />
            <div>Details saved and logged as your entry. Nothing a record said was changed.</div>
          </div>
        ) : null}
        {error ? (
          <div className="banner warn" role="alert">
            <Icon name="alert" />
            <div>{error}</div>
          </div>
        ) : null}
        <div>
          <div className="lbl">From the records</div>
          {p.card.facts.length ? (
            <dl className="kv" style={{ marginTop: 8 }}>
              {p.card.facts.map((x, i) => (
                <span key={`${x.k}:${i}`} style={{ display: "contents" }}>
                  <dt>{x.k}</dt>
                  <dd style={{ overflowWrap: "anywhere" }}>
                    {x.v}
                    {x.src ? <span className="mut" style={{ display: "block", fontSize: 12 }}>{x.src}</span> : null}
                  </dd>
                </span>
              ))}
            </dl>
          ) : (
            <p className="sec" style={{ margin: "6px 0 0", fontSize: 14 }}>
              No record has said anything about this person yet. Replies to the requests below add to this card as they are applied.
            </p>
          )}
        </div>
        <div>
          <div className="lbl">Your Details</div>
          {!editing ? (
            anyOfficer ? (
              <>
                <dl className="kv" style={{ marginTop: 8 }}>
                  {officerRows.filter(([, v]) => !!v).map(([k, v]) => (
                    <span key={k} style={{ display: "contents" }}>
                      <dt>{k}</dt>
                      <dd style={{ overflowWrap: "anywhere", whiteSpace: k === "Notes" || k === "Address" ? "pre-wrap" : undefined }}>{v}</dd>
                    </span>
                  ))}
                  <dt>Side</dt>
                  <dd>{belongsLabel(o.belongsTo)}</dd>
                </dl>
                {o.by ? (
                  <p className="mut" style={{ margin: "8px 0 0", fontSize: 13 }}>
                    Entered by {o.by}
                    {o.at ? ` on ${new Date(o.at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })}` : ""}.
                  </p>
                ) : null}
              </>
            ) : (
              <p className="sec" style={{ margin: "6px 0 0", fontSize: 14 }}>
                {data.canWrite ? "Nothing entered yet. Use Edit details to add a name or anything else learned during the investigation." : "Nothing entered by an officer yet."}
              </p>
            )
          ) : (
            <>
              <div className="stack-narrow" style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "14px 16px", marginTop: 8 }}>
                {PERSON_FIELDS.map((x) => (
                  <label key={x.k} className="fld">
                    {x.label}
                    <input className="in" type="text" placeholder={x.hint} value={f[x.k]} maxLength={x.max} onChange={(e) => set(x.k, e.target.value)} {...fieldProps(x.k)} />
                    {err(x.k)}
                  </label>
                ))}
                <label className="fld">
                  Side
                  <select className="in sel" value={f.belongsTo} onChange={(e) => set("belongsTo", e.target.value)}>
                    {BELONGS.map((b) => (
                      <option key={b.v} value={b.v}>
                        {b.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="fld" style={{ gridColumn: "1 / -1" }}>
                  Address
                  <textarea className="in" rows={2} placeholder="As learned during the investigation" value={f.address} maxLength={400} onChange={(e) => set("address", e.target.value)} {...fieldProps("address")} />
                  {err("address")}
                </label>
                <label className="fld" style={{ gridColumn: "1 / -1" }}>
                  Notes
                  <textarea className="in" rows={3} placeholder="Where this was learned: a call, a visit, a portal screen" value={f.notes} maxLength={2000} onChange={(e) => set("notes", e.target.value)} {...fieldProps("notes")} />
                  {err("notes")}
                </label>
              </div>
              <p className="mut" style={{ margin: "8px 0 0", fontSize: 13 }}>
                Your details are shown beside the records, never over them, and each change is logged with your name. A name you enter shows on the card as “Name ({p.code})” until a record gives one.
              </p>
            </>
          )}
        </div>
        <div>
          <div className="lbl">Numbers and Accounts</div>
          {linked.length ? (
            <ul className="list">
              {linked.map((r) => (
                <li key={r.id}>
                  <button type="button" className="t linkbtn" onClick={() => onOpenIdentifier(r.id)}>
                    {r.name}
                    <span className="s">{r.what}</span>
                  </button>
                  <Pill s={r.status} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="sec" style={{ margin: "6px 0 0", fontSize: 14 }}>
              No number or account is linked to this person by a record yet.
            </p>
          )}
        </div>
        <div>
          <div className="lbl">Requests and Replies</div>
          {requests.length ? (
            <ul className="list">
              {requests.map((q) => (
                <li key={q.id}>
                  <Link className="t" href={`/cases/${data.caseId}/requests/${q.id}`} style={{ color: "inherit" }}>
                    {q.title}
                    <span className="s">{q.sub}</span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="sec" style={{ margin: "6px 0 0", fontSize: 14 }}>
              Nothing has been asked about this person’s numbers or accounts yet.
            </p>
          )}
        </div>
        {statements.length ? (
          <div>
            <div className="lbl">What the Records Say</div>
            <ul className="list">
              {statements.map((x) => (
                <li key={x.id}>
                  <span className="t">
                    {x.title}
                    <span className="s">{x.sub}</span>
                  </span>
                  <Pill s={x.pill} />
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
      <div className="mfoot">
        {!editing ? (
          <>
            {data.canWrite ? (
              <button className="btn" type="button" onClick={() => { setSaved(false); setError(null); setF(formOf(p)); setEditing(true); }}>
                Edit details
              </button>
            ) : null}
            <button className="btn primary" type="button" onClick={onClose}>
              Close
            </button>
          </>
        ) : (
          <>
            <button className="btn" type="button" onClick={() => { setEditing(false); setError(null); setFieldErrors({}); setF(formOf(p)); }}>
              Cancel
            </button>
            <button className="btn primary" type="button" onClick={save} aria-busy={pending} disabled={pending}>
              {pending ? "Saving…" : "Save details"}
            </button>
          </>
        )}
      </div>
    </>
  );
}

function Detail({ r, caseId, canWrite, onClose }: { r: Row; caseId: string; canWrite: boolean; onClose: () => void }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState(false);
  const [nick, setNick] = useState(r.nickname ?? "");
  const [belongs, setBelongs] = useState<Belongs>((r.belongsTo as Belongs | null) ?? "UNKNOWN");
  const [bank, setBank] = useState(r.routing.bank ?? "");
  const [ifsc, setIfsc] = useState(r.routing.ifsc ?? "");
  const [provider, setProvider] = useState(r.routing.provider ?? "");
  const [drafted, setDrafted] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const account = ["BANK_ACCOUNT", "UPI_ID", "WALLET"].includes(r.kind);
  const providerLabel = r.kind === "EMAIL" ? "Mail provider" : r.kind === "WEBSITE" ? "Registrar" : r.kind === "PLATFORM_PROFILE" ? "Platform" : null;
  const reset = () => {
    setNick(r.nickname ?? "");
    setBelongs((r.belongsTo as Belongs | null) ?? "UNKNOWN");
    setBank(r.routing.bank ?? "");
    setIfsc(r.routing.ifsc ?? "");
    setProvider(r.routing.provider ?? "");
  };
  const save = () =>
    start(async () => {
      setError(null);
      const res = await updateIdentifierNotesAction(r.id, {
        nickname: nick.trim() || null,
        belongsTo: belongs,
        ...(account ? { bank: bank.trim() || null, ifsc: ifsc.trim() || null } : {}),
        ...(providerLabel ? { provider: provider.trim() || null } : {}),
      });
      if (!res.ok) setError(res.error);
      else {
        setEditing(false);
        setSaved(true);
        setDrafted(res.data.autoDraft?.drafted ? `${res.data.autoDraft.drafted === 1 ? "A request was" : `${res.data.autoDraft.drafted} requests were`} drafted for it (${res.data.autoDraft.references.join(", ")}); see Next actions. Nothing was sent.` : null);
        router.refresh();
      }
    });
  return (
    <>
      <div className="mhead">
        <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
          <span className="lbl">{r.kindLabel}</span>
          <Pill s={r.status} />
        </div>
        <ModalTitle style={{ fontSize: 20, margin: 0 }}>{r.name}</ModalTitle>
        <p className="sec" style={{ margin: 0, fontSize: 14 }}>
          {r.what}
        </p>
      </div>
      <div className="mbody">
        {saved ? (
          <div className="banner ok" role="status">
            <Icon name="check" />
            <div>Details saved and logged as your entry. Nothing a record said was changed.{drafted ? ` ${drafted}` : ""}</div>
          </div>
        ) : null}
        {error ? (
          <div className="banner warn" role="alert">
            <Icon name="alert" />
            <div>{error}</div>
          </div>
        ) : null}
        {!editing ? (
          <dl className="kv">
            <dt>Belongs to</dt>
            <dd>{belongsLabel(r.belongsTo)}</dd>
            <dt>Nickname</dt>
            <dd>{r.nickname ?? "None"}</dd>
            {r.kv.map(([k, v]) => (
              <span key={k} style={{ display: "contents" }}>
                <dt>{k}</dt>
                <dd style={{ overflowWrap: "anywhere" }}>{v}</dd>
              </span>
            ))}
            <dt>Source</dt>
            <dd>{r.source}</dd>
          </dl>
        ) : (
          <>
            <div className="stack-narrow" style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "14px 16px" }}>
              <label className="fld">
                Belongs to
                <select className="in sel" value={belongs} onChange={(e) => setBelongs(e.target.value as Belongs)}>
                  {BELONGS.map((o) => (
                    <option key={o.v} value={o.v}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="fld">
                Nickname
                <input className="in" type="text" placeholder="Caller" value={nick} maxLength={60} onChange={(e) => setNick(e.target.value)} />
              </label>
              {account ? (
                <>
                  <label className="fld">
                    Bank
                    <input className="in" type="text" placeholder="HDFC Bank" value={bank} maxLength={80} onChange={(e) => setBank(e.target.value)} />
                  </label>
                  <label className="fld">
                    IFSC
                    <input className="in" type="text" placeholder="HDFC0001234" value={ifsc} maxLength={11} autoCapitalize="characters" onChange={(e) => setIfsc(e.target.value.toUpperCase())} />
                  </label>
                </>
              ) : null}
              {providerLabel ? (
                <label className="fld">
                  {providerLabel}
                  <input className="in" type="text" placeholder={r.kind === "WEBSITE" ? "GoDaddy" : r.kind === "EMAIL" ? "Google" : "Telegram"} value={provider} maxLength={80} onChange={(e) => setProvider(e.target.value)} />
                </label>
              ) : null}
              {r.kv.filter(([k]) => !(account && (k === "Bank" || k === "IFSC")) && k !== providerLabel).map(([k, v]) => (
                <div key={k} className="fld">
                  {k}
                  <span className="sec" style={{ fontSize: 14, minHeight: 40, display: "flex", alignItems: "center" }}>
                    {v}
                  </span>
                </div>
              ))}
            </div>
            <p className="mut" style={{ margin: 0, fontSize: 13 }}>
              What a record said stays as the record said it; your entry is shown beside it and logged with your name.
              {account ? " The bank decides where freeze and statement requests go; with only the IFSC, the bank is read from it." : providerLabel ? ` The ${providerLabel.toLowerCase()} decides where requests about it go (from the nodal officer list).` : ""}
            </p>
          </>
        )}
        <div>
          <div className="lbl">Requests about it</div>
          {r.requestList.length ? (
            <ul className="list">
              {r.requestList.map((q) => (
                <li key={q.id}>
                  <Link className="t" href={`/cases/${caseId}/requests/${q.id}`} style={{ color: "inherit" }}>
                    {q.title}
                    <span className="s">{q.sub}</span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="sec" style={{ margin: "6px 0 0", fontSize: 14 }}>
              Nothing has been asked about it yet. Draft a request from Next actions.
            </p>
          )}
        </div>
        <div>
          <div className="lbl">Seen in other cases</div>
          {r.alsoIn.length ? (
            <ul className="list">
              {r.alsoIn.map((c) => (
                <li key={c.id}>
                  <span className="t">
                    {c.canOpen ? <Link href={`/cases/${c.id}`}>{c.ref}</Link> : c.ref}
                    <span className="s">{c.canOpen ? "Same identifier, recorded in that case" : "Same identifier. That case is another officer’s: ask them or the supervisor for details."}</span>
                  </span>
                  <span className="pill info">Linked</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="sec" style={{ margin: "6px 0 0", fontSize: 14 }}>
              No match in the station’s cases. Matching runs again whenever a reply adds a new identifier.
            </p>
          )}
        </div>
      </div>
      <div className="mfoot">
        {!editing ? (
          <>
            {canWrite ? (
              <Link className="btn" href={`/cases/${caseId}/actions`}>
                New request
              </Link>
            ) : null}
            {canWrite ? (
              <button className="btn" type="button" onClick={() => { setSaved(false); setDrafted(null); setEditing(true); }}>
                Edit details
              </button>
            ) : null}
            <button className="btn primary" type="button" onClick={onClose}>
              Close
            </button>
          </>
        ) : (
          <>
            <button className="btn" type="button" onClick={() => { setEditing(false); reset(); }}>
              Cancel
            </button>
            <button className="btn primary" type="button" onClick={save} aria-busy={pending}>
              {pending ? "Saving…" : "Save details"}
            </button>
          </>
        )}
      </div>
    </>
  );
}

type AddKind = "person" | "phone" | "account" | "online";
const ADD: Record<AddKind, { label: string; value: string; hint: string }> = {
  person: { label: "Person", value: "Name", hint: "R. Kumar" },
  phone: { label: "Phone", value: "Mobile number", hint: "+91-98XXXXXX12" },
  account: { label: "Account", value: "Account number or UPI ID", hint: "XXXXXXXX1234 or name@bank" },
  online: { label: "Online", value: "Profile, email, website or IP", hint: "name@example.com" },
};

/** The kind an "online" or "account" value is, from how it is written. */
function kindOf(k: AddKind, v: string): "PERSON" | "PHONE" | "BANK_ACCOUNT" | "UPI_ID" | "EMAIL" | "PLATFORM_PROFILE" | "WEBSITE" | "IP_ADDRESS" {
  const t = v.trim();
  if (k === "person") return "PERSON";
  if (k === "phone") return "PHONE";
  if (k === "account") return /@/.test(t) ? "UPI_ID" : "BANK_ACCOUNT";
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(t) || /^[0-9a-f:]+:[0-9a-f:]+$/i.test(t)) return "IP_ADDRESS";
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) return "EMAIL";
  if (/^(https?:\/\/|www\.)/i.test(t) || /\.[a-z]{2,}(\/|$)/i.test(t)) return "WEBSITE";
  return "PLATFORM_PROFILE";
}

function AddEntry({ caseId, onClose }: { caseId: string; onClose: () => void }) {
  const router = useRouter();
  const [k, setK] = useState<AddKind>("phone");
  const [val, setVal] = useState("");
  const [what, setWhat] = useState("");
  const [belongs, setBelongs] = useState<Belongs>("UNKNOWN");
  const [nick, setNick] = useState("");
  const [bank, setBank] = useState("");
  // Empty value: flagged on leaving the field (cleared again on focus) or on saving (kept until the officer types).
  const [missing, setMissing] = useState<null | "blur" | "submit">(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const invalid = !!missing && !val.trim();
  const save = () => {
    if (!val.trim()) {
      setMissing("submit");
      document.getElementById("add-val")?.focus();
      return;
    }
    start(async () => {
      setError(null);
      const kind = kindOf(k, val);
      const res = await addPeopleEntryAction(caseId, { kind, value: val.trim(), whatItIs: what.trim(), belongsTo: belongs, nickname: nick.trim() || null, bank: kind === "BANK_ACCOUNT" ? bank.trim() || null : null });
      if (!res.ok) setError(res.error);
      else {
        router.refresh();
        onClose();
      }
    });
  };
  return (
    <>
      <div className="mhead">
        <span className="lbl">This case</span>
        <ModalTitle style={{ fontSize: 20, margin: 0 }}>Add a Person or Identifier</ModalTitle>
        <p className="sec" style={{ margin: 0, fontSize: 14 }}>
          Something you learned that no record has given yet. It is marked as your entry until a record confirms it.
        </p>
      </div>
      <div className="mbody">
        <div>
          <div className="lbl" id="add-kind">
            What is it
          </div>
          <div className="segs" role="radiogroup" aria-labelledby="add-kind">
            {(Object.keys(ADD) as AddKind[]).map((x) => (
              <button key={x} className={`seg${k === x ? " on" : ""}`} type="button" role="radio" aria-checked={k === x} onClick={() => setK(x)}>
                {ADD[x].label}
              </button>
            ))}
          </div>
        </div>
        <label className="fld">
          {ADD[k].value}
          <input id="add-val" className="in" type="text" placeholder={ADD[k].hint} value={val} onChange={(e) => { setVal(e.target.value); setMissing(null); }} onBlur={() => !val.trim() && setMissing("blur")} onFocus={() => missing === "blur" && setMissing(null)} aria-invalid={invalid} aria-describedby={invalid ? "add-val-err" : undefined} maxLength={200} />
          {invalid ? (
            <span id="add-val-err" style={{ fontSize: 13, color: C.orange }}>
              Enter the {ADD[k].value.toLowerCase()} before saving.
            </span>
          ) : null}
        </label>
        <label className="fld">
          What it is in this case
          <input className="in" type="text" placeholder="Number the victim was told to call back on" value={what} onChange={(e) => setWhat(e.target.value)} maxLength={300} />
        </label>
        <div className="stack-narrow" style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "14px 16px" }}>
          <label className="fld">
            Belongs to
            <select className="in sel" value={belongs} onChange={(e) => setBelongs(e.target.value as Belongs)}>
              {BELONGS.map((o) => (
                <option key={o.v} value={o.v}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className="fld">
            Nickname
            <input className="in" type="text" placeholder="Optional" value={nick} onChange={(e) => setNick(e.target.value)} maxLength={60} />
          </label>
          {k === "account" && !val.includes("@") ? (
            <label className="fld">
              Bank
              <input className="in" type="text" placeholder="Bank D" value={bank} onChange={(e) => setBank(e.target.value)} maxLength={80} />
            </label>
          ) : null}
        </div>
      </div>
      <div className="mfoot" style={{ alignItems: "center" }}>
        {error ? (
          <span role="alert" style={{ fontSize: 13, color: C.orange, flex: "1 1 200px" }}>
            {error}
          </span>
        ) : null}
        <button className="btn" type="button" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" type="button" onClick={save} aria-busy={pending}>
          {pending ? "Adding…" : "Add to the case"}
        </button>
      </div>
    </>
  );
}
