"use client";

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";

/**
 * Comment mode (development only). Turn it on with the "Comment" button (or Alt+Shift+C), or Alt+click any block
 * at any time: the block is outlined, and a box asks what should change. The note is kept on this server with the
 * page, the block's place in the page and a picture of it, for the developer to act on; a numbered pin marks each
 * open note. While commenting, clicks go to the comment box, not to the app. Escape stops.
 */

interface Target {
  selector: string;
  tag: string;
  role: string | null;
  label: string | null;
  classes: string[];
  text: string;
  html: string;
  heading: string | null;
  dialog: string | null;
  rect: { x: number; y: number; w: number; h: number };
  viewport: { w: number; h: number };
  theme: "dark" | "light";
}
interface Note {
  id: string;
  n: number;
  createdAt: string;
  by: { username: string; displayName: string };
  path: string;
  url: string;
  comment: string;
  status: "open" | "done" | "dismissed";
  reply: string | null;
  target: Target;
  shot: { file: string | null; kind: "block" | "page" | null; note: string | null; pending: boolean };
}
type Brief = { id: string; n: number; path: string; comment: string; status: string };

const OURS = "data-ui-notes";
const Z = 2147483000;
const ORANGE = "#f97316";
const text = (el: Element | null | undefined, n = 120) => (el?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, n) || null;
const ours = (t: EventTarget | null) => t instanceof Element && !!t.closest(`[${OURS}]`);
const when = (iso: string) => new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));

/** A CSS path to the element: stable classes and the element's place among its siblings, up to a unique id. */
function cssPath(el: Element): string {
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur !== document.body && cur !== document.documentElement && parts.length < 14) {
    const node: Element = cur;
    // Ids the libraries generate (Radix, React's useId) change from one render to the next: never used.
    const stableId = !!node.id && /^[A-Za-z][\w-]*$/.test(node.id) && !/^radix|_R_|^r\d|«/i.test(node.id);
    if (stableId && document.querySelectorAll(`#${CSS.escape(node.id)}`).length === 1) {
      parts.unshift(`#${CSS.escape(node.id)}`);
      break;
    }
    let part = node.tagName.toLowerCase();
    part += [...node.classList].filter((c) => /^[A-Za-z][\w-]*$/.test(c) && c.length <= 30).slice(0, 3).map((c) => `.${CSS.escape(c)}`).join("");
    for (const a of ["data-task", "data-testid", "role", "aria-label"]) {
      const v = node.getAttribute(a);
      if (v && v.length <= 60) part += `[${a}="${v.replace(/"/g, '\\"')}"]`;
    }
    const parent: Element | null = node.parentElement;
    if (parent) {
      const same = [...parent.children].filter((c) => c.tagName === node.tagName);
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
    }
    parts.unshift(part);
    cur = parent;
  }
  return parts.join(" > ");
}

function describe(el: Element): Target {
  const r = el.getBoundingClientRect();
  let heading: string | null = null;
  for (let a: Element | null = el; a && a !== document.body && !heading; a = a.parentElement) {
    const h = a.matches("h1,h2,h3,legend") ? a : a.querySelector("h1,h2,h3,legend");
    if (h) heading = text(h);
  }
  const dialog = el.closest('[role="dialog"]');
  const html = el.outerHTML.replace(/>([^<]{120})[^<]+</g, ">$1…<");
  return {
    selector: cssPath(el),
    tag: el.tagName.toLowerCase(),
    role: el.getAttribute("role"),
    label: el.getAttribute("aria-label"),
    classes: [...el.classList].slice(0, 10),
    text: text(el, 300) ?? "",
    html: html.slice(0, 3000),
    heading,
    dialog: dialog ? (dialog.getAttribute("aria-label") ?? text(dialog.querySelector("h2"))) : null,
    rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
    viewport: { w: window.innerWidth, h: window.innerHeight },
    theme: document.documentElement.classList.contains("light") ? "light" : "dark",
  };
}
const nameOf = (el: Element) => {
  const t = text(el, 40);
  return `${el.tagName.toLowerCase()}${el.classList.length ? `.${[...el.classList].slice(0, 2).join(".")}` : ""}${t ? ` “${t}”` : ""}`;
};
const find = (selector: string): Element | null => {
  try {
    return document.querySelector(selector);
  } catch {
    return null;
  }
};

