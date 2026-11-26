import fs from "node:fs";
import path from "node:path";
import { consentUrl, exchangeCode, gmailSettings, readToken, writeToken } from "./oauth";

/**
 * Connecting the Gmail account, in two steps that work whichever computer the browser is on:
 *  1. start(): a Google sign-in link (asking to create, change and send drafts, and to read the inbox for replies when
 *     gmail.readReplies is on). Its state is kept on this server.
 *  2. finish(pasted): after signing in, Google sends the browser to http://localhost/?code=… (the page itself will not
 *     load; that is expected). The officer pastes that address; the code in it is exchanged for a token kept in
 *     gmail.tokenFile. The token is never shown.
 */

const REDIRECT = "http://localhost";
const pendingFile = () => path.join(path.dirname(gmailSettings().tokenFile), "gmail-pending.json");

export function startGmailConnect(): { url: string } {
  const c = consentUrl(REDIRECT);
  const f = pendingFile();
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  fs.writeFileSync(/*turbopackIgnore: true*/ f, JSON.stringify({ verifier: c.verifier, state: c.state, at: Date.now() }), { mode: 0o600 });
  return { url: c.url };
}

export async function finishGmailConnect(pasted: string): Promise<{ account: string }> {
  let pending: { verifier: string; state: string; at: number };
  try {
    pending = JSON.parse(fs.readFileSync(/*turbopackIgnore: true*/ pendingFile(), "utf8")) as typeof pending;
  } catch {
    throw new Error("Start the connection first (get the Google sign-in link), then paste the address.");
  }
  if (Date.now() - pending.at > 30 * 60 * 1000) throw new Error("The sign-in link is more than 30 minutes old. Get a new link and sign in again.");
  const text = pasted.trim();
  let code = text;
  if (/^https?:\/\//i.test(text) || text.includes("code=")) {
    const u = new URL(/^https?:\/\//i.test(text) ? text : `http://localhost/?${text.replace(/^.*?\?/, "")}`);
    const err = u.searchParams.get("error");
    if (err) throw new Error(err === "access_denied" ? "Access was not allowed on the Google page. Sign in again and choose Allow." : `Google answered: ${err}.`);
    if (u.searchParams.get("state") !== pending.state) throw new Error("That address is from a different sign-in link. Use the address from the latest link.");
    code = u.searchParams.get("code") ?? "";
  }
  if (!code) throw new Error("No code found. Paste the whole address from the browser's address bar after signing in.");
  const t = await exchangeCode(code, REDIRECT, pending.verifier);
  if (!t.refresh_token) throw new Error("Google did not give a lasting permission. Remove T-CYBER's access at myaccount.google.com/permissions, then connect again.");
  const s = gmailSettings();
  let account = s.account ?? "";
  let res: Response | null = null;
  try {
    res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", { headers: { Authorization: `Bearer ${t.access_token}` }, signal: AbortSignal.timeout(20_000) });
  } catch {
    /* no answer from Gmail: the configured account name is used */
  }
  if (res?.ok) account = ((await res.json()) as { emailAddress: string }).emailAddress;
  else if (res?.status === 403) {
    // Signed in, but the Gmail API is off in the Cloud project: saying "connected" now would only fail on every draft.
    const why = ((await res.json().catch(() => null)) as { error?: { message?: string } } | null)?.error?.message ?? "";
    throw new Error(
      /has not been used|disabled|SERVICE_DISABLED/i.test(why)
        ? "Google signed you in, but the Gmail API is switched off in the Google Cloud project. Turn it on (Google Cloud console → APIs & Services → Library → Gmail API → Enable), wait a minute, then connect again."
        : `Google signed you in, but Gmail refused access: ${why || "no reason given"}. Connect again and tick the Gmail permission on the Google page.`,
    );
  }
  // Connecting the same account again (to grant another permission) keeps when the link began.
  const before = readToken(s);
  const connectedAt = before && before.account.toLowerCase() === account.toLowerCase() ? before.connectedAt : new Date().toISOString();
  writeToken({ refresh_token: t.refresh_token, account, connectedAt, ...(t.scope ? { scope: t.scope } : {}) }, s);
  fs.rmSync(pendingFile(), { force: true });
  return { account };
}

export function disconnectGmail() {
  fs.rmSync(gmailSettings().tokenFile, { force: true });
}
