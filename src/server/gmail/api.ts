import { accessToken } from "./oauth";

/**
 * The Gmail API calls T-CYBER uses: under the "compose" permission, create, read back, change, send and delete
 * drafts and read the account's address; under "read only", list the inbox and read a message and its attachments
 * (to find replies to requests). Nothing in the mailbox is changed or deleted except T-CYBER's own drafts. Behind an
 * interface so the sync and the reply reader can be tested without the network.
 */

/** A message's headers, enough to tell whether it is a reply to a request (its content is fetched only then). */
export interface MessageMeta {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  date: number;
  inReplyTo: string;
  references: string;
  /** Gmail's label ids (INBOX, SENT, SPAM …). */
  labels: string[];
}
export interface MessageFull extends MessageMeta {
  text: string;
  attachments: { attachmentId: string; fileName: string; mimeType: string; size: number }[];
}

export interface RemoteDraft {
  draftId: string;
  messageId: string;
  /** When Gmail last saved the draft (ms since the epoch). */
  savedAt: number;
  to: string;
  subject: string;
  text: string;
}

export interface GmailApi {
  createDraft(raw: string): Promise<{ draftId: string; messageId: string }>;
  updateDraft(draftId: string, raw: string): Promise<{ draftId: string; messageId: string }>;
  /** Null when the draft is no longer in Drafts (sent or deleted in Gmail). */
  getDraft(draftId: string): Promise<RemoteDraft | null>;
  sendDraft(draftId: string): Promise<{ messageId: string; threadId: string }>;
  profile(): Promise<{ emailAddress: string }>;
  /** Removes one of T-CYBER's own drafts (a mail the officer discarded). False when it was already gone. */
  deleteDraft?(draftId: string): Promise<boolean>;
  /** Message ids matching a Gmail search, newest first (read permission). */
  listMessages?(q: string, max: number): Promise<{ id: string; threadId: string }[]>;
  getMessageMeta?(id: string): Promise<MessageMeta | null>;
  getMessage?(id: string): Promise<MessageFull | null>;
  getAttachment?(messageId: string, attachmentId: string): Promise<Buffer>;
}

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

async function call<T>(path: string, init: RequestInit = {}): Promise<{ status: number; json: T }> {
  const token = await accessToken();
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) }, signal: AbortSignal.timeout(30_000) });
  const json = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!res.ok && res.status !== 404) throw new Error(`Gmail answered ${res.status}: ${json.error?.message ?? "no reason given"}.`);
  return { status: res.status, json };
}

type Part = { mimeType?: string; filename?: string; body?: { data?: string; attachmentId?: string; size?: number }; parts?: Part[]; headers?: { name: string; value: string }[] };
type GMessage = { id: string; threadId: string; internalDate?: string; labelIds?: string[]; payload: Part };
const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const decode = (d?: string) => (d ? Buffer.from(d, "base64url").toString("utf8") : "");

/** The plain-text body of a Gmail message (the text/plain part, else the HTML part with its tags removed). */
function textOf(p: Part): string {
  const find = (x: Part, type: string): Part | null => (x.mimeType === type && x.body?.data ? x : (x.parts ?? []).map((c) => find(c, type)).find(Boolean) ?? null);
  const plain = find(p, "text/plain");
  if (plain) return decode(plain.body!.data).replace(/\r\n/g, "\n");
  const html = find(p, "text/html");
  return html
    ? decode(html.body!.data)
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(?:div|p)>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
    : "";
}

const header = (p: Part, name: string) => p.headers?.find((x) => x.name.toLowerCase() === name)?.value ?? "";
function metaOf(m: GMessage): MessageMeta {
  return { id: m.id, threadId: m.threadId, from: header(m.payload, "from"), to: header(m.payload, "to"), subject: header(m.payload, "subject"), date: Number(m.internalDate ?? 0), inReplyTo: header(m.payload, "in-reply-to"), references: header(m.payload, "references"), labels: m.labelIds ?? [] };
}
/** Every part that is a file (has a name and an attachment id), however deep. */
function filesOf(p: Part, out: MessageFull["attachments"] = []): MessageFull["attachments"] {
  if (p.filename && p.body?.attachmentId) out.push({ attachmentId: p.body.attachmentId, fileName: p.filename, mimeType: p.mimeType ?? "application/octet-stream", size: p.body.size ?? 0 });
  for (const c of p.parts ?? []) filesOf(c, out);
  return out;
}