const panelStyle: CSSProperties = { position: "fixed", left: 16, bottom: 64, width: 380, maxWidth: "calc(100vw - 32px)", maxHeight: "60vh", overflow: "auto", zIndex: Z, pointerEvents: "auto", background: "var(--c-card)", color: "var(--c-fg)", border: "1px solid var(--c-line-strong)", borderRadius: 12, boxShadow: "0 16px 40px rgba(0,0,0,0.45)", fontSize: 13 };
const btn = (primary = false): CSSProperties => ({ minHeight: 32, padding: "0 12px", borderRadius: 8, border: `1px solid ${primary ? "transparent" : "var(--c-line-strong)"}`, background: primary ? "var(--c-accent)" : "var(--c-raise)", color: primary ? "#fff" : "var(--c-fg)", font: "inherit", fontSize: 13, cursor: "pointer" });

export function UiNotes() {
  const path = usePathname();
  const [available, setAvailable] = useState(false);
  const [mode, setMode] = useState(false);
  const [notes, setNotes] = useState<Note[]>([]);
  const [all, setAll] = useState<Brief[]>([]);
  const [open, setOpen] = useState(0);
  const [panel, setPanel] = useState<null | "page" | "all">(null);
  const [hover, setHover] = useState<{ rect: DOMRect; name: string } | null>(null);
  const [target, setTarget] = useState<{ el: Element; t: Target } | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [pins, setPins] = useState<{ id: string; n: number; x: number; y: number }[]>([]);
  const modeRef = useRef(false);
  const targetRef = useRef<typeof target>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    modeRef.current = mode;
    targetRef.current = target;
  }, [mode, target]);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/ui-notes?path=${encodeURIComponent(path)}`, { cache: "no-store" });
      if (!res.ok) return setAvailable(false);
      const j = (await res.json()) as { notes: Note[]; open: number; all: Brief[] };
      setNotes(j.notes);
      setAll(j.all);
      setOpen(j.open);
      setAvailable(true);
    } catch {
      setAvailable(false);
    }
  }, [path]);
  useEffect(() => {
    // The notes come from the server: fetched when the page changes, and every half minute for replies.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, [load]);

  const pick = useCallback((el: Element | null) => {
    if (!el || el === document.body || el === document.documentElement) return;
    setTarget({ el, t: describe(el) });
    setHover(null);
    setMsg(null);
    setTimeout(() => boxRef.current?.focus(), 0);
  }, []);
  const stop = useCallback(() => {
    setMode(false);
    setHover(null);
    setTarget(null);
    setDraft("");
  }, []);

  // While commenting (or on Alt+click), clicks pick a block instead of reaching the app. The comment box's own
  // clicks pass, kept from the page's windows so they do not close.
  useEffect(() => {
    if (!available) return;
    const active = (e: MouseEvent | PointerEvent) => modeRef.current || e.altKey;
    const block = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    };
    const onDown = (e: PointerEvent | MouseEvent) => {
      if (ours(e.target)) return void e.stopPropagation();
      if (active(e)) block(e);
    };
    const onUp = (e: PointerEvent | MouseEvent) => {
      if (!ours(e.target) && active(e)) block(e);
    };
    const onClick = (e: MouseEvent) => {
      if (ours(e.target) || !active(e)) return;
      block(e);
      pick(e.target instanceof Element ? e.target : null);
    };
    const onMove = (e: PointerEvent) => {
      if (!modeRef.current) return;
      if (ours(e.target) || !(e.target instanceof Element)) return setHover(null);
      setHover({ rect: e.target.getBoundingClientRect(), name: nameOf(e.target) });
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && e.shiftKey && e.code === "KeyC") {
        e.preventDefault();
        e.stopPropagation();
        if (modeRef.current) stop();
        else setMode(true);
        return;
      }
      if (e.key !== "Escape" || (!modeRef.current && !targetRef.current)) return;
      e.preventDefault();
      e.stopPropagation();
      if (targetRef.current) {
        setTarget(null);
        setDraft("");
      } else stop();
    };
    const opts = { capture: true } as const;
    window.addEventListener("pointerdown", onDown, opts);
    window.addEventListener("mousedown", onDown, opts);
    window.addEventListener("pointerup", onUp, opts);
    window.addEventListener("mouseup", onUp, opts);
    window.addEventListener("click", onClick, opts);
    window.addEventListener("pointermove", onMove, opts);
    window.addEventListener("keydown", onKey, opts);
    return () => {
      window.removeEventListener("pointerdown", onDown, opts);
      window.removeEventListener("mousedown", onDown, opts);
      window.removeEventListener("pointerup", onUp, opts);
      window.removeEventListener("mouseup", onUp, opts);
      window.removeEventListener("click", onClick, opts);
      window.removeEventListener("pointermove", onMove, opts);
      window.removeEventListener("keydown", onKey, opts);
    };
  }, [available, pick, stop]);

  // Numbered pins on the blocks of this page's open notes, kept in place as the page scrolls and changes.
  useEffect(() => {
    if (!available) return;
    const place = () =>
      setPins(
        notes
          .filter((n) => n.status === "open")
          .map((n) => {
            const el = find(n.target.selector);
            const r = el?.getBoundingClientRect();
            return r && r.width > 0 && r.height > 0 ? { id: n.id, n: n.n, x: Math.max(4, r.left - 10), y: Math.max(4, r.top - 10) } : null;
          })
          .filter((p): p is NonNullable<typeof p> => !!p),
      );
    place();
    const t = setInterval(place, 1500);
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      clearInterval(t);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [available, notes]);

  const save = async () => {
    if (!target || draft.trim().length < 2) return setMsg("Write what should change.");
    setBusy(true);
    try {
      const res = await fetch("/api/ui-notes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, url: window.location.href, comment: draft, target: target.t }) });
      const j = (await res.json().catch(() => null)) as { ok: boolean; note?: Note; error?: string } | null;
      if (!j?.ok || !j.note) return setMsg(j?.error ?? "The note could not be saved.");
      setTarget(null);
      setDraft("");
      setMsg(`Note ${j.note.n} saved. Click another block, or press Escape to stop.`);
      await load();
    } finally {
      setBusy(false);
    }
  };
  const patch = async (id: string, status: Note["status"]) => {
    await fetch("/api/ui-notes", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, status }) });
    await load();
  };
  const show = (n: Note) => {
    const el = find(n.target.selector);
    if (!el) return setMsg(`Note ${n.n}'s block is not on the page now (it may be in a window that is closed).`);
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    setTimeout(() => setHover({ rect: el.getBoundingClientRect(), name: `Note ${n.n}` }), 400);
    setTimeout(() => setHover(null), 2400);
  };

  if (!available) return null;

  // The comment box goes inside an open window when the block is in one, so the window keeps it usable.
  const host = target ? (target.el.closest('[role="dialog"]') ?? document.body) : null;
  const r = target?.el.getBoundingClientRect();
  const boxW = Math.min(360, window.innerWidth - 24);
  const below = r ? r.bottom + 12 + 230 < window.innerHeight : true;
  const boxStyle: CSSProperties = r
    ? { position: "fixed", zIndex: Z, pointerEvents: "auto", width: boxW, left: Math.min(Math.max(12, r.left), window.innerWidth - boxW - 12), top: below ? Math.min(r.bottom + 12, window.innerHeight - 240) : Math.max(12, r.top - 242), background: "var(--c-card)", color: "var(--c-fg)", border: `1px solid ${ORANGE}`, borderRadius: 12, padding: 14, boxShadow: "0 16px 40px rgba(0,0,0,0.5)", fontSize: 13, display: "flex", flexDirection: "column", gap: 8 }
    : {};
  const outline = (rect: DOMRect | undefined, label: string | null) =>
    rect ? (
      <>
        <div aria-hidden="true" style={{ position: "fixed", zIndex: Z - 1, pointerEvents: "none", left: rect.left - 2, top: rect.top - 2, width: rect.width + 4, height: rect.height + 4, border: `2px solid ${ORANGE}`, borderRadius: 6, background: "rgba(249,115,22,0.08)" }} />
        {label ? <div aria-hidden="true" style={{ position: "fixed", zIndex: Z - 1, pointerEvents: "none", left: Math.max(2, rect.left - 2), top: Math.max(2, rect.top - 24), maxWidth: 360, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis", padding: "2px 8px", borderRadius: 6, background: ORANGE, color: "#111", fontSize: 12, fontWeight: 600 }}>{label}</div> : null}
      </>
    ) : null;

  return createPortal(
    <div {...{ [OURS]: "" }} style={{ position: "relative", zIndex: Z }}>
      {outline(hover?.rect, hover?.name ?? null)}
      {target ? outline(r, null) : null}

      {pins.map((p) => (
        <button key={p.id} type="button" title={notes.find((x) => x.id === p.id)?.comment} aria-label={`Note ${p.n}`} onClick={() => setPanel("page")} style={{ position: "fixed", zIndex: Z, pointerEvents: "auto", left: p.x, top: p.y, width: 22, height: 22, borderRadius: 999, border: "2px solid #111", background: ORANGE, color: "#111", fontSize: 11, fontWeight: 700, cursor: "pointer", padding: 0, lineHeight: "18px" }}>
          {p.n}
        </button>
      ))}

      <div style={{ position: "fixed", left: 16, bottom: 16, zIndex: Z, pointerEvents: "auto", display: "flex", gap: 6, alignItems: "center" }}>
        <button type="button" aria-pressed={mode} title="Comment on any block (Alt+Shift+C). Alt+click comments on a block at any time." onClick={() => (mode ? stop() : setMode(true))} style={{ ...btn(mode), minHeight: 36, borderRadius: 999, padding: "0 14px", background: mode ? ORANGE : "var(--c-card)", color: mode ? "#111" : "var(--c-fg)", fontWeight: 600, boxShadow: "0 6px 18px rgba(0,0,0,0.35)" }}>
          {mode ? "Commenting · Esc to stop" : "Comment"}
        </button>
        <button type="button" aria-expanded={!!panel} title="The notes left on this page, and on every page" onClick={() => setPanel(panel ? null : "page")} style={{ ...btn(), minHeight: 36, borderRadius: 999, background: "var(--c-card)", boxShadow: "0 6px 18px rgba(0,0,0,0.35)" }}>
          Notes {open ? <span style={{ marginLeft: 4, padding: "0 7px", borderRadius: 999, background: ORANGE, color: "#111", fontWeight: 700 }}>{open}</span> : null}
        </button>
        {msg && !target ? (
          <span role="status" style={{ padding: "6px 10px", borderRadius: 8, background: "var(--c-card)", border: "1px solid var(--c-line-strong)", maxWidth: 360 }}>
            {msg}
          </span>
        ) : null}
      </div>

      {panel ? (
        <div role="region" aria-label="UI notes" style={panelStyle}>
          <div style={{ display: "flex", gap: 6, padding: 10, borderBottom: "1px solid var(--c-line)", position: "sticky", top: 0, background: "var(--c-card)" }}>
            <button type="button" aria-pressed={panel === "page"} onClick={() => setPanel("page")} style={btn(panel === "page")}>
              This page ({notes.filter((n) => n.status === "open").length})
            </button>
            <button type="button" aria-pressed={panel === "all"} onClick={() => setPanel("all")} style={btn(panel === "all")}>
              All pages ({open})
            </button>
            <button type="button" aria-label="Close" onClick={() => setPanel(null)} style={{ ...btn(), marginLeft: "auto" }}>
              ✕
            </button>
          </div>
          {panel === "page" ? (
            notes.length ? (
              notes
                .slice()
                .sort((a, b) => Number(a.status !== "open") - Number(b.status !== "open") || b.n - a.n)
                .map((n) => (
                  <div key={n.id} style={{ padding: "10px 12px", borderBottom: "1px solid var(--c-line)", display: "flex", flexDirection: "column", gap: 6, opacity: n.status === "open" ? 1 : 0.7 }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                      <strong style={{ color: ORANGE }}>#{n.n}</strong>
                      <span style={{ color: "var(--c-mut)" }}>
                        {n.by.displayName} · {when(n.createdAt)} · {n.status === "open" ? "open" : "done"}
                      </span>
                    </div>
                    <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{n.comment}</div>
                    <div style={{ color: "var(--c-mut)", fontSize: 12, overflowWrap: "anywhere" }}>On: {n.target.tag}{n.target.text ? ` “${n.target.text.slice(0, 60)}”` : ""}{n.target.dialog ? ` · in “${n.target.dialog}”` : ""}</div>
                    {n.reply ? <div style={{ padding: "6px 8px", borderRadius: 8, background: "var(--c-tint-teal)", overflowWrap: "anywhere" }}>{n.reply}</div> : null}
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      <button type="button" onClick={() => show(n)} style={btn()}>
                        Show
                      </button>
                      {n.shot.file ? (
                        <a href={`/api/ui-notes/shot?id=${n.id}`} target="_blank" rel="noopener" style={{ ...btn(), display: "inline-flex", alignItems: "center", textDecoration: "none" }}>
                          Picture
                        </a>
                      ) : (
                        <span style={{ color: "var(--c-mut)", alignSelf: "center", fontSize: 12 }}>{n.shot.pending ? "Taking the picture…" : (n.shot.note ?? "No picture")}</span>
                      )}
                      {n.status === "open" ? (
                        <button type="button" onClick={() => void patch(n.id, "done")} style={btn()}>
                          Mark done
                        </button>
                      ) : (
                        <button type="button" onClick={() => void patch(n.id, "open")} style={btn()}>
                          Reopen
                        </button>
                      )}
                      <button type="button" onClick={() => void patch(n.id, "dismissed")} style={btn()}>
                        Remove
                      </button>
                    </div>
                  </div>
                ))
            ) : (
              <p style={{ margin: 0, padding: 14, color: "var(--c-mut)" }}>No notes on this page yet. Press Comment, then click the block you want changed.</p>
            )
          ) : all.length ? (
            all
              .slice()
              .sort((a, b) => Number(a.status !== "open") - Number(b.status !== "open") || b.n - a.n)
              .map((n) => (
                <a key={n.id} href={n.path} style={{ display: "block", padding: "10px 12px", borderBottom: "1px solid var(--c-line)", color: "var(--c-fg)", textDecoration: "none", opacity: n.status === "open" ? 1 : 0.7 }}>
                  <strong style={{ color: ORANGE }}>#{n.n}</strong> <span style={{ color: "var(--c-mut)" }}>{n.path} · {n.status}</span>
                  <div style={{ overflowWrap: "anywhere" }}>{n.comment.slice(0, 160)}</div>
                </a>
              ))
          ) : (
            <p style={{ margin: 0, padding: 14, color: "var(--c-mut)" }}>No notes yet.</p>
          )}
        </div>
      ) : null}

      {target && host
        ? createPortal(
            <div {...{ [OURS]: "" }} role="group" aria-label="Comment on this block" style={boxStyle}>
              <div style={{ color: "var(--c-mut)", fontSize: 12, overflowWrap: "anywhere" }}>Comment on {nameOf(target.el)}</div>
              <label htmlFor="ui-note-text" style={{ fontWeight: 600 }}>
                What should change here?
              </label>
              <textarea
                id="ui-note-text"
                ref={boxRef}
                value={draft}
                rows={4}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") void save();
                }}
                placeholder="e.g. Move this button to the right and make it smaller"
                style={{ width: "100%", boxSizing: "border-box", padding: 8, borderRadius: 8, border: "1px solid var(--c-line-strong)", background: "var(--c-inner)", color: "var(--c-fg)", font: "inherit", fontSize: 13, resize: "vertical" }}
              />
              {msg ? <div style={{ color: "var(--c-red)", fontSize: 12 }}>{msg}</div> : null}
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <button type="button" title="Comment on the block around this one instead" onClick={() => pick(target.el.parentElement)} style={btn()}>
                  Wider block
                </button>
                <span style={{ flex: 1 }} />
                <button
                  type="button"
                  onClick={() => {
                    setTarget(null);
                    setDraft("");
                    setMsg(null);
                  }}
                  style={btn()}
                >
                  Cancel
                </button>
                <button type="button" onClick={() => void save()} disabled={busy} style={btn(true)}>
                  {busy ? "Saving…" : "Save note"}
                </button>
              </div>
              <div style={{ color: "var(--c-mut)", fontSize: 11 }}>Ctrl+Enter saves · Escape cancels · kept on this server only</div>
            </div>,
            host,
          )
        : null}
    </div>,
    document.body,
  );
}
