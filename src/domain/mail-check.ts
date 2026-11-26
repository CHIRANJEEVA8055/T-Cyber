/**
 * The checks a mail must pass before it is sent from the mail window, shared by the browser (to mark the fields at
 * once) and the server (which decides). Saving a draft is never blocked by them: a half-written mail is kept as it
 * is; only Send asks for every field to be right. Pure: no I/O.
 */

export type MailField = "to" | "subject" | "body" | "attachments" | "items";
export const MAIL_FIELD_LABEL: Record<MailField, string> = { to: "To", subject: "Subject", body: "Mail text", attachments: "Attachments", items: "Asks for" };
/** Gmail refuses a message over 25 MB once encoded, which is about 18 MB of attached files. */
export const MAX_ATTACH_BYTES = 18 * 1024 * 1024;
export const MAX_RECIPIENTS = 5;

const EMAIL_RE = /^[^\s@<>(),;:"[\]]+@[^\s@<>(),;:"[\]]+\.[A-Za-z]{2,}$/;
/** Names that can never receive mail (RFC 2606 / 6761): example domains and the .invalid, .test, .example, .localhost endings. */
const RESERVED_RE = /(?:\.(?:invalid|test|example|localhost)$|(?:^|\.)example\.(?:com|net|org)$)/i;
/** A line the draft left to be completed: "[Bank A: to be filled in]", "[record the order reference before approval]". */
const PLACEHOLDER_RE = /\[[^\]\n]{0,120}(?:to be filled in|record the [^\]\n]{0,80})\]/i;

/** "a@b.in, Name <c@d.in>; e@f.in" → the addresses as typed, in order, without duplicates. */
export function splitAddresses(raw: string): string[] {
  const parts = raw
    .split(/[,;]+/)
    .flatMap((p) => {
      const angled = /<([^>]+)>/.exec(p);
      return angled ? [angled[1]!] : p.split(/\s+/);
    })
    .map((a) => a.trim().replace(/^mailto:/i, ""))
    .filter(Boolean);
  const seen = new Set<string>();
  return parts.filter((a) => {
    const k = a.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Written as an email address (whether or not it can receive mail). */
export const isEmailAddress = (a: string) => EMAIL_RE.test(a);

export function addressProblem(a: string): string | null {
  if (!EMAIL_RE.test(a)) return `“${a.slice(0, 60)}” is not an email address.`;
  const domain = a.split("@")[1]!.toLowerCase();
  if (RESERVED_RE.test(domain)) return `${a} is a placeholder address that cannot receive mail. Type the real address.`;
  return null;
}

export interface MailToCheck {
  to: string;
  subject: string;
  body: string;
  /** Total size of the attached files, in bytes. */
  attachmentBytes: number;
  /** Attached files no longer in the case (named), if any. */
  missingAttachments?: string[];
  /** Whether the request lists what it asks for, and how many of those are kept. */
  hasItems: boolean;
  itemsKept: number;
}

/** What is wrong with each field, in a short line; an empty object when the mail can be sent. */
export function checkMail(m: MailToCheck): Partial<Record<MailField, string>> {
  const out: Partial<Record<MailField, string>> = {};
  const to = splitAddresses(m.to);
  if (!to.length) out.to = "Type the address to send it to.";
  else if (to.length > MAX_RECIPIENTS) out.to = `Send to at most ${MAX_RECIPIENTS} addresses.`;
  else {
    const bad = to.map(addressProblem).find(Boolean);
    if (bad) out.to = bad;
  }
  const subject = m.subject.trim();
  if (subject.length < 5) out.subject = "Write a subject (at least 5 characters).";
  else if (subject.length > 250) out.subject = "Shorten the subject to 250 characters or fewer.";
  const body = m.body.trim();
  const hole = PLACEHOLDER_RE.exec(body)?.[0];
  if (body.length < 20) out.body = "Write the mail (at least 20 characters).";
  else if (hole) out.body = `Fill in ${hole} first.`;
  else if (body.length > 100_000) out.body = "The mail is too long to send (over 100,000 characters).";
  if (m.missingAttachments?.length) out.attachments = `${m.missingAttachments.join(", ")} ${m.missingAttachments.length === 1 ? "is" : "are"} no longer in the case. Remove ${m.missingAttachments.length === 1 ? "it" : "them"}.`;
  else if (m.attachmentBytes > MAX_ATTACH_BYTES) out.attachments = `The files come to ${(m.attachmentBytes / 1048576).toFixed(1)} MB; Gmail sends at most about 18 MB of files. Remove some.`;
  if (m.hasItems && m.itemsKept === 0) out.items = "Tick at least one thing to ask for.";
  return out;
}

/** "Invalid: To, Mail text" for the line at the top of the window. */
export function invalidLine(errors: Partial<Record<MailField, string>>): string | null {
  const keys = (Object.keys(MAIL_FIELD_LABEL) as MailField[]).filter((k) => errors[k]);
  return keys.length ? `Invalid: ${keys.map((k) => MAIL_FIELD_LABEL[k]).join(", ")}` : null;
}

/** Removes the line that lists an item ("- Statement of account …") from the mail text; null when it is not on a line of its own. */
export function withoutItemLine(body: string, label: string): string | null {
  const lines = body.split("\n");
  const at = lines.findIndex((l) => l.replace(/^\s*(?:[-•*]|\d+[.)])\s*/, "").trim() === label.trim());
  if (at < 0) return null;
  lines.splice(at, 1);
  return lines.join("\n");
}

/** Puts an item's line back: after the last listed item, else under "Kindly furnish:", else before the closing, else at the end. */
export function withItemLine(body: string, label: string, otherLabels: string[]): string {
  const lines = body.split("\n");
  const norm = (l: string) => l.replace(/^\s*(?:[-•*]|\d+[.)])\s*/, "").trim();
  if (lines.some((l) => norm(l) === label.trim())) return body;
  const listed = lines.map((l, i) => (otherLabels.some((o) => norm(l) === o.trim()) ? i : -1)).filter((i) => i >= 0);
  const at = listed.length
    ? listed.at(-1)! + 1
    : (() => {
        const found = lines.findIndex((l) => /^\s*(kindly reply|reference:|regards|yours faithfully)/i.test(l));
        const end = found >= 0 ? found : lines.length;
        // Under the line that introduces the list ("Kindly furnish:"), when there is one.
        const intro = lines.slice(0, end).map((l, i) => (/:\s*$/.test(l) ? i : -1)).filter((i) => i >= 0).at(-1);
        return intro !== undefined ? intro + 1 : end;
      })();
  lines.splice(at, 0, `- ${label}`);
  return lines.join("\n");
}
