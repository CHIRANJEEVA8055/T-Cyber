"use client";

import Link from "next/link";
import { Markdown } from "./markdown";
import { useRouter } from "next/navigation";
import { Fragment, useEffect, useMemo, useRef, useState, useSyncExternalStore, useTransition, type ReactNode } from "react";
import { Icon } from "@/components/ui/icon";
import { C } from "@/components/design/tokens";
import { DesignModal } from "@/components/design/modal";
import type { AnswerTask, CaseAnswer, ChatAttachment, GuidanceAnswer } from "@/contracts/assistant";
import type { Passage } from "@/domain/guidance";
import type { ChatThreadView } from "@/server/services/chats";
import type { Attachables } from "@/server/services/procedure-assistant";
import type { KnowledgeDocumentView } from "@/server/services/knowledge-admin";
import { archiveChatAction, askChatAction, deleteChatAction, listAttachablesAction, prepareDraftFromChatAction, rateAnswerAction, renameChatAction, retryChatAction, searchChatsAction, sourceDocumentAction, startChatAction } from "../chat-actions";
import { copyText, newId } from "@/lib/browser";

/**
 * The procedure assistant (design: Dashboard artboard, Procedure assistant tab). Chats on the left; the scope
 * ("Answer from") and the approved sources at the top; the thread; and the composer, which can attach a file from this
 * computer, a station mail or a whole FIR case. Every answer names its sources; nothing here sends anything.
 */

export type PaDoc = { id: string; title: string; docNumber: string; issuingBody: string; version: string; effectiveFrom: string; status: string; category: string; reviewNote: string | null; jurisdiction: string };
type Threads = { groups: { label: string; threads: { id: string; title: string; scope: string }[] }[]; archived: { id: string; title: string }[] };
type Template = { id: string; title: string; question: string; sourceLabel: string };
type Uploading = { kind: "UPLOADING"; id: string; label: string };
const MAX_ATTACH = 8;

const SCOPES = [
  { k: "ALL", label: "All approved sources", sub: "Everything in the knowledge base", match: () => true },
  { k: "SOP", label: "SOPs, circulars and guides", sub: "Station SOPs, circulars, how-to guides and training", match: (d: PaDoc) => ["SOP", "CIRCULAR", "OTHER"].includes(d.category) },
  { k: "LAW", label: "Law", sub: "Acts and their sections", match: (d: PaDoc) => d.category === "LAW" },
  { k: "PROVIDER", label: "Provider and platform guides", sub: "How to read and request platform and provider records", match: (d: PaDoc) => d.category === "PROVIDER" },
] as const;
type ScopeKey = (typeof SCOPES)[number]["k"];

const istDate = (v: string) => {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric" }).format(d);
};
/** A per-browser preference (chat list collapsed, last scope). Read after hydration; a private window just forgets. */
const STORE_EVENT = "tc.pa.store";
function readStore(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function writeStore(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* private window: the choice is simply not remembered */
  }
  window.dispatchEvent(new Event(STORE_EVENT));
}
function useStored(k: string): string | null {
  return useSyncExternalStore(
    (cb) => {
      window.addEventListener(STORE_EVENT, cb);
      window.addEventListener("storage", cb);
      return () => {
        window.removeEventListener(STORE_EVENT, cb);
        window.removeEventListener("storage", cb);
      };
    },
    () => readStore(k),
    () => null,
  );
}
const shortDoc = (p: { documentTitle: string; docNumber: string }) => (p.docNumber && p.docNumber !== "—" && p.docNumber.length <= 18 ? p.docNumber : p.documentTitle.length > 34 ? `${p.documentTitle.slice(0, 32)}…` : p.documentTitle);
const paras = (t: string) => t.split(/\n{2,}/).filter((x) => x.trim());

/** Cite chips for [S2] / [D1] / [M3] markers the local model writes. */
function withCites(text: string, cite: (n: string) => ReactNode): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(/\[([SDMFCK]\d+)\]/g)) {
    out.push(text.slice(last, m.index));
    out.push(<Fragment key={`${m.index}`}>{cite(m[1]!)}</Fragment>);
    last = m.index! + m[0].length;
  }
  out.push(text.slice(last));
  return out;
}

