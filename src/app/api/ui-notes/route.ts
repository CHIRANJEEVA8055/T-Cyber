import { cookies } from "next/headers";
import { getCurrentUser } from "@/server/auth/current-user";
import { isSameOrigin } from "@/server/auth/origin";
import { SESSION_COOKIE } from "@/server/auth/session";
import { THEME_COOKIE } from "@/lib/preferences";
import { addUiNote, listUiNotes, takeShot, uiNotesEnabled, updateUiNote, type UiNoteTarget } from "@/server/ui-notes";

/**
 * Comment mode (development only): the notes an officer pins on blocks of the app. Signed-in users only; in a
 * production build these answer "not found".
 */
const notFound = () => Response.json({ ok: false, error: "Not found." }, { status: 404 });
const signedOut = () => Response.json({ ok: false, error: "Sign in to leave notes." }, { status: 401 });

export async function GET(request: Request) {
  if (!uiNotesEnabled()) return notFound();
  if (!(await getCurrentUser())) return signedOut();
  const path = new URL(request.url).searchParams.get("path") ?? "";
  const all = listUiNotes();
  return Response.json({ ok: true, notes: all.filter((n) => !path || n.path === path), open: all.filter((n) => n.status === "open").length, all: all.map((n) => ({ id: n.id, n: n.n, path: n.path, comment: n.comment, status: n.status })) });
}

export async function POST(request: Request) {
  if (!uiNotesEnabled()) return notFound();
  if (!isSameOrigin(request)) return Response.json({ ok: false, error: "Rejected: not from this application." }, { status: 403 });
  const user = await getCurrentUser();
  if (!user) return signedOut();
  try {
    const body = (await request.json()) as { path: string; url: string; comment: string; target: UiNoteTarget };
    const note = await addUiNote({ username: user.username, displayName: user.displayName }, { path: String(body.path ?? ""), url: String(body.url ?? ""), comment: String(body.comment ?? ""), target: body.target });
    const store = await cookies();
    const token = store.get(SESSION_COOKIE)?.value;
    if (token) takeShot(note, token, store.get(THEME_COOKIE)?.value ?? null);
    return Response.json({ ok: true, note });
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : "The note could not be saved." }, { status: 400 });
  }
}

export async function PATCH(request: Request) {
  if (!uiNotesEnabled()) return notFound();
  if (!isSameOrigin(request)) return Response.json({ ok: false, error: "Rejected: not from this application." }, { status: 403 });
  if (!(await getCurrentUser())) return signedOut();
  const body = (await request.json().catch(() => ({}))) as { id?: string; status?: "open" | "done" | "dismissed"; comment?: string };
  if (!body.id) return Response.json({ ok: false, error: "Which note?" }, { status: 400 });
  const note = await updateUiNote(body.id, { status: body.status, comment: body.comment });
  return note ? Response.json({ ok: true, note }) : notFound();
}
