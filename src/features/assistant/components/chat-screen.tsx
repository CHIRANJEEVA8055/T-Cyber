"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { Icon } from "@/components/ui/icon";
import { C } from "@/components/design/tokens";
import { DesignModal, ModalTitle } from "@/components/design/modal";
import type { CaseAnswer, ChatAttachment, GuidanceAnswer } from "@/contracts/assistant";
import type { ChatThreadView, ChatKind } from "@/server/services/chats";
import { archiveChatAction, askChatAction, deleteChatAction, rateAnswerAction, renameChatAction, startChatAction } from "../chat-actions";

/** "2026-02-28T18:30:00.000Z" → "01 Mar 2026" (IST); anything else is shown as given. */
const istDate = (v: string) => {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric" }).format(d);
};

type Threads = { groups: { label: string; threads: { id: string; title: string; scope: string }[] }[]; archived: { id: string; title: string }[] };
type Source = { id: string; title: string; meta: string; status: string };
const SCOPES = [
  { k: "ALL", label: "All approved sources", sub: "SOPs, circulars, the Act and provider policies" },
  { k: "SOP", label: "SOPs and circulars", sub: "CFCFRMS SOP, restoration guide, UNICROSS circulars" },
  { k: "LAW", label: "Evidence law", sub: "BSA 2023, s. 63 and Schedule" },
  { k: "PROVIDER", label: "Provider policies", sub: "Platform law-enforcement policies · verify dates" },
];

function AnswerItems({ title, items, refs }: { title: string; items: CaseAnswer["established"]; refs: Map<string, CaseAnswer["references"][number]> }) {
  if (!items.length) return null;
  return (
    <div>
      <div className="lbl" style={{ marginTop: 10 }}>
        {title}
      </div>
      <ul style={{ margin: "6px 0 0", paddingLeft: 18, fontSize: 14, lineHeight: 1.6 }}>
        {items.map((i, n) => (
          <li key={n}>
            {i.text}{" "}
            {i.refs.map((r) => (
              <Link key={r} href={refs.get(r)?.href ?? "#"} className="cite" style={{ color: C.blue, fontSize: 12, marginLeft: 2 }} title={refs.get(r)?.label}>
                [{r}]
              </Link>
            ))}
          </li>
        ))}
      </ul>
    </div>
  );
}

function CaseAnswerView({ a }: { a: CaseAnswer }) {
  const refs = new Map(a.references.map((r) => [r.ref, r]));
  return (
    <>
      <AnswerItems title="Steps" items={a.steps} refs={refs} />
      <AnswerItems title={a.intent === "MODEL" ? "Facts it used" : "What the records establish"} items={a.established} refs={refs} />
      <AnswerItems title="Possible, not established" items={a.hypotheses} refs={refs} />
      <AnswerItems title="Not known" items={a.unknowns} refs={refs} />
      {a.suggestions.length ? (
        <div className="row" style={{ gap: 8, flexWrap: "wrap", marginTop: 10 }}>
          {a.suggestions.map((s) => (
            <Link key={s.href} className="btn sm" href={s.href}>
              {s.label}
            </Link>
          ))}
        </div>
      ) : null}
    </>
  );
}

