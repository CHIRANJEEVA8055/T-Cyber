import { getDb } from "../db";
import { gmailSettings, readToken } from "./oauth";
import { isGmailRateLimit, syncAllWithGmail, syncRequestWithGmail } from "./sync";
import { readGmailReplies } from "./replies";
import { commitIdleMailDrafts } from "../services/mail-window";

/**
 * Runs the Gmail sync in the background of the T-CYBER server: every gmail.syncSeconds, and straight after an edit in
 * T-CYBER (kickGmailSync). Does nothing while the link is switched off or not connected. One pass at a time.
 */

const g = globalThis as unknown as { __tcyberGmail?: { timer: NodeJS.Timeout; busy: boolean; last: { at: string; result: string } | null; replies: { at: string; result: string; note: string | null } | null } };

function ready() {
  // Tests and offline runs never reach Google.
  if (process.env.T_CYBER_DISABLE_NETWORK === "1") return false;
  const s = gmailSettings();
  return s.enabled && !!readToken(s);
}

async function pass() {
  const st = g.__tcyberGmail;
  if (!st || st.busy || !ready()) return;
  st.busy = true;
  try {
    // Mail windows left open or closed without saying so: what was typed becomes a version first.
    await commitIdleMailDrafts(getDb()).catch(() => 0);
    const r = await syncAllWithGmail(getDb());
    st.last = { at: new Date().toISOString(), result: Object.entries(r).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(", ") || "nothing to do" };
  } catch (err) {
    st.last = { at: new Date().toISOString(), result: `failed: ${(err as Error).message}` };
  }
  // Replies in the inbox, linked to the requests they answer (see replies.ts).
  try {
    if (gmailSettings().readReplies) {
      const r = await readGmailReplies(getDb());
      st.replies = { at: new Date().toISOString(), result: r.looked ? `looked at ${r.looked}: linked ${r.linked}, for an officer ${r.queued}, not about a case ${r.skipped}${r.failed ? `, failed ${r.failed}` : ""}` : "nothing new", note: r.note };
    }
  } catch (err) {
    st.replies = { at: new Date().toISOString(), result: `failed: ${(err as Error).message}`, note: null };
  } finally {
    st.busy = false;
  }
}

export function startGmailRunner() {
  if (g.__tcyberGmail) clearInterval(g.__tcyberGmail.timer);
  const seconds = gmailSettings().syncSeconds;
  g.__tcyberGmail = { timer: setInterval(() => void pass(), seconds * 1000), busy: false, last: g.__tcyberGmail?.last ?? null, replies: g.__tcyberGmail?.replies ?? null };
  g.__tcyberGmail.timer.unref?.();
  setTimeout(() => void pass(), 5000).unref?.();
}

/** After an edit in T-CYBER: carry it to Gmail now rather than at the next pass. Never throws. */
export function kickGmailSync(requestId: string) {
  if (!ready()) return;
  void syncRequestWithGmail(getDb(), requestId).catch(async (err) => {
    // Gmail asking to slow down is not the draft's fault: the next pass carries it.
    if (isGmailRateLimit(err)) return;
    await getDb().request.update({ where: { id: requestId }, data: { gmailError: (err as Error).message.slice(0, 300) } }).catch(() => undefined);
  });
}

export function gmailRunnerState() {
  return g.__tcyberGmail ? { running: true, last: g.__tcyberGmail.last, replies: g.__tcyberGmail.replies } : { running: false, last: null, replies: null };
}

/** Reads the inbox for replies now (the officer pressed "Check for replies"). One pass at a time. */
export async function checkRepliesNow() {
  const st = g.__tcyberGmail;
  if (st?.busy) return { busy: true as const };
  if (st) st.busy = true;
  try {
    const r = await readGmailReplies(getDb());
    if (st) st.replies = { at: new Date().toISOString(), result: r.looked ? `looked at ${r.looked}: linked ${r.linked}, for an officer ${r.queued}, not about a case ${r.skipped}${r.failed ? `, failed ${r.failed}` : ""}` : "nothing new", note: r.note };
    return { busy: false as const, ...r };
  } finally {
    if (st) st.busy = false;
  }
}
