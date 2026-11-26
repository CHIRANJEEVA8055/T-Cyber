"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { Icon } from "@/components/ui/icon";
import { C } from "@/components/design/tokens";
import { DesignModal, ModalTitle } from "@/components/design/modal";
import { copyText } from "@/lib/browser";
import type { CaseContextView } from "@/server/services/case-context";
import { loadCaseContextAction } from "../actions";

const TONE: Record<string, string> = { COMPLETE_RESPONSE: "ok", PARTIAL_RESPONSE: "wait", ACKNOWLEDGED: "wait", SUBMITTED: "wait", REJECTED: "gap", SUBMISSION_FAILED: "gap" };

function Section({ title, children, count }: { title: string; children: React.ReactNode; count?: number }) {
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <h3 className="lbl" style={{ margin: 0 }}>
        {title}
        {count !== undefined ? <span className="num mut" style={{ marginLeft: 6 }}>{count}</span> : null}
      </h3>
      {children}
    </section>
  );
}

/**
 * The case's context in one window: what the FIR states, the money trail by level, who is on which side, every mail
 * with what came back to it and what is still awaited, replies not yet linked, what is pending, the files, and the
 * open next actions. It is what the local model reads when it links a reply or answers a question about the case.
 */
export function CaseContextButton({ caseId, caseRef }: { caseId: string; caseRef: string }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<CaseContextView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, start] = useTransition();
  const load = () =>
    start(async () => {
      setError(null);
      const r = await loadCaseContextAction(caseId);
      if (!r.ok) setError(r.error);
      else setData(r.data);
    });
  const download = () => {
    if (!data) return;
    const url = URL.createObjectURL(new Blob([data.text], { type: "text/plain;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${data.ref.replace(/[^\w]+/g, "_")}_case_context.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <>
      <button
        className="btn"
        type="button"
        aria-haspopup="dialog"
        title="Everything the case holds in one place: facts, money trail, mails sent and replies, what is pending"
        onClick={() => {
          setOpen(true);
          load();
        }}
      >
        <Icon name="book" size={16} /> Case context
      </button>
      <DesignModal open={open} onClose={() => setOpen(false)} scope="scr-main" maxWidth={980} title="Case context">
        <div style={{ padding: "24px 68px 20px 28px", display: "flex", flexDirection: "column", gap: 8, borderBottom: `1px solid ${C.line}` }}>
          <span className="lbl">{caseRef} · case context</span>
          <ModalTitle style={{ fontSize: 20 }}>Everything the Case Holds, in One Place</ModalTitle>
          <p className="sec" style={{ margin: 0, fontSize: 14 }}>
            Built from the records as they are now{data ? `, ${new Date(data.asOf).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false })}` : ""}. The local model reads this when it links a reply to its request or answers a question about the case.
          </p>
        </div>
        <div style={{ padding: "20px 28px", display: "flex", flexDirection: "column", gap: 24, overflowWrap: "anywhere", minWidth: 0 }}>
          {error ? (
            <div role="alert" style={{ display: "flex", gap: 10, padding: 12, borderRadius: 10, background: "var(--c-tint-amber)", fontSize: 14 }}>
              <Icon name="alert" />
              <div>
                {error}{" "}
                <button className="btn sm" type="button" onClick={load}>
                  Try again
                </button>
              </div>
            </div>
          ) : null}
          {!data && !error ? (
            <div aria-busy="true" aria-label="Loading the case context" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {[60, 120, 200].map((h, i) => (
                <div key={i} style={{ height: h, borderRadius: 10, background: "var(--c-raise)" }} />
              ))}
            </div>
          ) : null}
          {data ? (
            <>
              <Section title="The Case">
                <dl className="ctx-kv">
                  {data.facts.map((f) => (
                    <div key={f.label} style={{ display: "contents" }}>
                      <dt>{f.label}</dt>
                      <dd style={{ margin: 0, minWidth: 0, overflowWrap: "anywhere" }}>{f.value}</dd>
                    </div>
                  ))}
                </dl>
              </Section>

              <Section title="Money Trail" count={data.trail.reduce((s, l) => s + l.rows.length, 0)}>
                {data.trail.length ? (
                  data.trail.map((l) => (
                    <div key={l.level} className="ctx-card" style={{ padding: "12px 16px" }}>
                      <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 6 }}>Level {l.level}{l.level === 1 ? " · paid by the victim directly" : ""}</div>
                      {l.rows.map((r, i) => (
                        <div key={`${i}-${r.name}`} style={{ fontSize: 14, padding: "4px 0" }}>
                          {r.name} <span className="mut">got {r.got} from {r.from}; {r.onward}</span>
                          {r.hold ? <span className="pill ok" style={{ marginLeft: 8 }}>{r.hold}</span> : null}
                        </div>
                      ))}
                    </div>
                  ))
                ) : (
                  <p className="mut" style={{ margin: 0, fontSize: 14 }}>No payment or transfer recorded yet.</p>
                )}
              </Section>

              <Section title="Who Is on Which Side">
                <div className="stack-narrow" style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12 }}>
                  {(
                    [
                      ["Accused’s side", data.sides.accused],
                      ["Victim’s side", data.sides.victim],
                    ] as const
                  ).map(([t, list]) => (
                    <div key={t} className="ctx-card" style={{ padding: "12px 16px" }}>
                      <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 6 }}>{t}</div>
                      {list.length ? list.map((x, i) => <div key={`${i}-${x}`} style={{ fontSize: 13, padding: "3px 0", overflowWrap: "anywhere" }}>{x}</div>) : <div className="mut" style={{ fontSize: 13 }}>None recorded.</div>}
                    </div>
                  ))}
                </div>
                {data.sides.other.length ? <p className="mut" style={{ margin: 0, fontSize: 13 }}>Not placed yet: {data.sides.other.join("; ")}</p> : null}
              </Section>

              <Section title="Mails Sent, and What Came Back" count={data.mails.length}>
                {data.mails.length ? (
                  data.mails.map((m) => (
                    <details key={m.id} className="ctx-card" style={{ padding: "12px 16px", minWidth: 0, overflowWrap: "anywhere" }}>
                      <summary style={{ cursor: "pointer", listStyle: "revert" }}>
                        <span style={{ fontWeight: 600, fontSize: 14 }}>{m.label}</span> <span className="mut" style={{ fontSize: 13, overflowWrap: "anywhere" }}>to {m.to}</span>{" "}
                        <span className={`pill ${TONE[m.status] ?? "neutral"}`} style={{ marginLeft: 6 }}>{m.statusText}</span>
                        {m.overdue ? <span className="pill gap" style={{ marginLeft: 6 }}>follow-up was due {m.followUp}</span> : null}
                        <div className="mut" style={{ fontSize: 13, marginTop: 4, overflowWrap: "anywhere" }}>
                          {m.subject}
                          {m.sent ? ` · sent ${m.sent}` : ""}
                          {m.replies.length ? ` · ${m.replies.length} ${m.replies.length === 1 ? "reply" : "replies"}` : ""}
                        </div>
                      </summary>
                      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 12, fontSize: 14 }}>
                        {m.why ? <div><span className="mut">Why: </span>{m.why}</div> : null}
                        {m.asks.length ? (
                          <div>
                            <div className="mut" style={{ fontSize: 13 }}>Asked for</div>
                            {m.asks.map((a, i) => (
                              <div key={`${i}-${a.label}`} style={{ padding: "2px 0" }}>
                                · {a.label} <span className={a.state === "received" ? "" : "mut"} style={{ color: a.state === "received" ? C.teal : undefined }}>({a.state})</span>
                              </div>
                            ))}
                          </div>
                        ) : null}
                        {m.replies.map((r) => (
                          <div key={r.id} className="mw-box">
                            <div>
                              Reply from {r.from}, {r.received} <span className="mut">· {r.kind}{r.files ? ` · ${r.files} file${r.files === 1 ? "" : "s"}` : ""} · {r.reviewed ? "reviewed" : "not reviewed yet"}</span>{" "}
                              <Link href={`/cases/${data.caseId}/responses/${r.id}`} style={{ color: C.blue }}>
                                Open
                              </Link>
                            </div>
                            {r.findings.map((f, i) => (
                              <div key={`${i}-${f}`} className="mut" style={{ fontSize: 13, paddingTop: 2 }}>
                                · {f}
                              </div>
                            ))}
                          </div>
                        ))}
                        {m.reminders.map((k, i) => <div key={`${i}-${k}`} className="mut" style={{ fontSize: 13 }}>Reminder {k}</div>)}
                        <details>
                          <summary style={{ cursor: "pointer", fontSize: 13, color: C.blue }}>The mail as written</summary>
                          <div className="mw-letter" style={{ marginTop: 8 }}>{m.body}</div>
                        </details>
                        <Link href={`/cases/${data.caseId}/requests/${m.id}`} style={{ color: C.blue, fontSize: 13 }}>
                          Open in Requests
                        </Link>
                      </div>
                    </details>
                  ))
                ) : (
                  <p className="mut" style={{ margin: 0, fontSize: 14 }}>No mail yet.</p>
                )}
              </Section>

              {data.unlinked.length ? (
                <Section title="Replies Not Linked Yet" count={data.unlinked.length}>
                  {data.unlinked.map((u, i) => (
                    <div key={`${i}-${u.from}`} style={{ fontSize: 14 }}>
                      {u.from}, {u.received}: {u.subject} <span className="mut">· {u.where}</span>
                    </div>
                  ))}
                </Section>
              ) : null}

              <Section title="Pending" count={data.pending.length}>
                {data.pending.length ? (
                  <ul style={{ margin: 0, paddingLeft: 20, fontSize: 14, lineHeight: 1.6 }}>
                    {data.pending.map((p, i) => (
                      <li key={`${i}-${p}`}>{p}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="mut" style={{ margin: 0, fontSize: 14 }}>Nothing pending.</p>
                )}
              </Section>

              <Section title="Files in the Case" count={data.files.length}>
                {data.files.length ? (
                  data.files.map((f, i) => (
                    <div key={`${i}-${f.title}`} style={{ fontSize: 14 }}>
                      {f.title} <span className="mut">· {f.what} · {f.when}</span>
                    </div>
                  ))
                ) : (
                  <p className="mut" style={{ margin: 0, fontSize: 14 }}>None.</p>
                )}
              </Section>

              <Section title="Open Next Actions" count={data.next.length}>
                {data.next.length ? (
                  <ol style={{ margin: 0, paddingLeft: 20, fontSize: 14, lineHeight: 1.6 }}>
                    {data.next.map((n, i) => (
                      <li key={`${i}-${n}`}>{n}</li>
                    ))}
                  </ol>
                ) : (
                  <p className="mut" style={{ margin: 0, fontSize: 14 }}>None open.</p>
                )}
              </Section>
            </>
          ) : null}
        </div>
        <div style={{ position: "sticky", bottom: 0, background: C.card, padding: "16px 28px", display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "flex-end", borderTop: `1px solid ${C.line}` }}>
          <button className="btn" type="button" onClick={load} aria-busy={pending} disabled={pending}>
            <Icon name="retry" size={14} /> {pending ? "Refreshing…" : "Refresh"}
          </button>
          <button className="btn" type="button" disabled={!data} onClick={async () => data && setCopied(await copyText(data.text))}>
            <Icon name={copied ? "check" : "copy"} size={14} /> {copied ? "Copied" : "Copy all"}
          </button>
          <button className="btn primary" type="button" disabled={!data} onClick={download}>
            <Icon name="download" size={14} /> Download (.txt)
          </button>
        </div>
      </DesignModal>
    </>
  );
}
