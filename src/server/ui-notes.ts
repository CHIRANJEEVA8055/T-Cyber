import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

/**
 * Comment mode (development only): notes an officer pins on any block of the running app, for the developer to act
 * on. Kept in data/ui-notes (never committed, never sent anywhere): notes.json, and a picture of each block taken on
 * this server. The block is described well enough to find it in the code: the page, a CSS path, its text, its
 * nearest heading and window, its size and a trimmed copy of its HTML.
 */

export const uiNotesEnabled = () => process.env.NODE_ENV === "development" || process.env.T_CYBER_UI_NOTES === "1";

export interface UiNoteTarget {
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

export interface UiNote {
  id: string;
  n: number;
  createdAt: string;
  updatedAt: string;
  by: { username: string; displayName: string };
  path: string;
  url: string;
  comment: string;
  status: "open" | "done" | "dismissed";
  /** What the developer did about it (or why not), shown under the note. */
  reply: string | null;
  target: UiNoteTarget;
  shot: { file: string | null; kind: "block" | "page" | null; note: string | null; pending: boolean };
}

const dir = () => path.resolve(/*turbopackIgnore: true*/ process.cwd(), "data", "ui-notes");
const file = () => path.join(dir(), "notes.json");
export const shotPath = (id: string) => path.join(dir(), `${id.replace(/[^\w-]/g, "")}.png`);

function readAll(): UiNote[] {
  try {
    return JSON.parse(fs.readFileSync(/*turbopackIgnore: true*/ file(), "utf8")) as UiNote[];
  } catch {
    return [];
  }
}

// One change at a time, written whole and renamed into place, so the file is never half-written.
let queue: Promise<unknown> = Promise.resolve();
function change<T>(fn: (notes: UiNote[]) => T): Promise<T> {
  const run = queue.then(() => {
    fs.mkdirSync(dir(), { recursive: true, mode: 0o700 });
    const notes = readAll();
    const out = fn(notes);
    const tmp = `${file()}.${process.pid}.tmp`;
    fs.writeFileSync(/*turbopackIgnore: true*/ tmp, JSON.stringify(notes, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file());
    return out;
  });
  queue = run.catch(() => undefined);
  return run;
}

export function listUiNotes(): UiNote[] {
  return readAll().filter((n) => n.status !== "dismissed");
}

const clip = (s: unknown, n: number) => (typeof s === "string" ? s.slice(0, n) : "");

export async function addUiNote(by: UiNote["by"], input: { path: string; url: string; comment: string; target: UiNoteTarget }): Promise<UiNote> {
  const comment = input.comment.trim();
  if (comment.length < 2) throw new Error("Write what should change.");
  const t = input.target;
  const now = new Date().toISOString();
  const note = await change((notes) => {
    const n: UiNote = {
      id: crypto.randomBytes(8).toString("hex"),
      n: Math.max(0, ...notes.map((x) => x.n)) + 1,
      createdAt: now,
      updatedAt: now,
      by,
      path: clip(input.path, 300) || "/",
      url: clip(input.url, 600),
      comment: comment.slice(0, 4000),
      status: "open",
      reply: null,
      target: {
        selector: clip(t.selector, 1200),
        tag: clip(t.tag, 20),
        role: t.role ? clip(t.role, 40) : null,
        label: t.label ? clip(t.label, 200) : null,
        classes: Array.isArray(t.classes) ? t.classes.slice(0, 10).map((c) => clip(c, 60)) : [],
        text: clip(t.text, 400),
        html: clip(t.html, 3000),
        heading: t.heading ? clip(t.heading, 200) : null,
        dialog: t.dialog ? clip(t.dialog, 200) : null,
        rect: { x: Number(t.rect?.x) || 0, y: Number(t.rect?.y) || 0, w: Number(t.rect?.w) || 0, h: Number(t.rect?.h) || 0 },
        viewport: { w: Math.min(Math.max(Number(t.viewport?.w) || 1440, 320), 2560), h: Math.min(Math.max(Number(t.viewport?.h) || 900, 480), 1600) },
        theme: t.theme === "light" ? "light" : "dark",
      },
      shot: { file: null, kind: null, note: null, pending: true },
    };
    notes.push(n);
    return n;
  });
  return note;
}

export async function updateUiNote(id: string, patch: Partial<Pick<UiNote, "status" | "comment" | "reply">>): Promise<UiNote | null> {
  return change((notes) => {
    const n = notes.find((x) => x.id === id);
    if (!n) return null;
    if (patch.status && ["open", "done", "dismissed"].includes(patch.status)) n.status = patch.status;
    if (typeof patch.comment === "string" && patch.comment.trim().length >= 2) n.comment = patch.comment.trim().slice(0, 4000);
    if (patch.reply !== undefined) n.reply = patch.reply ? patch.reply.slice(0, 2000) : null;
    n.updatedAt = new Date().toISOString();
    return n;
  });
}

// Pictures are taken one at a time, in a separate process (a headless browser on this server, never online).
let shots: Promise<unknown> = Promise.resolve();
export function takeShot(note: UiNote, sessionToken: string, theme: string | null) {
  shots = shots
    .then(
      () =>
        new Promise<void>((resolve) => {
          const out = shotPath(note.id);
          const child = spawn(process.execPath, [path.resolve(/*turbopackIgnore: true*/ process.cwd(), "scripts", "ui-note-shot.mjs")], {
            cwd: process.cwd(),
            env: { NODE_ENV: "production", PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", UI_NOTE_TOKEN: sessionToken, UI_NOTE_THEME: theme ?? "", UI_NOTE_OUT: out, UI_NOTE_BASE: `http://127.0.0.1:${process.env.PORT ?? 3000}`, UI_NOTE_JSON: JSON.stringify({ path: note.path, url: note.url, target: note.target }) },
            stdio: ["ignore", "pipe", "ignore"],
          });
          let stdout = "";
          child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
          const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
          child.on("close", () => {
            clearTimeout(timer);
            let r: { ok?: boolean; kind?: "block" | "page"; note?: string } = {};
            try {
              r = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as typeof r;
            } catch {
              /* no answer: recorded as not taken */
            }
            void change((notes) => {
              const n = notes.find((x) => x.id === note.id);
              if (n) n.shot = { file: r.ok ? path.basename(out) : null, kind: r.ok ? (r.kind ?? "page") : null, note: r.note ?? (r.ok ? null : "The picture could not be taken."), pending: false };
            }).finally(resolve);
          });
        }),
    )
    .catch(() => undefined);
}
