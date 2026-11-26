import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getAppConfig } from "../config";

/**
 * Google OAuth for the one Gmail account linked in the configuration (installed-app client, PKCE). The client file
 * and the token live in files under data/ (never committed); their contents are never logged or shown. Two
 * permissions are asked for: "compose" (create, change and send drafts) and, when gmail.readReplies is on,
 * "read only" (to find the replies to requests in the inbox; nothing in the mailbox is changed or deleted).
 */

export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.compose";
export const GMAIL_READ_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const READ_SCOPES = [GMAIL_READ_SCOPE, "https://www.googleapis.com/auth/gmail.modify", "https://mail.google.com/"];

export interface GmailSettings {
  enabled: boolean;
  account: string | null;
  credentialsFile: string;
  tokenFile: string;
  syncSeconds: number;
  senderApproves: boolean;
  readReplies: boolean;
}

export function gmailSettings(): GmailSettings {
  const g = getAppConfig().gmail;
  const abs = (f: string) => path.resolve(/*turbopackIgnore: true*/ process.cwd(), f);
  return { enabled: g.enabled, account: g.account ?? null, credentialsFile: abs(g.credentialsFile), tokenFile: abs(g.tokenFile), syncSeconds: g.syncSeconds, senderApproves: g.senderApproves ?? false, readReplies: g.readReplies ?? true };
}

/** The permissions a new connection asks for. */
export const scopesFor = (s: GmailSettings = gmailSettings()) => (s.readReplies ? [GMAIL_SCOPE, GMAIL_READ_SCOPE] : [GMAIL_SCOPE]);
/** Whether the permission Google granted lets T-CYBER read the inbox (null: not known until the next token refresh). */
export function canReadInbox(t: StoredToken | null = readToken()): boolean | null {
  if (!t) return false;
  if (t.scope === undefined) return null;
  return t.scope.split(/\s+/).some((x) => READ_SCOPES.includes(x));
}

interface ClientFile {
  client_id: string;
  client_secret: string;
  auth_uri: string;
  token_uri: string;
}

export function readClient(s: GmailSettings = gmailSettings()): ClientFile {
  let json: { installed?: ClientFile; web?: ClientFile };
  try {
    json = JSON.parse(fs.readFileSync(/*turbopackIgnore: true*/ s.credentialsFile, "utf8")) as typeof json;
  } catch {
    throw new Error(`The Google OAuth client file is missing or unreadable at ${s.credentialsFile}.`);
  }
  const c = json.installed ?? json.web;
  if (!c?.client_id || !c.client_secret) throw new Error("The Google OAuth client file has no client id or secret.");
  return { client_id: c.client_id, client_secret: c.client_secret, auth_uri: c.auth_uri || "https://accounts.google.com/o/oauth2/auth", token_uri: c.token_uri || "https://oauth2.googleapis.com/token" };
}

export interface StoredToken {
  refresh_token: string;
  account: string;
  connectedAt: string;
  /** The permissions Google granted, space-separated (absent on links made before it was kept). */
  scope?: string;
}

export function readToken(s: GmailSettings = gmailSettings()): StoredToken | null {
  try {
    const t = JSON.parse(fs.readFileSync(/*turbopackIgnore: true*/ s.tokenFile, "utf8")) as StoredToken;
    return t.refresh_token ? t : null;
  } catch {
    return null;
  }
}

export function writeToken(t: StoredToken, s: GmailSettings = gmailSettings()) {
  fs.mkdirSync(path.dirname(s.tokenFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(/*turbopackIgnore: true*/ s.tokenFile, JSON.stringify(t), { mode: 0o600 });
  fs.chmodSync(s.tokenFile, 0o600);
}

/** A consent link for the installed-app flow, with PKCE. */
export function consentUrl(redirectUri: string, s: GmailSettings = gmailSettings()) {
  const c = readClient(s);
  const verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const state = crypto.randomBytes(16).toString("hex");
  const url = new URL(c.auth_uri);
  url.search = new URLSearchParams({
    client_id: c.client_id,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: scopesFor(s).join(" "),
    access_type: "offline",
    prompt: "consent",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    ...(s.account ? { login_hint: s.account } : {}),
  }).toString();
  return { url: url.toString(), verifier, state };
}

async function tokenCall(body: Record<string, string>, s: GmailSettings) {
  const c = readClient(s);
  const res = await fetch(c.token_uri, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: c.client_id, client_secret: c.client_secret, ...body }).toString() });
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string; error_description?: string };
  if (json.error === "invalid_grant") {
    // A refresh refused: the permission expired (Google ends it after 7 days while the Cloud project is in Testing) or was removed.
    throw new Error(
      body.grant_type === "refresh_token"
        ? "Google has ended T-CYBER's access to Gmail (the permission expired or was removed). A supervisor connects it again in Settings → Integrations → Gmail."
        : "That sign-in address was already used or is too old. Get a new sign-in link and sign in again.",
    );
  }
  if (!res.ok || !json.access_token) throw new Error(`Google refused the sign-in: ${json.error_description ?? json.error ?? `status ${res.status}`}.`);
  return json;
}

export async function exchangeCode(code: string, redirectUri: string, verifier: string, s: GmailSettings = gmailSettings()) {
  return tokenCall({ grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier }, s);
}

let cached: { token: string; until: number; refresh: string } | null = null;

/** A current access token for the linked account (refreshed when it is close to expiring). */
export async function accessToken(s: GmailSettings = gmailSettings()): Promise<string> {
  const stored = readToken(s);
  if (!stored) throw new Error("Gmail is not connected yet. A supervisor connects it in Settings → Integrations → Gmail.");
  if (cached && cached.refresh === stored.refresh_token && cached.until > Date.now() + 60_000) return cached.token;
  const t = await tokenCall({ grant_type: "refresh_token", refresh_token: stored.refresh_token }, s);
  cached = { token: t.access_token!, until: Date.now() + (t.expires_in ?? 3600) * 1000, refresh: stored.refresh_token };
  // Keep what Google granted, so the settings page and the reply reader know whether the inbox may be read.
  if (t.scope && t.scope !== stored.scope) {
    try {
      writeToken({ ...stored, scope: t.scope }, s);
    } catch {
      /* the token still works; only the note of its permissions is not kept */
    }
  }
  return cached.token;
}

/** For the settings page: switched on, connected, and to which account. Never includes a secret. */
export function gmailStatus(): { enabled: boolean; account: string | null; connected: boolean; connectedAs: string | null; clientFile: boolean; note: string; readReplies: boolean; canRead: boolean | null } {
  const s = gmailSettings();
  const clientFile = fs.existsSync(/*turbopackIgnore: true*/ s.credentialsFile);
  const t = readToken(s);
  const note = !s.enabled
    ? "Switched off in the configuration (gmail.enabled)."
    : !clientFile
      ? `The Google OAuth client file is not at ${s.credentialsFile}.`
      : !t
        ? "Not connected yet: a supervisor connects it in Settings → Integrations → Gmail (or runs `npm run gmail:connect` on the server)."
        : s.account && t.account.toLowerCase() !== s.account.toLowerCase()
          ? `Connected as ${t.account}, but the configuration names ${s.account}. Connect again with the right account.`
          : `Connected as ${t.account} since ${t.connectedAt.slice(0, 10)}.`;
  return { enabled: s.enabled, account: s.account, connected: !!t, connectedAs: t?.account ?? null, clientFile, note, readReplies: s.readReplies, canRead: canReadInbox(t) };
}