export function ProcedureAssistant({ threads, thread, docs, templates, viewer, canUseCases, initialQuestion }: { threads: Threads; thread: ChatThreadView | null; docs: PaDoc[]; templates: Template[]; viewer: { initials: string }; canUseCases: boolean; initialQuestion?: string | null }) {
  const router = useRouter();
  const [pending, start] = useTransition();

  // ── Chats list ──────────────────────────────────────────────────────────────────────────────────────────────
  const csOpen = useStored("tc.pa.cs") !== "min";
  const [drawer, setDrawer] = useState(false);
  const toggleCs = () => writeStore("tc.pa.cs", csOpen ? "min" : "open");
  const [q, setQ] = useState("");
  const [found, setFound] = useState<Threads | null>(null);
  const [searching, setSearching] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onSearch = (value: string) => {
    setQ(value);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    const term = value.trim();
    if (!term) {
      setFound(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    // Searches the chats' names and every question and answer in them, once typing pauses.
    searchTimer.current = setTimeout(async () => {
      const r = await searchChatsAction("PROCEDURE", null, term);
      setSearching(false);
      if (r.ok) setFound(r.data);
      else setError(r.error);
    }, 250);
  };
  const shown = found ?? threads;
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [delFor, setDelFor] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  // ── Scope, sources and the document reader ─────────────────────────────────────────────────────────────────
  // The scope is the one picked here, else the chat's own, else the last one used in this browser.
  const saved = useStored("tc.pa.scope");
  const [picked, setPicked] = useState<{ thread: string | null; k: ScopeKey } | null>(null);
  const valid = (k: string | null | undefined): k is ScopeKey => !!k && SCOPES.some((s) => s.k === k);
  const scope: ScopeKey = picked && picked.thread === (thread?.id ?? null) ? picked.k : valid(thread?.scope) ? thread.scope : valid(saved) ? saved : "ALL";
  const setScope = (k: ScopeKey) => {
    writeStore("tc.pa.scope", k);
    setPicked({ thread: thread?.id ?? null, k });
    setPop(null);
  };
  const [pop, setPop] = useState<"scope" | "src" | "plus" | null>(null);
  const scopeInfo = SCOPES.find((s) => s.k === scope)!;
  const counts = useMemo(() => Object.fromEntries(SCOPES.map((s) => [s.k, docs.filter((d) => s.match(d)).length])), [docs]);
  const current = docs.filter((d) => d.status === "CURRENT").length;
  const superseded = docs.filter((d) => d.status === "SUPERSEDED").length;
  const docById = useMemo(() => new Map(docs.map((d) => [d.id, d])), [docs]);
  const [doc, setDoc] = useState<{ id: string; section?: string; data: KnowledgeDocumentView | null; error?: string } | null>(null);
  const openDoc = (id: string, section?: string) => {
    setPop(null);
    setDoc({ id, section, data: null });
    start(async () => {
      const r = await sourceDocumentAction(id);
      setDoc((d) => (d && d.id === id ? (r.ok ? { ...d, data: r.data } : { ...d, error: r.error }) : d));
    });
  };
  useEffect(() => {
    if (doc?.data && doc.section) document.getElementById(`sec-${doc.section}`)?.scrollIntoView({ block: "start" });
  }, [doc]);

  // ── Composer and attachments ────────────────────────────────────────────────────────────────────────────────
  // A question handed over from another screen (a draft that is missing a detail) is put in the box, not sent.
  const [text, setText] = useState(initialQuestion?.slice(0, 500) ?? "");
  const [attachments, setAttachments] = useState<(ChatAttachment | Uploading)[]>([]);
  const [pick, setPick] = useState<"none" | "mail" | "case">("none");
  const [attachables, setAttachables] = useState<Attachables | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState<{ question: string; attachments: ChatAttachment[]; base: number; thread: string | null; newId?: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const plusRef = useRef<HTMLButtonElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const messages = thread?.messages ?? [];

  const loadAttachables = async () => {
    if (attachables) return;
    const r = await listAttachablesAction();
    if (r.ok) setAttachables(r.data);
    else setError(r.error);
  };

  // Several files, mails and cases can go with one question (to compare them, for example). Files are read one after
  // another on this computer; each shows while it is being read.
  const attach = (a: ChatAttachment) => {
    setError(null);
    setAttachments((xs) => {
      if (xs.some((x) => x.kind === a.kind && "id" in x && x.id === a.id)) return xs;
      if (xs.length >= MAX_ATTACH) {
        setError(`Up to ${MAX_ATTACH} attachments can go with one question.`);
        return xs;
      }
      return [...xs, a];
    });
  };
  const upload = async (files: FileList | File[]) => {
    setPop(null);
    setError(null);
    const list = Array.from(files);
    const room = MAX_ATTACH - attachments.length;
    if (list.length > room) setError(room > 0 ? `Only ${room} more ${room === 1 ? "attachment fits" : "attachments fit"} with this question (up to ${MAX_ATTACH}).` : `Up to ${MAX_ATTACH} attachments can go with one question.`);
    for (const file of list.slice(0, Math.max(0, room))) {
      const tmp: Uploading = { kind: "UPLOADING", id: newId(), label: file.name };
      setAttachments((xs) => [...xs, tmp]);
      const body = new FormData();
      body.set("file", file);
      try {
        const res = await fetch("/api/assistant/uploads", { method: "POST", body });
        const r = (await res.json().catch(() => ({ ok: false, error: "The server did not answer properly. Try again." }))) as { ok: true; data: ChatAttachment } | { ok: false; error: string };
        if (!r.ok) {
          setAttachments((xs) => xs.filter((x) => x !== tmp));
          setError(`${file.name}: ${r.error}`);
        } else setAttachments((xs) => xs.map((x) => (x === tmp ? r.data : x)));
      } catch {
        setAttachments((xs) => xs.filter((x) => x !== tmp));
        setError(`${file.name} could not be attached. Check the connection and try again.`);
      }
    }
    if (fileRef.current) fileRef.current.value = "";
    taRef.current?.focus();
  };
  const ready = attachments.filter((x): x is ChatAttachment => x.kind !== "UPLOADING");
  const uploading = attachments.some((x) => x.kind === "UPLOADING");

  // The question being answered shows until the saved answer arrives (or the chat changes).
  const inNew = !!asking?.newId && asking.newId === thread?.id;
  const waiting = asking && (inNew || asking.thread === (thread?.id ?? null)) && messages.length <= (inNew ? 0 : asking.base) ? asking : null;
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, waiting]);

  const ask = (question: string, att: ChatAttachment[] = ready) => {
    const value = question.trim();
    if (uploading) return setError("Wait for the files to finish attaching, then send.");
    if (!value) {
      setError("Type a message first.");
      taRef.current?.focus();
      return;
    }
    setError(null);
    setAsking({ question: value, attachments: att, base: thread?.archived ? 0 : messages.length, thread: thread && !thread.archived ? thread.id : null });
    setText("");
    setAttachments([]);
    start(async () => {
      let id = thread?.id;
      if (!id || thread?.archived) {
        const r = await startChatAction("PROCEDURE", null, scope);
        if (!r.ok) {
          setAsking(null);
          setText(value);
          return setError(r.error);
        }
        id = r.data.id;
      }
      const r = await askChatAction(id, value, scope, att.map((a) => ({ kind: a.kind, id: a.id })));
      if (!r.ok) {
        setAsking(null);
        setText(value);
        setAttachments(att);
        return setError(r.error);
      }
      if (id !== thread?.id) {
        setAsking((a) => (a ? { ...a, newId: id } : a));
        router.push(`/assistant?t=${id}`);
      }
    });
  };

  const act = (fn: () => Promise<{ ok: true } | { ok: false; error: string }>, after?: () => void) =>
    start(async () => {
      const r = await fn();
      if (!r.ok) setError(r.error);
      else after?.();
    });

  // Escape closes whatever is open, and focus goes back to what opened it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (pop === "plus") plusRef.current?.focus();
      setPop(null);
      setMenuFor(null);
      setDrawer(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pop]);

  const lastAi = [...messages].reverse().find((m) => m.role === "ASSISTANT")?.id;
  const one = attachments.length === 1 ? attachments[0]! : null;
  const placeholder =
    attachments.length > 1
      ? `Ask about these ${attachments.length} together, for example: what connects them?`
      : one?.kind === "CASE"
      ? `Ask about ${one.label.split(" · ")[0]}, or ask for its pending requests to be drafted`
      : one?.kind === "MAIL"
        ? "Ask about this mail, or what to do with it"
        : one?.kind === "FILE" || one?.kind === "UPLOADING"
          ? "Ask about this file, or attach more to compare them"
          : messages.length
            ? "Ask a follow-up question"
            : canUseCases
              ? "Ask a procedure or general question, or attach a file, a mail or a FIR case"
              : "Ask a procedure or general question, or attach a file";

  const chatItem = (t: { id: string; title: string }) => {
    const on = thread?.id === t.id;
    return (
      <div key={t.id}>
        <div className={`citem${on ? " on" : ""}`}>
          {renaming?.id === t.id ? (
            <input
              className="ct"
              autoFocus
              aria-label="Conversation name"
              value={renaming.title}
              maxLength={80}
              onChange={(e) => setRenaming({ id: t.id, title: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") act(() => renameChatAction(t.id, renaming.title), () => setRenaming(null));
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setRenaming(null);
                }
              }}
              onBlur={() => setRenaming(null)}
              style={{ cursor: "text", outline: "none", boxShadow: `inset 0 0 0 1px ${C.blue}`, borderRadius: 8 }}
            />
          ) : (
            <Link className="ct" href={`/assistant?t=${t.id}`} aria-current={on ? "page" : undefined} onClick={() => setDrawer(false)} style={{ color: "inherit", display: "block" }}>
              {t.title}
            </Link>
          )}
          <button className="cm" type="button" aria-label={`Options for ${t.title}`} aria-haspopup="menu" aria-expanded={menuFor === t.id} onClick={() => setMenuFor(menuFor === t.id ? null : t.id)}>
            <Icon name="dots" />
          </button>
          {menuFor === t.id ? (
            <div className="cmenu" role="menu" aria-label={`Options for ${t.title}`}>
              <button type="button" role="menuitem" autoFocus onClick={() => (setMenuFor(null), setRenaming({ id: t.id, title: t.title }))}>
                <Icon name="pencil" /> Rename
              </button>
              <a role="menuitem" href={`/api/chats/${t.id}/export`} download onClick={() => setMenuFor(null)} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: 6, fontSize: 14, color: "inherit" }} className="cmlink">
                <Icon name="export" size={15} /> Export as Word document
              </a>
              <a role="menuitem" href={`/api/chats/${t.id}/export?format=txt`} download onClick={() => setMenuFor(null)} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: 6, fontSize: 14, color: "inherit" }} className="cmlink">
                <Icon name="file" size={15} /> Export as text
              </a>
              <button type="button" role="menuitem" onClick={() => (setMenuFor(null), act(() => archiveChatAction(t.id, true), () => on && router.push("/assistant")))}>
                <Icon name="archive" /> Archive
              </button>
              <button className="danger" type="button" role="menuitem" onClick={() => (setMenuFor(null), setDelFor(t.id))}>
                <Icon name="trash" /> Delete
              </button>
            </div>
          ) : null}
        </div>
        {delFor === t.id ? (
          <div className="cconfirm" role="alertdialog" aria-label={`Delete “${t.title}”?`}>
            Delete “{t.title}”? This cannot be undone. The questions stay in the audit log.
            <span className="row" style={{ gap: 6 }}>
              <button className="danger" type="button" onClick={() => act(() => deleteChatAction(t.id), () => (setDelFor(null), on && router.push("/assistant")))}>
                Delete chat
              </button>
              <button type="button" autoFocus onClick={() => setDelFor(null)}>
                Cancel
              </button>
            </span>
          </div>
        ) : null}
      </div>
    );
  };

  const cite = (p: Passage, key?: string) => (
    <button key={key ?? p.sectionId} type="button" className="cite" onClick={() => openDoc(p.documentId, p.sectionId)} title={`${p.documentTitle} · ${p.sectionRef} ${p.heading}`} style={{ cursor: "pointer", marginLeft: 4 }}>
      {shortDoc(p)} · {p.sectionRef}
    </button>
  );

  return (
    <div className={`wrap pa${drawer ? " drawer" : ""}`}>
      {drawer ? <button className="pa-scrim" type="button" aria-label="Close the chat list" onClick={() => setDrawer(false)} /> : null}
      <aside className={`cs${csOpen ? "" : " min"}`} aria-label="Conversations">
        <div className="cshead">
          <span className="lbl">Chats</span>
          <button className="cstoggle" type="button" aria-label={csOpen ? "Collapse the chat list" : "Expand the chat list"} aria-expanded={csOpen} title={csOpen ? "Collapse the chat list" : "Expand the chat list"} onClick={toggleCs}>
            <Icon name="sidebar" />
          </button>
        </div>
        <Link className="newchat" href="/assistant" title="New chat" onClick={() => setDrawer(false)}>
          <Icon name="pencil" />
          <span>New chat</span>
        </Link>
        {!csOpen ? (
          <>
            <Link className="cstoggle mini" href="/assistant" aria-label="New chat" title="New chat">
              <Icon name="pencil" />
            </Link>
            <button className="cstoggle mini" type="button" aria-label="Search chats" title="Search chats" onClick={toggleCs}>
              <Icon name="search" />
            </button>
          </>
        ) : null}
        <label className="csearch">
          <Icon name="search" />
          <input type="search" placeholder="Search chats" value={q} aria-label="Search chats" onChange={(e) => onSearch(e.target.value)} />
        </label>
        <nav aria-label="Saved conversations" style={{ display: "contents" }}>
          {shown.groups.map((g) => (
            <Fragment key={g.label}>
              <div className="cgrp">{g.label}</div>
              {g.threads.map(chatItem)}
            </Fragment>
          ))}
        </nav>
        {q.trim() && !searching && found && !found.groups.length ? (
          <div className="src" style={{ padding: "14px 12px", lineHeight: 1.5 }}>
            No chats match “{q.trim()}”.{" "}
            <button type="button" className="linkbtn" onClick={() => onSearch("")}>
              Clear search
            </button>
          </div>
        ) : null}
        {!q.trim() && !threads.groups.length ? (
          <div className="src" style={{ padding: "14px 12px", lineHeight: 1.5 }}>
            No saved chats yet. Ask a question and the chat is kept here, with its sources.
          </div>
        ) : null}
        {threads.archived.length ? (
          <div className="archnote" style={{ flexDirection: "column", alignItems: "stretch" }}>
            <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
              <span>
                {threads.archived.length} archived {threads.archived.length === 1 ? "chat" : "chats"}
              </span>
              <button type="button" aria-expanded={showArchived} onClick={() => setShowArchived(!showArchived)}>
                {showArchived ? "Hide" : "Show"}
              </button>
            </div>
            {showArchived
              ? threads.archived.map((t) => (
                  <div key={t.id} className="row" style={{ justifyContent: "space-between", gap: 8, padding: "6px 0" }}>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.title}</span>
                    <button type="button" onClick={() => act(() => archiveChatAction(t.id, false))}>
                      Restore
                    </button>
                  </div>
                ))
              : null}
          </div>
        ) : null}
        {menuFor ? <button className="menubg" type="button" aria-label="Close menu" onClick={() => setMenuFor(null)} /> : null}
      </aside>

      <section className="chat" aria-label="Conversation">
        <div className="topbar">
          <div className="row" style={{ gap: 4, minWidth: 0 }}>
            <button className="cstoggle pa-chats" type="button" aria-label="Open the chat list" aria-expanded={drawer} onClick={() => setDrawer(true)}>
              <Icon name="sidebar" />
            </button>
            <div className="pa-popwrap">
              <button className="scope" type="button" aria-haspopup="menu" aria-expanded={pop === "scope"} onClick={() => setPop(pop === "scope" ? null : "scope")}>
                <span className="hidenarrow">Procedure assistant</span>
                <span className="sub">{scopeInfo.label}</span>
                <Icon name="chevronDown" />
              </button>
              {pop === "scope" ? (
                <>
                  <button className="pa-popbg" type="button" aria-label="Close" onClick={() => setPop(null)} />
                  <div className="pa-pop left" aria-label="Answer from" role="menu">
                    <div className="ph">
                      <span className="t">Answer from</span>
                      <span className="mut" style={{ fontSize: 12 }}>
                        Approved sources only
                      </span>
                    </div>
                    {SCOPES.filter((s) => s.k === "ALL" || s.k === scope || counts[s.k]).map((s, i) => (
                      <button key={s.k} className={`opt${scope === s.k ? " on" : ""}`} type="button" role="menuitemradio" aria-checked={scope === s.k} autoFocus={scope === s.k || (i === 0 && !SCOPES.some((x) => x.k === scope))} onClick={() => setScope(s.k)}>
                        <Icon name="check" strokeWidth={2.5} className="chk" />
                        <span>
                          <span className="t">{s.label}</span>
                          <span className="d">
                            {s.sub} · {counts[s.k]} {counts[s.k] === 1 ? "document" : "documents"}
                          </span>
                        </span>
                      </button>
                    ))}
                    <div className="foot src">Answers never draw on anything outside the approved sources. Superseded documents are labelled when cited; a choice with no documents is not shown.</div>
                  </div>
                </>
              ) : null}
            </div>
          </div>
          <div className="pa-popwrap">
            <button className={`srcbtn${pop === "src" ? " on" : ""}`} type="button" aria-haspopup="menu" aria-expanded={pop === "src"} onClick={() => setPop(pop === "src" ? null : "src")}>
              <Icon name="book" />
              <span className="hidenarrow">Approved sources</span>
              <span className="cnt">{docs.length}</span>
            </button>
            {pop === "src" ? (
              <>
                <button className="pa-popbg" type="button" aria-label="Close the source list" onClick={() => setPop(null)} />
                <div className="pa-pop right" aria-label="Approved sources" role="menu" style={{ maxHeight: "min(70vh, 640px)", overflowY: "auto" }}>
                  <div className="ph">
                    <span className="t">Approved sources</span>
                    <span className="mut" style={{ fontSize: 12 }}>
                      {current} current{superseded ? ` · ${superseded} superseded` : ""}
                    </span>
                  </div>
                  {[...docs]
                    .sort((a, b) => Number(a.status !== "CURRENT") - Number(b.status !== "CURRENT"))
                    .map((d, i) => (
                      <button key={d.id} className="docitem" type="button" role="menuitem" autoFocus={i === 0} onClick={() => openDoc(d.id)}>
                        <span className="row" style={{ justifyContent: "space-between", gap: 10, width: "100%" }}>
                          <span style={{ fontSize: 14, fontWeight: 500 }}>{d.title}</span>
                          <span className={`pill ${d.status === "SUPERSEDED" ? "neutral" : d.reviewNote ? "wait" : "ok"}`}>{d.status === "SUPERSEDED" ? "Superseded" : d.reviewNote ? "Check the source" : "Current"}</span>
                        </span>
                        <span className="src">
                          {d.issuingBody} · {d.version} · effective {istDate(d.effectiveFrom)}
                        </span>
                      </button>
                    ))}
                  {!docs.length ? <div className="src" style={{ padding: 12 }}>No documents are published yet. The developer account adds them under Knowledge base.</div> : null}
                  <div className="foot src">Jurisdiction: {docs[0]?.jurisdiction ?? "Telangana · India"}. Superseded documents stay searchable for history and are labelled in every answer.</div>
                </div>
              </>
            ) : null}
          </div>
        </div>

        <div className="pa-scroll">
          <div className="thread" aria-live="polite" aria-busy={!!waiting}>
            {error ? (
              <div className="banner" role="alert">
                <Icon name="alertCircle" />
                <span>{error}</span>
                <button className="x" type="button" onClick={() => setError(null)}>
                  Dismiss
                </button>
              </div>
            ) : null}
            {thread?.archived ? (
              <div className="banner" role="status">
                <Icon name="archive" />
                <span>This chat is archived. Restore it to continue here, or ask below to start a new chat.</span>
                <button className="x" type="button" onClick={() => act(() => archiveChatAction(thread.id, false))}>
                  Restore
                </button>
              </div>
            ) : null}
            {!messages.length && !waiting ? (
              <div className="empty">
                <span style={{ width: 52, height: 52, borderRadius: 16, background: "rgba(96,165,250,0.12)", display: "inline-flex", alignItems: "center", justifyContent: "center", color: C.blue }}>
                  <Icon name="book" size={24} strokeWidth={1.75} />
                </span>
                <div>
                  <div className="h" style={{ fontSize: 24 }}>
                    What do you need to check?
                  </div>
                  <p className="sec" style={{ margin: "8px auto 0", fontSize: 15, maxWidth: 560 }}>
                    A fresh conversation. Nothing from the other chats carries over. Procedure answers name their source and version; general answers come from the local model and are marked as such.
                  </p>
                </div>
                {templates.length ? (
                  <div className="sugg">
                    {templates.slice(0, 6).map((t) => (
                      <button key={t.id} type="button" onClick={() => ask(t.question, [])} disabled={pending}>
                        {t.title}
                        {t.sourceLabel ? <span>{t.sourceLabel}</span> : null}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}

            {messages.map((m) =>
              m.role === "USER" ? (
                <div key={m.id} className="msg user">
                  <span className="who" style={{ background: C.chip, color: C.chipFg }} aria-hidden="true">
                    {viewer.initials}
                  </span>
                  <div className="bubble">
                    {m.attachments.map((a) => (
                      <AttachChip key={`${a.kind}:${a.id}`} a={a} />
                    ))}
                    {m.text}
                  </div>
                </div>
              ) : (
                <Fragment key={m.id}>
                  <div className="msg ai">
                    <span className="who" style={{ background: "#2563eb", color: "#fafafa" }} aria-hidden="true">
                      <Icon name="bookOpen" size={16} />
                    </span>
                    <div className="bubble" style={{ minWidth: 0, flex: 1 }}>
                      {m.answer ? <AnswerBody a={m.answer} text={m.text} cite={cite} docById={docById} onError={setError} /> : <p style={{ margin: 0 }}>{m.text}</p>}
                    </div>
                  </div>
                  <AnswerActions
                    m={m}
                    threadId={thread!.id}
                    isLast={m.id === lastAi && !thread?.archived}
                    onRetry={() => act(() => retryChatAction(thread!.id))}
                    onSources={(id) => openDoc(id)}
                    busy={pending}
                    onError={setError}
                  />
                </Fragment>
              ),
            )}
            {waiting ? (
              <>
                <div className="msg user">
                  <span className="who" style={{ background: C.chip, color: C.chipFg }} aria-hidden="true">
                    {viewer.initials}
                  </span>
                  <div className="bubble">
                    {waiting.attachments.map((a) => (
                      <AttachChip key={`${a.kind}:${a.id}`} a={a} />
                    ))}
                    {waiting.question}
                  </div>
                </div>
                <div className="msg ai">
                  <span className="who" style={{ background: "#2563eb", color: "#fafafa" }} aria-hidden="true">
                    <Icon name="bookOpen" size={16} />
                  </span>
                  <div className="bubble row" style={{ gap: 10, color: C.mut }} role="status">
                    <Icon name="spinner" size={16} className="spin" />
                    {waiting.attachments.length > 1 ? `Comparing the ${waiting.attachments.length} attachments…` : waiting.attachments[0]?.kind === "CASE" ? "Reading the case record and the approved sources…" : waiting.attachments.length ? "Reading the attachment and the approved sources…" : "Reading the approved sources…"}
                  </div>
                </div>
              </>
            ) : null}
            <div ref={endRef} />
          </div>
        </div>

        <div className="composer">
          {attachments.length ? (
            <div className="attrow" style={{ flexWrap: "wrap", gap: 6 }}>
              {attachments.map((a) => (
                <span key={`${a.kind}:${a.id}`} className="attchip">
                  <Icon name={a.kind === "UPLOADING" ? "spinner" : a.kind === "CASE" ? "folder" : a.kind === "MAIL" ? "mail" : "paperclip"} size={14} className={a.kind === "UPLOADING" ? "spin" : undefined} />
                  <span>
                    <span style={{ display: "block", fontWeight: 500 }}>{a.label}</span>
                    <span className="src">{a.kind === "UPLOADING" ? "Reading the file on this computer… (a scan takes longer)" : a.sub}</span>
                  </span>
                  {a.kind !== "UPLOADING" ? (
                    <button className="x" type="button" aria-label={`Remove ${a.label}`} onClick={() => (setAttachments((xs) => xs.filter((x) => x !== a)), taRef.current?.focus())}>
                      <Icon name="x" size={14} />
                    </button>
                  ) : null}
                </span>
              ))}
              {ready.length > 1 && !text.trim() && !uploading ? (
                <button className="chip" type="button" onClick={() => ask("What do these have in common? List every account, number, ID, reference or name that appears in more than one of them.")} disabled={pending} style={{ alignSelf: "center" }}>
                  What connects these?
                </button>
              ) : null}
            </div>
          ) : null}
          <form
            className="cbox"
            onSubmit={(e) => {
              e.preventDefault();
              ask(text);
            }}
          >
            <button ref={plusRef} className="ibtn" type="button" aria-label="Attach a file, a mail or a FIR case" aria-haspopup="menu" aria-expanded={pop === "plus"} onClick={() => (setPick("none"), setPop(pop === "plus" ? null : "plus"))}>
              <Icon name="paperclip" />
            </button>
            <input ref={fileRef} id="pafile" type="file" multiple accept=".pdf,.docx,.txt,.md,.eml,.csv,.xlsx,.png,.jpg,.jpeg" aria-label="Upload files from this computer" tabIndex={-1} onChange={(e) => e.target.files?.length && void upload(e.target.files)} style={{ position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none" }} />
            {pop === "plus" ? (
              <>
                <button className="pa-popbg" type="button" aria-label="Close" onClick={() => setPop(null)} />
                <div className="plusmenu" role="menu" aria-label="Attach">
                  {pick === "none" ? (
                    <>
                      <button className="opt" type="button" role="menuitem" autoFocus onClick={() => fileRef.current?.click()}>
                        <Icon name="upload" size={16} />
                        <span>
                          <span className="t">Upload files from this computer</span>
                          <span className="d">FIR copies, statements, letters, circulars · PDF, Word, Excel, text, email, photos · several at once to compare</span>
                        </span>
                      </button>
                      {canUseCases ? (
                        <>
                          <button className="opt" type="button" role="menuitem" onClick={() => (setPick("mail"), void loadAttachables())}>
                            <Icon name="mail" size={16} />
                            <span>
                              <span className="t">Mail response</span>
                              <span className="d">A reply from the station inbox</span>
                            </span>
                          </button>
                          <button className="opt" type="button" role="menuitem" onClick={() => (setPick("case"), void loadAttachables())}>
                            <Icon name="folder" size={16} />
                            <span>
                              <span className="t">FIR case</span>
                              <span className="d">The whole record, from the FIR upload to today</span>
                            </span>
                          </button>
                        </>
                      ) : null}
                    </>
                  ) : (
                    <>
                      <div className="ph">
                        <span className="t">{pick === "mail" ? "Mail response" : "FIR case"}</span>
                        <button className="tab" type="button" autoFocus onClick={() => setPick("none")} style={{ minHeight: 28, padding: "0 8px", fontSize: 12 }}>
                          Back
                        </button>
                      </div>
                      <div style={{ maxHeight: 320, overflowY: "auto" }}>
                        {!attachables ? (
                          <div className="row src" style={{ gap: 8, padding: 12 }} role="status">
                            <Icon name="spinner" size={14} className="spin" /> Loading…
                          </div>
                        ) : (pick === "mail" ? attachables.mails : attachables.cases).length ? (
                          (pick === "mail" ? attachables.mails : attachables.cases).map((x) => (
                            <button key={x.id} className="opt" type="button" role="menuitem" onClick={() => (attach({ kind: pick === "mail" ? "MAIL" : "CASE", id: x.id, label: x.label, sub: x.sub }), setPop(null), taRef.current?.focus())}>
                              <span>
                                <span className="t">{x.label}</span>
                                <span className="d">{x.sub}</span>
                              </span>
                            </button>
                          ))
                        ) : (
                          <div className="src" style={{ padding: 12, lineHeight: 1.5 }}>
                            {pick === "mail" ? "The station inbox has no mail you can use here." : "You have no cases assigned. A case appears here once it is assigned to you."}
                          </div>
                        )}
                      </div>
                      {pick === "case" ? <div className="foot src">The case comes in whole: the FIR as uploaded, the checked details, every request and reply, the ledger and the audit log up to now.</div> : null}
                    </>
                  )}
                </div>
              </>
            ) : null}
            <label htmlFor="pq" className="srt">
              Ask a procedure question
            </label>
            <textarea
              id="pq"
              ref={taRef}
              rows={1}
              placeholder={placeholder}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                e.target.style.height = "auto";
                e.target.style.height = `${Math.min(e.target.scrollHeight, 200)}px`;
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  ask(text);
                }
              }}
            />
            <button className="ibtn send" type="submit" aria-label="Send" aria-busy={!!waiting}>
              <Icon name={waiting ? "spinner" : "arrowUp"} strokeWidth={2.5} className={waiting ? "spin" : undefined} />
            </button>
          </form>
          <div className="disc">Answers come only from approved sources and name their section and version. Check the source before acting on one. Nothing is sent from here.</div>
        </div>
      </section>

      <DesignModal open={!!doc} onClose={() => setDoc(null)} scope="scr-dashboard" maxWidth={900} title={doc?.data?.title ?? "Approved source"}>
        {doc && !doc.data ? (
          <div className="mbody" role="status" style={{ minHeight: 200 }}>
            {doc.error ? (
              <p className="sec">{doc.error}</p>
            ) : (
              <span className="row" style={{ gap: 8, color: C.mut }}>
                <Icon name="spinner" size={16} className="spin" /> Opening the document…
              </span>
            )}
          </div>
        ) : doc?.data ? (
          <>
            <div className="mhead">
              <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
                <span className="lbl">Approved source</span>
                <span className={`pill ${doc.data.status === "SUPERSEDED" ? "neutral" : doc.data.reviewNote ? "wait" : "ok"}`}>{doc.data.status === "SUPERSEDED" ? "Superseded" : doc.data.reviewNote ? "Check the source" : "Current"}</span>
              </div>
              <h2 className="h" style={{ fontSize: 22 }}>
                {doc.data.title}
              </h2>
              <p className="sec" style={{ margin: 0, fontSize: 14 }}>
                {doc.data.issuingBody} · {doc.data.docNumber} · version {doc.data.version} · effective {istDate(doc.data.effectiveFrom)}
              </p>
            </div>
            <div className="mbody">
              {doc.data.successor ? (
                <div className="inner" style={{ padding: "12px 14px", fontSize: 14, display: "flex", gap: 10 }}>
                  <span className="pill neutral">Superseded</span>
                  <span className="sec">
                    Replaced by version {doc.data.successor.version}.{" "}
                    <button type="button" className="linkbtn" onClick={() => openDoc(doc.data!.successor!.id)}>
                      Open the current version
                    </button>
                  </span>
                </div>
              ) : null}
              {doc.data.reviewNote ? (
                <div className="inner" style={{ padding: "12px 14px", fontSize: 14, display: "flex", gap: 10, alignItems: "flex-start", background: "rgba(251,191,36,0.07)", color: C.amber }}>
                  <Icon name="alertCircle" size={18} />
                  <span>{doc.data.reviewNote}</span>
                </div>
              ) : null}
              <div className="doc">
                <nav className="toc" aria-label="Contents">
                  <span className="lbl" style={{ padding: "0 10px 6px" }}>
                    Contents
                  </span>
                  {doc.data.sections.map((s) => (
                    <a key={s.id} href={`#sec-${s.id}`} onClick={(e) => (e.preventDefault(), document.getElementById(`sec-${s.id}`)?.scrollIntoView({ block: "start", behavior: "smooth" }))}>
                      {s.sectionRef} {s.heading}
                    </a>
                  ))}
                </nav>
                <div className="body">
                  {doc.data.sections.map((s) => (
                    <section key={s.id} id={`sec-${s.id}`} className={doc.section === s.id ? "hit" : undefined}>
                      <h3>
                        {s.sectionRef} {s.heading}
                      </h3>
                      {paras(s.text).map((p, i) => (
                        <p key={i}>{p}</p>
                      ))}
                    </section>
                  ))}
                  {doc.data.isSynthetic ? (
                    <p className="mut" style={{ fontSize: 13 }}>
                      Illustrative summary for this demonstration. The issued document is the authority; the assistant cites its section numbers and version in every answer.
                    </p>
                  ) : null}
                </div>
              </div>
            </div>
            <div className="mfoot">
              <button className="btn" type="button" onClick={() => (setDoc(null), setPop("src"))}>
                All sources
              </button>
              <button className="btn primary" type="button" onClick={() => setDoc(null)}>
                Close
              </button>
            </div>
          </>
        ) : null}
      </DesignModal>
    </div>
  );
}

const KIND_LABEL: Record<string, string> = { BANK_ACCOUNT: "Account", UPI_ID: "UPI ID", PHONE: "Mobile", EMAIL: "Email", WEBSITE: "Website", IP_ADDRESS: "IP address", TXN_REFERENCE: "Transaction reference", DEVICE: "Handset", PLATFORM_PROFILE: "Profile", PERSON_NAME: "Name" };

/** What several attachments have in common, found by exact matching, each with where it is written. */
function Connections({ list }: { list: NonNullable<GuidanceAnswer["connections"]> }) {
  return (
    <div style={{ margin: "4px 0 12px", display: "flex", flexDirection: "column", gap: 6 }}>
      <div className="lbl">{list.length ? "Written in more than one attachment" : "What links them"}</div>
      {list.length ? (
        <ol style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 6 }}>
          {list.map((k, i) => (
            <li key={`${k.kind}:${k.value}`} className="inner" style={{ padding: "8px 12px", fontSize: 14 }}>
              <span className="cite" style={{ marginRight: 6 }}>{`K${i + 1}`}</span>
              <strong style={{ fontWeight: 500, overflowWrap: "anywhere" }}>
                {KIND_LABEL[k.kind] ?? k.kind} {k.value}
              </strong>
              {k.strength !== "SAME" ? (
                <span className={`pill ${k.strength === "POSSIBLE" ? "wait" : "neutral"}`} style={{ marginLeft: 6 }}>
                  {k.strength === "POSSIBLE" ? "Possibly the same" : "Same name"}
                </span>
              ) : null}
              <span className="src" style={{ display: "block", marginTop: 2 }}>
                In {k.in.map((x) => `${x.label} (${x.refs.join(", ")})`).join(" · ")}
              </span>
              {k.note ? (
                <span className="src" style={{ display: "block" }}>
                  {k.note}
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      ) : (
        <p className="sec" style={{ margin: 0, fontSize: 14 }}>
          No account, number, UPI ID, email, website, IP address or reference is written in more than one of them, so their records do not link them.
        </p>
      )}
    </div>
  );
}

function AttachChip({ a }: { a: ChatAttachment }) {
  return (
    <span className="row" style={{ gap: 8, fontSize: 13, color: C.sec, marginBottom: 6 }}>
      <Icon name={a.kind === "CASE" ? "folder" : a.kind === "MAIL" ? "mail" : "paperclip"} size={14} />
      <span>
        {a.label}
        <span className="mut"> · {a.kind === "CASE" ? "FIR case" : a.kind === "MAIL" ? "Mail response" : "Uploaded file"}</span>
      </span>
    </span>
  );
}

function AnswerBody({ a, text, cite, docById, onError }: { a: CaseAnswer | GuidanceAnswer; text: string; cite: (p: Passage, key?: string) => ReactNode; docById: Map<string, PaDoc>; onError: (e: string) => void }) {
  if ("established" in a) return <CaseBody a={a} text={text} onError={onError} />;
  const g = a;
  const byRef = new Map<string, ReactNode>();
  g.passages.forEach((p, i) => byRef.set(`S${i + 1}`, cite(p, `s${i}`)));
  for (const e of g.extracts ?? []) byRef.set(e.ref, <span key={e.ref} className="cite" title={e.heading} style={{ marginLeft: 4 }}>{e.ref}</span>);
  (g.connections ?? []).forEach((k, i) => byRef.set(`K${i + 1}`, <span key={`k${i}`} className="cite" title={`${KIND_LABEL[k.kind] ?? k.kind} ${k.value}`} style={{ marginLeft: 4 }}>{`K${i + 1}`}</span>));
  const model = g.provider.id === "LOCAL_MODEL";
  const warn = [...new Set(g.passages.map((p) => docById.get(p.documentId)?.reviewNote).filter((x): x is string => !!x))];
  // A greeting, the date, what the assistant can do: a plain reply, nothing looked up.
  if (g.mode === "CHAT")
    return paras(text).map((p, i) => (
      <p key={i} style={{ margin: "0 0 10px", whiteSpace: "pre-line" }}>
        {p}
      </p>
    ));
  if (g.mode === "GENERAL")
    return (
      <>
        <div className="inner" style={{ padding: "10px 12px", fontSize: 13, display: "flex", gap: 10, alignItems: "flex-start", marginBottom: 10 }}>
          <span className="pill neutral">General answer</span>
          <span className="sec">Not from the station&apos;s approved sources. The local model answered from its general knowledge, which can be wrong or out of date.</span>
        </div>
        <Markdown text={text} cite={(n) => <span className="cite">{n}</span>} />
        {g.caution ? (
          <div className="inner" style={{ padding: "10px 12px", fontSize: 13, display: "flex", gap: 10, alignItems: "flex-start", marginBottom: 10 }}>
            <span className="pill wait">Check the source</span>
            <span className="sec">{g.caution}</span>
          </div>
        ) : null}
        <p className="src" style={{ margin: "4px 0 0" }} title={g.provider.disclosure}>
          Answered by {g.provider.label} from general knowledge. Nothing left this computer.
        </p>
      </>
    );
  return (
    <>
      {g.about ? (
        <p className="sec" style={{ margin: "0 0 10px", fontSize: 14 }}>
          {g.about}
        </p>
      ) : null}
      {g.kind === "INSUFFICIENT" && !g.extracts?.length ? (
        <div className="inner" style={{ padding: "10px 12px", fontSize: 14, display: "flex", gap: 10, alignItems: "flex-start" }}>
          <span className="pill gap">Not in the approved sources</span>
          <span className="sec">{text}</span>
        </div>
      ) : model && !g.extracts?.length ? (
        // Written by the local model from the approved passages: shown as written, with its sources listed below.
        <Markdown text={text} cite={(n) => byRef.get(n) ?? <span className="cite">{n}</span>} />
      ) : (
        paras(text).map((p, i) => (
          <p key={i} style={{ margin: "0 0 10px", whiteSpace: model ? "pre-line" : undefined }}>
            {model ? withCites(p, (n) => byRef.get(n) ?? <span className="cite">{n}</span>) : p}
          </p>
        ))
      )}
      {g.connections ? <Connections list={g.connections} /> : null}
      {g.kind === "CONFLICT" ? (
        <div className="inner" style={{ padding: "10px 12px", fontSize: 13, display: "flex", gap: 10, alignItems: "flex-start", marginBottom: 10 }}>
          <span className="pill wait">Sources differ</span>
          <span className="sec">The current documents below say different things. The assistant does not choose between them; check with your supervisor.</span>
        </div>
      ) : null}
      {(g.extracts ?? []).map((e) => (
        <div key={e.ref} className="quote">
          <span className="cite" style={{ marginRight: 6 }}>
            {e.ref}
          </span>
          <strong style={{ fontWeight: 500 }}>{e.heading}</strong>
          {paras(e.text).map((p, i) => (
            <span key={i} style={{ display: "block", marginTop: 4 }}>
              “{p}”
            </span>
          ))}
        </div>
      ))}
      {g.caution && g.mode !== "GENERAL" ? (
        <div className="inner" style={{ padding: "10px 12px", fontSize: 13, display: "flex", gap: 10, alignItems: "flex-start", marginBottom: 10 }}>
          <span className="pill wait">Check the source</span>
          <span className="sec">{g.caution}</span>
        </div>
      ) : null}
      {model && g.passages.length && !g.extracts?.length ? (
        <div className="srcs">
          <div className="lbl">Sources</div>
          {g.passages.map((p, i) => (
            <details key={p.sectionId} className="srcitem">
              <summary>
                <span className="cite">{`S${i + 1}`}</span>
                <span className="t">
                  {p.documentTitle} · {p.sectionRef} · {p.heading}
                </span>
                {p.status === "SUPERSEDED" ? <span className="pill neutral">Superseded</span> : null}
              </summary>
              <div className="quote">
                {paras(p.text).map((t, k) => (
                  <span key={k} style={{ display: "block", marginTop: k ? 6 : 0 }}>
                    {t}
                  </span>
                ))}
              </div>
              {cite(p, `open${i}`)}
            </details>
          ))}
        </div>
      ) : null}
      {(model && !g.extracts?.length ? [] : g.passages).map((p, i) => (
        <div key={p.sectionId} style={{ margin: "0 0 10px" }}>
          <p style={{ margin: "0 0 4px" }}>
            <strong style={{ fontWeight: 500 }}>{p.heading}</strong>
            {cite(p, `p${i}`)}
            {p.status === "SUPERSEDED" ? <span className="pill neutral" style={{ marginLeft: 6 }}>Superseded</span> : null}
          </p>
          <div className="quote" style={{ marginTop: 0 }}>
            {paras(p.text).map((t, k) => (
              <span key={k} style={{ display: "block", marginTop: k ? 6 : 0 }}>
                {t}
              </span>
            ))}
          </div>
        </div>
      ))}
      {g.superseded.length ? (
        <div className="inner" style={{ padding: "10px 12px", fontSize: 13, display: "flex", gap: 10, alignItems: "flex-start", marginBottom: 10 }}>
          <span className="pill neutral">History</span>
          <span className="sec">
            Also covered by a superseded version:{" "}
            {g.superseded.slice(0, 2).map((p, i) => (
              <Fragment key={p.sectionId}>
                {i ? ", " : ""}
                {p.documentTitle} {p.version} {p.sectionRef}
                {p.supersededBy ? ` (replaced by ${p.supersededBy.version})` : ""}
              </Fragment>
            ))}
            . It is not in force.
          </span>
        </div>
      ) : null}
      {warn.map((w) => (
        <div key={w} className="inner" style={{ padding: "10px 12px", fontSize: 13, display: "flex", gap: 10, alignItems: "flex-start", marginBottom: 10 }}>
          <span className="pill wait">Check the source</span>
          <span className="sec">{w}</span>
        </div>
      ))}
      <p className="src" style={{ margin: "4px 0 0" }} title={g.provider.disclosure}>
        Answered by {g.provider.label}.{" "}
        {g.connections
          ? model
            ? "Written from the links and the attachments' parts listed; check each point against what it cites."
            : "The links were found by exact matching; the parts are quoted as written."
          : model
            ? "Written from the approved sources listed; check each point against the source it cites."
            : "Quoted from the approved sources; nothing added."}
      </p>
    </>
  );
}

function CaseBody({ a, text, onError }: { a: CaseAnswer; text: string; onError: (e: string) => void }) {
  const refs = new Map(a.references.map((r) => [r.ref, r]));
  const section = (title: string, items: CaseAnswer["established"]) =>
    items.length ? (
      <div style={{ marginBottom: 10 }}>
        <div className="lbl" style={{ marginBottom: 6 }}>
          {title}
        </div>
        <ol style={{ margin: 0, display: "flex", flexDirection: "column", gap: 6 }}>
          {items.map((i, n) => (
            <li key={n}>
              {i.text}
              {i.refs.map((r) => (
                <Link key={r} href={refs.get(r)?.href ?? "#"} className="cite" style={{ marginLeft: 4 }} title={refs.get(r)?.label}>
                  {refs.get(r)?.label ?? r}
                </Link>
              ))}
            </li>
          ))}
        </ol>
      </div>
    ) : null;
  return (
    <>
      {paras(text).map((p, i) => (
        <p key={i} style={{ margin: "0 0 10px" }}>
          {p}
        </p>
      ))}
      {section("Steps", a.steps)}
      {section(a.intent === "MODEL" ? "Facts it used" : "What the records establish", a.established)}
      {a.hypotheses.length ? (
        <div className="inner" style={{ padding: "10px 12px", fontSize: 13, display: "flex", gap: 10, alignItems: "flex-start", marginBottom: 10 }}>
          <span className="pill gap">Not established</span>
          <span className="sec">{a.hypotheses.map((h) => h.text).join(" ")}</span>
        </div>
      ) : null}
      {section("Not known yet", a.unknowns)}
      {a.tasks?.length ? <Tasks tasks={a.tasks} onError={onError} /> : null}
      {a.suggestions.length ? (
        <div className="chips" style={{ marginBottom: 10 }}>
          {a.suggestions.map((s) => (
            <Link key={s.href} className="chip" href={s.href} style={{ display: "inline-flex", alignItems: "center" }}>
              {s.label}
            </Link>
          ))}
        </div>
      ) : null}
      <p className="src" style={{ margin: "4px 0 0" }} title={a.provider.disclosure}>
        Answered by {a.provider.label} from {a.attachment?.label.split(" · ")[0] ?? "the case"}&apos;s records{a.intent === "MODEL" ? ". Check each point against its record." : "."}
      </p>
    </>
  );
}

/** Drafts the assistant can prepare for a case. Preparing one never sends it: it waits in Next actions for approval. */
function Tasks({ tasks, onError }: { tasks: AnswerTask[]; onError: (e: string) => void }) {
  const [done, setDone] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 10 }}>
      <div className="lbl">Requests for this case</div>
      {tasks.map((t) => {
        const key = t.taskId ?? t.href ?? t.label;
        const href = done[key] ?? t.href;
        return (
          <div key={key} className="inner" style={{ padding: "10px 12px", display: "flex", gap: 12, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
            <span style={{ minWidth: 0, flex: "1 1 260px" }}>
              <span style={{ display: "block", fontWeight: 500, fontSize: 14 }}>{t.label}</span>
              <span className="src" style={{ display: "block", marginTop: 2 }}>
                {done[key] ? "Drafted by the assistant. It waits in Next actions for your approval; nothing has been sent." : t.sub}
              </span>
            </span>
            {href ? (
              <Link className="btn sm" href={href}>
                Open the draft
              </Link>
            ) : (
              <button
                className="btn sm primary"
                type="button"
                aria-busy={busy === key}
                onClick={async () => {
                  if (busy) return;
                  setBusy(key);
                  const r = await prepareDraftFromChatAction(t.taskId!);
                  setBusy(null);
                  if (!r.ok) return onError(r.error);
                  setDone((d) => ({ ...d, [key]: `/cases/${r.data.caseId}/actions?task=${t.taskId}` }));
                }}
              >
                {busy === key ? <Icon name="spinner" size={14} className="spin" /> : null}
                Prepare the draft
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function AnswerActions({ m, threadId, isLast, onRetry, onSources, busy, onError }: { m: ChatThreadView["messages"][number]; threadId: string; isLast: boolean; onRetry: () => void; onSources: (docId: string) => void; busy: boolean; onError: (e: string) => void }) {
  const [copied, setCopied] = useState(false);
  const [fb, setFb] = useState<string | null>(m.feedback);
  const a = m.answer;
  const firstDoc = a && "passages" in a ? a.passages[0]?.documentId : a && "guidance" in a ? a.guidance?.passages[0]?.documentId : undefined;
  const copy = async () => {
    const lines = [m.text];
    if (a && "extracts" in a) for (const e of a.extracts ?? []) lines.push(`${e.ref} ${e.heading}: “${e.text}”`);
    if (a && "passages" in a) for (const p of a.passages) lines.push(`${p.documentTitle} ${p.sectionRef} (${p.heading}): ${p.text}`);
    if (a && "established" in a) for (const i of a.established) lines.push(`• ${i.text}`);
    if (await copyText(lines.join("\n\n"))) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } else onError("Copying is blocked in this browser. Select the answer text and copy it instead.");
  };
  const rate = async (v: "UP" | "DOWN") => {
    const next = fb === v ? null : v;
    const prev = fb;
    setFb(next);
    const r = await rateAnswerAction(m.id, next);
    if (!r.ok) {
      setFb(prev);
      onError(r.error);
    }
  };
  return (
    <div className="acts" aria-label="Answer actions">
      <button className="act" type="button" onClick={copy}>
        <Icon name={copied ? "check" : "copy"} /> {copied ? "Copied" : "Copy"}
      </button>
      <button className={`act${fb === "UP" ? " on" : ""}`} type="button" aria-pressed={fb === "UP"} onClick={() => rate("UP")}>
        <Icon name="thumbsUp" /> Good
      </button>
      <button className={`act${fb === "DOWN" ? " on" : ""}`} type="button" aria-pressed={fb === "DOWN"} onClick={() => rate("DOWN")}>
        <Icon name="thumbsDown" /> Bad
      </button>
      {isLast ? (
        <button className="act" type="button" onClick={onRetry} disabled={busy} aria-busy={busy}>
          <Icon name="retry" /> Retry
        </button>
      ) : null}
      {firstDoc ? (
        <button className="act" type="button" onClick={() => onSources(firstDoc)}>
          <Icon name="bookOpen" /> Sources
        </button>
      ) : null}
      {a && "mode" in a && a.mode === "CHAT" ? null : (
        <a className="act" href={`/api/chats/${threadId}/export?message=${m.id}`} download>
          <Icon name="download" /> Save as document
        </a>
      )}
    </div>
  );
}
