import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/server/auth/current-user";
import { getDb } from "@/server/db";
import { orNotFound } from "@/server/not-found";
import { getCaseHome } from "@/server/services/case-home";
import { C } from "@/components/design/tokens";
import { MarkSeenButton } from "@/features/case/components/mark-seen-button";
import { AddFilesButton } from "@/features/case/components/add-files";
import { NewMailButton } from "@/features/requests/components/new-mail";
import { CaseContextButton } from "@/features/case/components/case-context";
import { gmailChannel } from "@/server/gmail/view";

export const metadata: Metadata = { title: "Case overview" };

const DOT = { gap: C.orange, neutral: C.mut } as const;

/** Case overview (design: Main artboard): where the case stands, what to do next, what changed, what it waits on. */
export default async function CaseOverviewPage({ params }: { params: Promise<{ caseId: string }> }) {
  const user = await requireUser();
  const { caseId } = await params;
  const o = await orNotFound(getCaseHome(getDb(), user, caseId));
  const b = `/cases/${caseId}`;
  const m = o.money;
  const barLabel = `${m.bar.held} percent of the loss is held, ${m.bar.traced} percent is under investigation, ${m.bar.returned ? `${m.bar.returned} percent has been returned` : "nothing has been returned"}`;

  return (
    <>
      <header className="casehead" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 16 }}>
        <div style={{ flex: "1 1 360px", minWidth: 0 }}>
          <div className="mut" style={{ fontSize: 13 }}>
            <Link href="/">All cases</Link>
            <span style={{ margin: "0 6px" }} aria-hidden="true">
              /
            </span>
            {o.header.breadcrumb}
          </div>
          <h1 className="h" style={{ fontSize: 28 }}>
            {o.header.title}
          </h1>
          <p className="sec" style={{ margin: "10px 0 0", fontSize: 15 }}>
            {o.header.sub}
          </p>
          <div className="row" style={{ flexWrap: "wrap", marginTop: 12 }}>
            <span className={`pill ${o.header.phase.tone}`}>{o.header.phase.text}</span>
            <span className="mut" style={{ fontSize: 13 }}>
              {o.header.progress}
            </span>
          </div>
        </div>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          {o.canWrite ? (
            <Link className="btn" href={`${b}/requests?inbox=1`} title="Log a reply that came from a bank, telecom or platform and match it to its request">
              Import a reply
            </Link>
          ) : null}
          {o.canWrite ? <AddFilesButton caseId={caseId} caseRef={o.header.breadcrumb} /> : null}
          {o.canWrite && gmailChannel().on ? <NewMailButton caseId={caseId} /> : null}
          <CaseContextButton caseId={caseId} caseRef={o.header.breadcrumb} />
          <Link className="btn primary" href={`${b}/actions`}>
            {o.actionsToReview ? `Review ${o.actionsToReview} next ${o.actionsToReview === 1 ? "action" : "actions"}` : "Open next actions"}
          </Link>
        </div>
      </header>

      <div className="casepad" style={{ display: "flex", flexDirection: "column", gap: 24, maxWidth: 1200, width: "100%" }}>
        <section className="card facts" aria-label="Case facts">
          {o.facts.map((f) => (
            <div key={f.label}>
              <span className="lbl">{f.label}</span>
              <span className={`v${f.mono ? " num" : ""}`}>{f.value}</span>
              <span className="s">
                {f.sub}
                {f.link ? <Link href={f.link.href}>{f.link.text}</Link> : null}
              </span>
            </div>
          ))}
        </section>

        <section className="stack-narrow" aria-label="Where the case stands" style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 24 }}>
          <article className="card cardpad" style={{ padding: "28px 32px", display: "flex", flexDirection: "column", gap: 20 }}>
            <h2 className="lbl" style={{ margin: 0 }}>
              Recovering the Money
            </h2>
            <div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
                <span className="h num" style={{ fontSize: 40, color: C.teal }}>
                  {m.held}
                </span>
                <span className="sec" style={{ fontSize: 18 }}>
                  {m.of}
                </span>
              </div>
              <div className="bar" role="img" aria-label={barLabel} style={{ marginTop: 16 }}>
                {m.bar.returned ? <span style={{ width: `${m.bar.returned}%`, background: C.blueStrong }} /> : null}
                <span style={{ width: `${m.bar.held}%`, background: C.tealStrong }} />
                <span style={{ width: `${m.bar.traced}%`, background: C.orangeStrong }} />
              </div>
            </div>
            <p style={{ margin: 0, fontSize: 15, color: C.fg3 }}>
              {m.sentence}
              {m.unknownHolds ? ` ${m.unknownHolds === 1 ? "One hold's" : `${m.unknownHolds} holds'`} amount is not confirmed yet and is not counted.` : ""}
            </p>
            <Link className="more" href={`${b}/recovery`}>
              Open the ledger
            </Link>
          </article>
          <article className="card cardpad" style={{ padding: "28px 32px", display: "flex", flexDirection: "column", gap: 20 }}>
            <h2 className="lbl" style={{ margin: 0 }}>
              Finding Who Did It
            </h2>
            <div>
              <div className="h" style={{ fontSize: 28, color: o.identity.identified ? C.teal : C.orange }}>
                {o.identity.headline}
              </div>
              <div className="row" style={{ gap: 24, flexWrap: "wrap", fontSize: 15, marginTop: 14 }}>
                <span className="row">
                  <span className="dot" style={{ background: C.blue }} aria-hidden="true" />
                  <span className="num">{o.identity.leads}</span>
                  <span className="sec">{o.identity.leads === 1 ? "open lead" : "open leads"}</span>
                </span>
                <span className="row">
                  <span className="dot" style={{ background: C.orangeStrong }} aria-hidden="true" />
                  <span className="num">{o.identity.sightings}</span>
                  <span className="sec">
                    {o.identity.sightings === 1 ? "sighting" : "sightings"}
                    {o.identity.sightingAge !== null ? `, ${o.identity.sightingAge === 0 ? "today" : `${o.identity.sightingAge} ${o.identity.sightingAge === 1 ? "day" : "days"} old`}` : ""}
                  </span>
                </span>
                <span className="row">
                  <span className="dot" style={{ background: C.amber }} aria-hidden="true" />
                  <span className="num">{o.identity.contradictions}</span>
                  <span className="sec">{o.identity.contradictions === 1 ? "contradiction" : "contradictions"}</span>
                </span>
              </div>
            </div>
            <p style={{ margin: 0, fontSize: 15, color: C.fg3 }}>{o.identity.sentence}</p>
            <Link className="more" href={`${b}/people`}>
              Open people &amp; identifiers
            </Link>
          </article>
        </section>

        <section className="stack-narrow" style={{ display: "grid", gridTemplateColumns: "minmax(0, 7fr) minmax(0, 5fr)", gap: 24 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 24, minWidth: 0 }}>
            <article className="card cardpad" style={{ padding: "24px 32px", display: "flex", flexDirection: "column", gap: 8 }}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <h2 className="h" style={{ fontSize: 18 }}>
                  Do Next
                </h2>
                <Link className="more" href={`${b}/actions`}>
                  Open all
                </Link>
              </div>
              {o.doNext.length ? (
                <ol className="list">
                  {o.doNext.map((a) => (
                    <li key={a.rank}>
                      <Link href={`${b}/actions?a=${a.rank}`}>
                        <span className="n">{a.rank}</span>
                        <span className="t" style={{ fontSize: 15, fontWeight: 500 }}>
                          {a.title}
                        </span>
                        <span className={`pill ${a.status.tone}`}>{a.status.text}</span>
                      </Link>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="sec" style={{ margin: "8px 0 0", fontSize: 15 }}>
                  Nothing is waiting on you. New actions appear here when a reply or a new record changes what the case needs.
                </p>
              )}
            </article>
            <article className="card cardpad" style={{ padding: "24px 32px", display: "flex", flexDirection: "column", gap: 8 }}>
              <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                <h2 className="h" style={{ fontSize: 18 }}>
                  What Changed Since You Last Looked
                </h2>
                {o.changes.items.length ? <MarkSeenButton caseId={caseId} /> : null}
              </div>
              {o.changes.items.length ? (
                <>
                  <ol className="list top">
                    {o.changes.items.map((c, i) => (
                      <li key={i}>
                        <span className="when">{c.when}</span>
                        <span className="t" style={{ fontSize: 15 }}>
                          {c.text}
                        </span>
                      </li>
                    ))}
                  </ol>
                  {o.changes.more ? (
                    <Link className="more" href={`${b}/activity`}>
                      {o.changes.more} earlier {o.changes.more === 1 ? "change" : "changes"} in Activity &amp; audit
                    </Link>
                  ) : null}
                </>
              ) : (
                <p className="sec" style={{ margin: "8px 0 0", fontSize: 15 }}>
                  {o.changes.sinceLabel ? `Nothing new since you looked on ${o.changes.sinceLabel}. Replies you apply will be listed here.` : "No replies have been applied to this case yet. When one is, what it changed is listed here."}
                </p>
              )}
            </article>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 24, minWidth: 0 }}>
            <article className="card cardpad" style={{ padding: "24px 32px", display: "flex", flexDirection: "column", gap: 8 }}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <h2 className="h" style={{ fontSize: 18 }}>
                  Waiting On
                </h2>
                <Link className="more" href={`${b}/requests`}>
                  All requests
                </Link>
              </div>
              {o.waiting.length ? (
                <ul className="list">
                  {o.waiting.map((w) => (
                    <li key={w.text}>
                      <Link href={w.href}>
                        <span className="t" style={{ fontSize: 15 }}>
                          {w.text}
                        </span>
                        <span className={`pill ${w.pill.tone} num`}>{w.pill.text}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="sec" style={{ margin: "8px 0 0", fontSize: 15 }}>
                  Nothing outstanding. Requests you send and follow-ups you log appear here until they are answered.
                </p>
              )}
            </article>
            <article className="card cardpad" style={{ padding: "24px 32px", display: "flex", flexDirection: "column", gap: 8 }}>
              <h2 className="h" style={{ fontSize: 18 }}>
                Open Questions
              </h2>
              {o.questions.length ? (
                <ul className="list top">
                  {o.questions.map((q) => (
                    <li key={q.text}>
                      <span className="dot" style={{ background: DOT[q.tone] }} aria-hidden="true" />
                      <span className="t" style={{ fontSize: 15 }}>
                        {q.text}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="sec" style={{ margin: "8px 0 0", fontSize: 15 }}>
                  No contradictions, unreadable references or undecided splits in the records.
                </p>
              )}
            </article>
            <article className="card cardpad" style={{ padding: "24px 32px", display: "flex", flexDirection: "column", gap: 8 }}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <h2 className="h" style={{ fontSize: 18 }}>
                  Case File
                </h2>
                <Link className="more" href={`${b}/intake`}>
                  Open in intake
                </Link>
              </div>
              {o.files.length ? (
                <ul className="list docs">
                  {o.files.map((f) => (
                    <li key={f.name}>
                      <span className="t">
                        {f.name}
                        <span className="s">{f.sub}</span>
                      </span>
                      <span className={`pill ${f.pill.tone}`}>{f.pill.text}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="sec" style={{ margin: "8px 0 0", fontSize: 15 }}>
                  No documents yet. Add the FIR copy and the complainant&rsquo;s documents in intake.
                </p>
              )}
              <div className="row" style={{ justifyContent: "flex-end", marginTop: 8 }}>
                <a className="btn" href={`/api/cases/${caseId}/case-file`} download title="Every original with its hash, the ledger and the audit log, as one ZIP">
                  Download the case file
                </a>
              </div>
            </article>
          </div>
        </section>
      </div>
    </>
  );
}
