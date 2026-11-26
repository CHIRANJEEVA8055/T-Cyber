/**
 * How likely an incoming message answers a given request. Pure and rule-based: each signal adds a fixed weight,
 * and the reasons are kept so the officer can see why. Matches under AUTO_MATCH_SCORE wait for the officer.
 */
import { quotesRequest } from "./request-ref";
export const AUTO_MATCH_SCORE = 70;

export interface ReplyText {
  fromAddress: string;
  subject: string;
  bodyText: string;
}

export interface RequestForMatch {
  reference: string;
  /** The reference it had before references named their case (REQ-2026-0275), still quoted by replies to it. */
  legacyReference?: string | null;
  recipientAddress: string;
  /** "412/2026" */
  firReference: string | null;
  /** Values of the request's subjects (account numbers, phone numbers, handles), as recorded. */
  identifiers: string[];
  /** Other domains the recipient's replies come through (a DD mailbox forwarding UNICROSS replies). */
  replyDomains?: string[];
}

export const domainOf = (address: string) => (/@([^>\s]+)\s*>?\s*$/.exec(address.trim())?.[1] ?? "").toLowerCase();
/** "Name <a@b.in>" → "a@b.in". */
export const plainAddress = (s: string) => (/<([^>]+)>/.exec(s)?.[1] ?? s).trim().toLowerCase();

/**
 * Mail domains shared by many unrelated people: free mail services and the government's common domains. Mail from
 * such a domain says nothing about who sent it, so it is matched to a request only by the exact address.
 */
const SHARED_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.in", "yahoo.in", "ymail.com", "rocketmail.com", "rediffmail.com", "rediff.com",
  "outlook.com", "outlook.in", "hotmail.com", "hotmail.co.in", "live.com", "live.in", "msn.com", "icloud.com", "me.com", "mac.com",
  "aol.com", "protonmail.com", "proton.me", "pm.me", "zoho.com", "zohomail.in", "zohomail.com", "mail.com", "gmx.com", "gmx.net",
  "yandex.com", "yandex.ru", "tutanota.com", "tuta.io", "fastmail.com", "inbox.com", "email.com", "sify.com", "indiatimes.com",
  "nic.in", "gov.in", "kavach.gov.in",
]);
export const isSharedDomain = (domain: string) => SHARED_DOMAINS.has(domain.toLowerCase().replace(/^mail\./, ""));

const lastDigits = (v: string, n: number) => v.replace(/[^0-9]/g, "").slice(-n);

export function scoreReply(msg: ReplyText, req: RequestForMatch): { score: number; reasons: string[] } {
  const text = `${msg.subject}\n${msg.bodyText}`;
  const reasons: string[] = [];
  let score = 0;
  if (quotesRequest(text, [req.reference, req.legacyReference])) {
    score += 40;
    reasons.push(`quotes ${req.reference}${req.legacyReference && !quotesRequest(text, [req.reference]) ? ` (as ${req.legacyReference})` : ""}`);
  }
  const sender = domainOf(msg.fromAddress);
  const own = domainOf(req.recipientAddress);
  // A shared domain (gmail.com, nic.in …) counts only when it is the very address the request went to.
  const sameAddress = !!sender && plainAddress(msg.fromAddress) === plainAddress(req.recipientAddress);
  if (sameAddress) {
    score += 25;
    reasons.push(`comes from ${plainAddress(msg.fromAddress)}, where the request went`);
  } else if (sender && !isSharedDomain(sender) && (sender === own || (req.replyDomains ?? []).map((d) => d.toLowerCase()).includes(sender))) {
    score += 25;
    reasons.push(`comes from ${sender}, where the request went`);
  }
  const firs = [...new Set([...text.matchAll(/\bFIR\s*(?:No\.?\s*)?(\d{1,5}\/\d{4})\b/gi)].map((m) => m[1]!))];
  if (req.firReference && firs.includes(req.firReference)) {
    score += 15;
    reasons.push(`names FIR ${req.firReference}`);
  }
  const ids = req.identifiers.map((v) => lastDigits(v, 4)).filter((d) => d.length >= 2);
  const digits = text.replace(/[^0-9]/g, " ");
  if (ids.some((d) => new RegExp(`${d}\\b`).test(digits) || text.includes(d))) {
    score += 16;
    reasons.push("mentions the identifier asked about");
  }
  if (firs.length > 1) {
    score -= 5 * (firs.length - 1);
    reasons.push(`names ${firs.length} FIRs, so only part of it may concern this case`);
  }
  return { score: Math.max(1, Math.min(99, score)), reasons };
}
