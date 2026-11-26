import crypto from "node:crypto";

/**
 * An email as RFC 5322 / MIME text: plain-text body (UTF-8) and attachments, with CRLF line ends. Used to send through
 * SMTP and to download a ready-to-send .eml for the officer's own mail program. Nothing here touches the network.
 */

export interface MailAttachment {
  fileName: string;
  contentType: string;
  content: Buffer;
}

export interface MailMessage {
  from: string;
  fromName?: string | null;
  to: string;
  toName?: string | null;
  subject: string;
  text: string;
  attachments?: MailAttachment[];
  /** Extra headers ("X-Unsent: 1" opens the .eml as a draft to send in Outlook). */
  headers?: Record<string, string>;
}

const ascii = (s: string) => /^[\x20-\x7e]*$/.test(s);
/** A header word: as it is when plain ASCII, RFC 2047 encoded otherwise. */
export const encodeWord = (s: string) => (ascii(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`);
const address = (email: string, name?: string | null) => (name ? `${ascii(name) ? `"${name.replace(/["\\]/g, "")}"` : encodeWord(name)} <${email}>` : email);
const base64Lines = (b: Buffer) => (b.toString("base64").match(/.{1,76}/g) ?? []).join("\r\n");
// Header values never carry a line break from the content (no header injection).
const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").trim();

export function buildMime(m: MailMessage, opts: { date?: Date; messageId?: string } = {}): { mime: string; messageId: string } {
  const domain = m.from.split("@")[1] ?? "t-cyber.invalid";
  const messageId = opts.messageId ?? `<${crypto.randomBytes(12).toString("hex")}@${domain}>`;
  const headers = [
    `From: ${address(oneLine(m.from), m.fromName ? oneLine(m.fromName) : null)}`,
    // A draft whose addressee is not known yet has no To line (Gmail refuses a placeholder one).
    ...(oneLine(m.to) ? [`To: ${address(oneLine(m.to), m.toName ? oneLine(m.toName) : null)}`] : []),
    `Subject: ${encodeWord(oneLine(m.subject))}`,
    `Date: ${(opts.date ?? new Date()).toUTCString()}`,
    `Message-ID: ${messageId}`,
    "MIME-Version: 1.0",
    ...Object.entries(m.headers ?? {}).map(([k, v]) => `${k.replace(/[^\w-]/g, "")}: ${oneLine(v)}`),
  ];
  const text = base64Lines(Buffer.from(m.text.replace(/\r?\n/g, "\r\n"), "utf8"));
  const files = m.attachments ?? [];
  if (!files.length) return { mime: [...headers, "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "", text, ""].join("\r\n"), messageId };
  const boundary = `tcyber-${crypto.randomBytes(10).toString("hex")}`;
  const parts = [
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    text,
    ...files.flatMap((f) => {
      const name = oneLine(f.fileName).replace(/"/g, "");
      const disp = ascii(name) ? `filename="${name}"` : `filename*=UTF-8''${encodeURIComponent(name)}`;
      return [`--${boundary}`, `Content-Type: ${f.contentType}; name="${ascii(name) ? name : "attachment"}"`, "Content-Transfer-Encoding: base64", `Content-Disposition: attachment; ${disp}`, "", base64Lines(f.content)];
    }),
    `--${boundary}--`,
    "",
  ];
  return { mime: [...headers, `Content-Type: multipart/mixed; boundary="${boundary}"`, "", ...parts].join("\r\n"), messageId };
}