/** A large message (big attachments) goes through Gmail's upload address, which takes up to 35 MB. */
const UPLOAD_ABOVE = 4 * 1024 * 1024;
async function upload(method: "POST" | "PUT", path: string, raw: string): Promise<{ status: number; json: { id: string; message: { id: string } } }> {
  const token = await accessToken();
  const res = await fetch(`https://gmail.googleapis.com/upload/gmail/v1/users/me${path}?uploadType=media`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "message/rfc822" }, body: raw, signal: AbortSignal.timeout(120_000) });
  const json = (await res.json().catch(() => ({}))) as { id: string; message: { id: string }; error?: { message?: string } };
  if (!res.ok && res.status !== 404) throw new Error(`Gmail answered ${res.status}: ${json.error?.message ?? "no reason given"}.`);
  return { status: res.status, json };
}

export const liveGmail: GmailApi = {
  async createDraft(raw) {
    const { json } = raw.length > UPLOAD_ABOVE ? await upload("POST", "/drafts", raw) : await call<{ id: string; message: { id: string } }>("/drafts", { method: "POST", body: JSON.stringify({ message: { raw: b64url(raw) } }) });
    return { draftId: json.id, messageId: json.message.id };
  },
  async updateDraft(draftId, raw) {
    const { status, json } =
      raw.length > UPLOAD_ABOVE
        ? await upload("PUT", `/drafts/${encodeURIComponent(draftId)}`, raw)
        : await call<{ id: string; message: { id: string } }>(`/drafts/${encodeURIComponent(draftId)}`, { method: "PUT", body: JSON.stringify({ id: draftId, message: { raw: b64url(raw) } }) });
    if (status === 404) throw new Error("The Gmail draft is no longer in Drafts.");
    return { draftId: json.id, messageId: json.message.id };
  },
  async getDraft(draftId) {
    const { status, json } = await call<{ id: string; message: { id: string; internalDate?: string; payload: Part } }>(`/drafts/${encodeURIComponent(draftId)}?format=full`);
    if (status === 404) return null;
    const h = (n: string) => json.message.payload.headers?.find((x) => x.name.toLowerCase() === n)?.value ?? "";
    return { draftId: json.id, messageId: json.message.id, savedAt: Number(json.message.internalDate ?? 0), to: h("to"), subject: h("subject"), text: textOf(json.message.payload) };
  },
  async sendDraft(draftId) {
    const { status, json } = await call<{ id: string; threadId: string }>("/drafts/send", { method: "POST", body: JSON.stringify({ id: draftId }) });
    if (status === 404) throw new Error("The Gmail draft is no longer in Drafts.");
    return { messageId: json.id, threadId: json.threadId };
  },
  async profile() {
    const { json } = await call<{ emailAddress: string }>("/profile");
    return { emailAddress: json.emailAddress };
  },
  async deleteDraft(draftId) {
    const token = await accessToken();
    const res = await fetch(`${BASE}/drafts/${encodeURIComponent(draftId)}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
    if (res.status === 404) return false;
    if (!res.ok) throw new Error(`Gmail answered ${res.status} when removing the draft.`);
    return true;
  },
  async listMessages(q, max) {
    const { json } = await call<{ messages?: { id: string; threadId: string }[] }>(`/messages?${new URLSearchParams({ q, maxResults: String(Math.min(Math.max(max, 1), 100)) })}`);
    return json.messages ?? [];
  },
  async getMessageMeta(id) {
    const qs = new URLSearchParams([["format", "metadata"], ...["From", "To", "Subject", "In-Reply-To", "References"].map((h) => ["metadataHeaders", h] as [string, string])]);
    const { status, json } = await call<GMessage>(`/messages/${encodeURIComponent(id)}?${qs}`);
    return status === 404 ? null : metaOf(json);
  },
  async getMessage(id) {
    const { status, json } = await call<GMessage>(`/messages/${encodeURIComponent(id)}?format=full`);
    if (status === 404) return null;
    return { ...metaOf(json), text: textOf(json.payload), attachments: filesOf(json.payload) };
  },
  async getAttachment(messageId, attachmentId) {
    const { json } = await call<{ data?: string }>(`/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`);
    return Buffer.from(json.data ?? "", "base64url");
  },
};