function GuidanceAnswerView({ a }: { a: GuidanceAnswer }) {
  const extracts = a.extracts ?? [];
  const links = a.connections ?? [];
  return (
    <>
      {links.length ? (
        <div style={{ marginTop: 10 }}>
          <div className="lbl">Written in more than one of them</div>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18, fontSize: 14, lineHeight: 1.6 }}>
            {links.map((c, i) => (
              <li key={i} style={{ overflowWrap: "anywhere" }}>
                {c.value} <span className="mut">· {c.in.map((x) => x.label).join(", ")}</span>
                {c.note ? <span className="mut"> · {c.note}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {extracts.length ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}>
          {extracts.slice(0, 12).map((x) => (
            <div key={x.ref} className="inner" style={{ padding: "10px 12px", fontSize: 14 }}>
              <div style={{ fontWeight: 500 }}>
                [{x.ref}] {x.heading}
              </div>
              <div className="sec" style={{ marginTop: 4, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                {x.text.length > 700 ? `${x.text.slice(0, 700)}…` : x.text}
              </div>
            </div>
          ))}
        </div>
      ) : null}
      <GuidancePassages a={a} />
    </>
  );
}

function GuidancePassages({ a }: { a: GuidanceAnswer }) {
  return a.passages.length ? (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}>
      {a.passages.map((p) => (
        <div key={p.sectionId} className="inner" style={{ padding: "10px 12px", fontSize: 14 }}>
          <div className="row" style={{ justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontWeight: 500 }}>
              {p.documentTitle} · {p.sectionRef} {p.heading}
            </span>
            <span className={`pill ${p.status === "CURRENT" ? "ok" : "wait"}`}>{p.status === "CURRENT" ? "Current" : "Superseded"}</span>
          </div>
          <div className="sec" style={{ marginTop: 4 }}>
            {p.text}
          </div>
          <div className="mut" style={{ fontSize: 12, marginTop: 4 }}>
            {p.issuingBody} · {p.version} · effective {istDate(p.effectiveFrom)}
          </div>
        </div>
      ))}
    </div>
  ) : null;
}

/** A saved conversation with the procedure assistant (station) or the case assistant (one case). */
export function ChatScreen({ kind, caseId, refLabel, threads, thread, sources, suggestions }: { kind: ChatKind; caseId: string | null; refLabel?: string; threads: Threads; thread: ChatThreadView | null; sources: Source[]; suggestions: string[] }) {
  const router = useRouter();
  const base = kind === "CASE" ? `/cases/${caseId}/assistant` : "/assistant";
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState("");
  const [scope, setScope] = useState<string>(thread?.scope ?? "ALL");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [menu, setMenu] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const [confirmDel, setConfirmDel] = useState<{ id: string; title: string } | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  // The chats list can be put away entirely (only the button to bring it back stays); remembered in this browser.
  const sideKey = `tc.chats.side.${kind}`;
  const [side, setSide] = useState(true);
  useEffect(() => {
    try {
      // A per-browser preference, read once the page is in the browser.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (localStorage.getItem(sideKey) === "hidden") setSide(false);
    } catch {
      /* storage unavailable: the list stays shown */
    }
  }, [sideKey]);
  const showSide = (v: boolean) => {
    setSide(v);
    try {
      localStorage.setItem(sideKey, v ? "shown" : "hidden");
    } catch {
      /* not remembered */
    }
  };
  // Files attached to the next question (the case assistant reads them with the case).
  const [files, setFiles] = useState<(ChatAttachment | { kind: "UPLOADING"; id: string; label: string })[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const MAX_FILES = 7;
  const addFiles = async (list: File[]) => {
    setError(null);
    const room = MAX_FILES - files.length;
    if (list.length > room) setError(room > 0 ? `Only ${room} more ${room === 1 ? "file fits" : "files fit"} with this question (up to ${MAX_FILES}).` : `Up to ${MAX_FILES} files can go with one question.`);
    for (const f of list.slice(0, Math.max(0, room))) {
      const temp = { kind: "UPLOADING" as const, id: `up-${f.name}-${f.size}-${Math.random().toString(36).slice(2)}`, label: f.name };
      setFiles((x) => [...x, temp]);
      const body = new FormData();
      body.set("file", f);
      try {
        const res = await fetch("/api/assistant/uploads", { method: "POST", body });
        const r = (await res.json().catch(() => ({ ok: false, error: "The server did not answer properly. Try again." }))) as { ok: true; data: ChatAttachment } | { ok: false; error: string };
        if (!r.ok) {
          setError(`${f.name}: ${r.error}`);
          setFiles((x) => x.filter((y) => y.id !== temp.id));
        } else setFiles((x) => x.map((y) => (y.id === temp.id ? r.data : y)));
      } catch {
        setError(`${f.name} could not be attached. Try again.`);
        setFiles((x) => x.filter((y) => y.id !== temp.id));
      }
    }
  };
  const readyFiles = files.filter((x): x is ChatAttachment => x.kind !== "UPLOADING");
  const uploading = files.some((x) => x.kind === "UPLOADING");
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (thread?.messages.length) endRef.current?.scrollIntoView({ block: "end" });
  }, [thread?.messages.length]);

  const ask = (question: string) =>
    start(async () => {
      setError(null);
      const text = question.trim();
      if (text.length < 3) return setError("Type a question of at least 3 characters.");
      let id = thread?.id;
      if (!id || thread?.archived) {
        const r = await startChatAction(kind, caseId, scope);
        if (!r.ok) return setError(r.error);
        id = r.data.id;
      }
      if (uploading) return setError("Wait for the files to finish attaching.");
      const r = await askChatAction(id, text, scope, readyFiles.length ? readyFiles.map((f) => ({ kind: f.kind, id: f.id })) : null);
      if (!r.ok) return setError(r.error);
      setQ("");
      setFiles([]);
      if (id !== thread?.id) router.push(`${base}?t=${id}`);
      else router.refresh();
    });
  const act = (fn: () => Promise<{ ok: true } | { ok: false; error: string }>, after?: () => void) =>
    start(async () => {
      const r = await fn();
      if (!r.ok) setError(r.error);
      else {
        after?.();
        router.refresh();
      }
    });
  const match = (t: string) => !filter.trim() || t.toLowerCase().includes(filter.trim().toLowerCase());
  const scopeInfo = SCOPES.find((s) => s.k === scope)!;

  return (
    <div className={`chatlayout${side ? "" : " noside"}`} style={{ display: "grid", gridTemplateColumns: side ? "minmax(0, 280px) minmax(0, 1fr)" : "minmax(0, 1fr)", gap: 0, minHeight: "calc(100vh - 160px)" }}>
      {side ? (
      <aside aria-label="Conversations" style={{ borderRight: `1px solid ${C.line}`, padding: 16, display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
        <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
          <span className="lbl">Chats</span>
          <span className="row" style={{ gap: 6 }}>
            <Link className="btn sm" href={base}>
              <Icon name="plus" size={14} /> New chat
            </Link>
            <button className="iconbtn" type="button" aria-label="Hide the chats list" title="Hide the chats list" onClick={() => showSide(false)} style={{ width: 32, height: 32 }}>
              <Icon name="sidebar" size={16} />
            </button>
          </span>
        </div>
        <label className="srt" htmlFor="chat-filter">
          Search chats
        </label>
        <input id="chat-filter" className="input" placeholder="Search chats" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ minHeight: 36 }} />
        <nav aria-label="Saved conversations" style={{ display: "flex", flexDirection: "column", gap: 2, overflowY: "auto" }}>
          {threads.groups.map((g) => {
            const ts = g.threads.filter((t) => match(t.title));
            return ts.length ? (
              <div key={g.label}>
                <div className="mut" style={{ fontSize: 12, padding: "8px 8px 4px" }}>
                  {g.label}
                </div>
                {ts.map((t) => (
                  <div key={t.id} className="row" style={{ gap: 4, position: "relative" }}>
                    {renaming?.id === t.id ? (
                      <input
                        className="input"
                        autoFocus
                        aria-label="Conversation name"
                        value={renaming.title}
                        onChange={(e) => setRenaming({ id: t.id, title: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") act(() => renameChatAction(t.id, renaming.title), () => setRenaming(null));
                          if (e.key === "Escape") setRenaming(null);
                        }}
                        onBlur={() => setRenaming(null)}
                        style={{ minHeight: 34, flex: 1 }}
                      />
                    ) : (
                      <Link className={`citem${thread?.id === t.id ? " on" : ""}`} href={`${base}?t=${t.id}`} aria-current={thread?.id === t.id ? "page" : undefined} style={{ flex: 1, minWidth: 0, padding: "8px 10px", borderRadius: 8, fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "inherit" }}>
                        {t.title}
                      </Link>
                    )}
                    <button className="iconbtn" type="button" aria-label={`More for ${t.title}`} aria-expanded={menu === t.id} onClick={() => setMenu(menu === t.id ? null : t.id)} style={{ width: 32, height: 32 }}>
                      <Icon name="dots" size={16} />
                    </button>
                    {menu === t.id ? (
                      <div role="menu" className="card" style={{ position: "absolute", right: 0, top: 36, zIndex: 20, padding: 4, display: "flex", flexDirection: "column", minWidth: 150 }}>
                        <button role="menuitem" className="btn sm" type="button" style={{ justifyContent: "flex-start", border: 0 }} onClick={() => { setMenu(null); setRenaming({ id: t.id, title: t.title }); }}>
                          Rename
                        </button>
                        <a role="menuitem" className="btn sm" href={`/api/chats/${t.id}/export`} download style={{ justifyContent: "flex-start", border: 0 }} onClick={() => setMenu(null)}>
                          Export
                        </a>
                        <button role="menuitem" className="btn sm" type="button" style={{ justifyContent: "flex-start", border: 0 }} onClick={() => { setMenu(null); act(() => archiveChatAction(t.id, true), () => thread?.id === t.id && router.push(base)); }}>
                          Archive
                        </button>
                        <button role="menuitem" className="btn sm" type="button" style={{ justifyContent: "flex-start", border: 0, color: C.red }} onClick={() => { setMenu(null); setConfirmDel({ id: t.id, title: t.title }); }}>
                          Delete
                        </button>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null;
          })}
          {!threads.groups.length ? (
            <p className="mut" style={{ fontSize: 13, padding: 8, margin: 0 }}>
              No saved chats yet. Ask a question and it is kept here.
            </p>
          ) : filter && !threads.groups.some((g) => g.threads.some((t) => match(t.title))) ? (
            <p className="mut" style={{ fontSize: 13, padding: 8, margin: 0 }}>
              No chats match “{filter}”.{" "}
              <button className="btn sm" type="button" onClick={() => setFilter("")}>
                Clear search
              </button>
            </p>
          ) : null}
        </nav>
        {threads.archived.length ? (
          <div style={{ marginTop: "auto" }}>
            <button className="btn sm" type="button" aria-expanded={showArchived} onClick={() => setShowArchived(!showArchived)}>
              {showArchived ? "Hide" : "Show"} {threads.archived.length} archived
            </button>
            {showArchived
              ? threads.archived.map((t) => (
                  <div key={t.id} className="row" style={{ justifyContent: "space-between", gap: 6, padding: "6px 4px", fontSize: 13 }}>
                    <span className="mut" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {t.title}
                    </span>
                    <button className="btn sm" type="button" onClick={() => act(() => archiveChatAction(t.id, false))}>
                      Restore
                    </button>
                  </div>
                ))
              : null}
          </div>
        ) : null}
      </aside>
      ) : null}

      <section aria-label="Conversation" style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
        <div className="casehead" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12, padding: "16px 24px" }}>
          {!side ? (
            <button className="iconbtn" type="button" aria-label="Show the chats list" title="Show the chats list" onClick={() => showSide(true)} style={{ width: 36, height: 36, alignSelf: "flex-start" }}>
              <Icon name="sidebar" size={16} />
            </button>
          ) : null}
          <div style={{ flex: "1 1 280px", minWidth: 0 }}>
            {refLabel ? (
              <div className="mut" style={{ fontSize: 13 }}>
                <Link href={`/cases/${caseId}`}>{refLabel}</Link> / Case Assistant
              </div>
            ) : null}
            <h1 className="h" style={{ fontSize: 22 }}>
              {thread?.title ?? (kind === "CASE" ? "Case Assistant" : "Procedure Assistant")}
            </h1>
            <p className="sec" style={{ margin: "4px 0 0", fontSize: 14 }}>
              {kind === "CASE" ? "Ask anything about This Case" : "Answers from the station’s approved sources only, each with its section and status."}
            </p>
          </div>
          {kind === "PROCEDURE" ? (
            <label className="fld" style={{ minWidth: 220 }}>
              <span className="lbl">Answer from</span>
              <select className="input" value={scope} onChange={(e) => setScope(e.target.value)} style={{ minHeight: 36 }}>
                {SCOPES.map((s) => (
                  <option key={s.k} value={s.k}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
        <div className="stack-narrow" style={{ display: "grid", gridTemplateColumns: kind === "PROCEDURE" ? "minmax(0, 1fr) minmax(0, 300px)" : "minmax(0, 1fr)", gap: 24, padding: "20px 24px", flex: 1, alignItems: "stretch" }}>
          <div className={`chatcol${thread?.messages.length ? "" : " empty"}`} style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0, maxWidth: 880, width: "100%", margin: "0 auto" }}>
            {thread?.messages.length ? (
              thread.messages.map((m) =>
                m.role === "USER" ? (
                  <div key={m.id} style={{ alignSelf: "flex-end", maxWidth: "80%", background: "var(--c-tint-blue)", borderRadius: 12, padding: "10px 14px", fontSize: 15 }}>
                    {m.text}
                    {m.attachments.length ? (
                      <span style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
                        {m.attachments.map((a) => (
                          <span key={a.id} className="pill neutral" style={{ maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis" }}>
                            <Icon name="paperclip" size={12} /> {a.label}
                          </span>
                        ))}
                      </span>
                    ) : null}
                  </div>
                ) : (
                  <article key={m.id} className="card" style={{ padding: "16px 20px" }}>
                    <div className="row" style={{ justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                      <span className={`pill ${m.answer?.provider.id === "LOCAL_MODEL" ? "wait" : "info"}`}>{m.answer?.provider.label ?? "Answer"}</span>
                      <span className="row" style={{ gap: 4 }}>
                        <button className={`iconbtn${m.feedback === "UP" ? " on" : ""}`} type="button" aria-label="Helpful" aria-pressed={m.feedback === "UP"} onClick={() => act(() => rateAnswerAction(m.id, m.feedback === "UP" ? null : "UP"))} style={{ width: 32, height: 32 }}>
                          <Icon name="thumbsUp" size={14} />
                        </button>
                        <button className={`iconbtn${m.feedback === "DOWN" ? " on" : ""}`} type="button" aria-label="Not helpful" aria-pressed={m.feedback === "DOWN"} onClick={() => act(() => rateAnswerAction(m.id, m.feedback === "DOWN" ? null : "DOWN"))} style={{ width: 32, height: 32 }}>
                          <Icon name="thumbsDown" size={14} />
                        </button>
                      </span>
                    </div>
                    <p style={{ margin: "10px 0 0", fontSize: 15, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{m.text}</p>
                    {m.answer && "passages" in m.answer ? <GuidanceAnswerView a={m.answer} /> : m.answer ? <CaseAnswerView a={m.answer as CaseAnswer} /> : null}
                    {m.answer ? (
                      <p className="mut" style={{ margin: "10px 0 0", fontSize: 12 }}>
                        {m.answer.provider.disclosure}
                      </p>
                    ) : null}
                  </article>
                ),
              )
            ) : kind === "CASE" ? null : (
              <div className="card" style={{ padding: 24 }}>
                <h2 className="h" style={{ fontSize: 17 }}>
                  Ask About Procedure
                </h2>
                <p className="sec" style={{ margin: "6px 0 12px", fontSize: 14 }}>
                  {`Answers come from ${scopeInfo.label.toLowerCase()}: ${scopeInfo.sub}.`}
                </p>
                <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                  {suggestions.map((s) => (
                    <button key={s} className="btn sm" type="button" onClick={() => ask(s)} disabled={pending}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {thread?.archived ? (
              <div className="banner warn" role="status">
                <Icon name="alert" />
                <div>This conversation is archived. Restore it from the list to continue, or ask below to start a new one.</div>
              </div>
            ) : null}
            {error ? (
              <div className="banner warn" role="alert">
                <Icon name="alert" />
                <div>{error}</div>
              </div>
            ) : null}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                ask(q);
              }}
              className="card chatform"
              style={{ padding: 12, display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-end", position: "sticky", bottom: 12 }}
            >
              {files.length ? (
                <div style={{ flexBasis: "100%", display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {files.map((f) => (
                    <span key={f.id} className="pill neutral" style={{ maxWidth: 280, display: "inline-flex", alignItems: "center", gap: 6 }}>
                      <Icon name={f.kind === "UPLOADING" ? "spinner" : "paperclip"} size={12} />
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.kind === "UPLOADING" ? `Attaching ${f.label}…` : f.label}</span>
                      {f.kind !== "UPLOADING" ? (
                        <button type="button" aria-label={`Remove ${f.label}`} onClick={() => setFiles((x) => x.filter((y) => y.id !== f.id))} style={{ border: 0, background: "none", color: "inherit", cursor: "pointer", padding: 0, display: "inline-flex" }}>
                          <Icon name="x" size={12} />
                        </button>
                      ) : null}
                    </span>
                  ))}
                </div>
              ) : null}
              {kind === "CASE" ? (
                <>
                  <button className="iconbtn" type="button" aria-label="Attach files to the question" title="Attach files (statements, call records, letters, screenshots): read with this case" onClick={() => fileRef.current?.click()} style={{ width: 44, height: 44 }}>
                    <Icon name="paperclip" size={18} />
                  </button>
                  <input
                    ref={fileRef}
                    type="file"
                    multiple
                    hidden
                    accept=".pdf,.docx,.txt,.md,.eml,.csv,.xlsx,.png,.jpg,.jpeg"
                    onChange={(e) => {
                      const list = [...(e.target.files ?? [])];
                      e.target.value = "";
                      if (list.length) void addFiles(list);
                    }}
                  />
                </>
              ) : null}
              <label className="srt" htmlFor="chat-q">
                Your question
              </label>
              <textarea
                id="chat-q"
                className="input"
                rows={2}
                value={q}
                placeholder={kind === "CASE" ? (readyFiles.length ? "What in these files bears on this case?" : "Ask anything about this case") : "What does a CDR request need?"}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    ask(q);
                  }
                }}
                style={{ padding: 10, flex: "1 1 240px", resize: "vertical", minHeight: 48 }}
                maxLength={500}
              />
              <button className="btn primary" type="submit" aria-busy={pending} disabled={uploading}>
                {pending ? "Answering…" : "Ask"}
              </button>
            </form>
            <div ref={endRef} />
          </div>
          {kind === "PROCEDURE" ? (
            <aside aria-label="Approved sources" className="card" style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 8 }}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <span className="lbl">Approved sources</span>
                <span className="mut" style={{ fontSize: 12 }}>
                  {sources.filter((s) => s.status === "CURRENT").length} current · {sources.filter((s) => s.status !== "CURRENT").length} superseded
                </span>
              </div>
              {sources.map((s) => (
                <div key={s.id} style={{ fontSize: 13, padding: "6px 0", borderTop: `1px solid ${C.lineSoft}` }}>
                  <div className="row" style={{ justifyContent: "space-between", gap: 6 }}>
                    <span style={{ fontWeight: 500 }}>{s.title}</span>
                    <span className={`pill ${s.status === "CURRENT" ? "ok" : "wait"}`}>{s.status === "CURRENT" ? "Current" : "Superseded"}</span>
                  </div>
                  <span className="mut">{s.meta}</span>
                </div>
              ))}
              <p className="mut" style={{ fontSize: 12, margin: 0 }}>
                Answers never draw on anything outside these. Superseded documents are labelled when cited. Illustrative library for the demonstration.
              </p>
            </aside>
          ) : null}
        </div>
      </section>

      <DesignModal open={!!confirmDel} onClose={() => setConfirmDel(null)} scope={kind === "CASE" ? "scr-case-assistant" : "scr-procedure-assistant"} maxWidth={460}>
        {confirmDel ? (
          <>
            <div className="mhead">
              <ModalTitle style={{ fontSize: 18 }}>Delete “{confirmDel.title}”?</ModalTitle>
              <p className="sec" style={{ margin: 0, fontSize: 14 }}>
                The conversation is removed for good. The questions stay in the audit log, as every question is recorded when asked.
              </p>
            </div>
            <div className="mfoot">
              <button className="btn" type="button" autoFocus onClick={() => setConfirmDel(null)}>
                Cancel
              </button>
              <button
                className="btn primary"
                type="button"
                style={{ background: "#b91c1c" }}
                onClick={() => {
                  const id = confirmDel.id;
                  setConfirmDel(null);
                  act(() => deleteChatAction(id), () => thread?.id === id && router.push(base));
                }}
              >
                Delete conversation
              </button>
            </div>
          </>
        ) : null}
      </DesignModal>
    </div>
  );
}
