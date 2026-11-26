/**
 * The closing block at the foot of a request ("Yours faithfully," then the officer's name and rank and the station's
 * lines), as the station's notices end. Templates end with the standard foot ({{officerName}}, {{officerRank}} and
 * the station signature); an officer who has set their own closing gets theirs in its place on new drafts.
 */

export interface MailboxLines {
  valediction: string;
  signature: string[];
}

export function defaultClosing(officer: { displayName: string; rank: string }, mailbox: MailboxLines): string[] {
  return [...(mailbox.valediction ? [mailbox.valediction] : []), `${officer.displayName}, ${officer.rank}`, ...mailbox.signature];
}

/** The foot a template renders before any closing is applied. */
const standardFoot = (officer: { displayName: string; rank: string }, mailbox: MailboxLines) => [`${officer.displayName}, ${officer.rank}`, ...mailbox.signature].join("\n");

/** The body with its standard foot replaced by the given closing; a body that ends otherwise is left as written. */
export function withClosing(body: string, officer: { displayName: string; rank: string }, mailbox: MailboxLines, closing: string[]): string {
  const trimmed = body.replace(/\s+$/, "");
  // The full foot, or a template's bare "Name, Rank" line.
  const foot = [standardFoot(officer, mailbox), `${officer.displayName}, ${officer.rank}`].find((f) => trimmed.endsWith(f));
  if (!foot) return body;
  return `${trimmed.slice(0, trimmed.length - foot.length).replace(/\s+$/, "")}\n\n${closing.join("\n")}`;
}

const VALEDICTION = /^(?:yours\b|sd\/-|with regards|regards|thanking you)/i;
const RANK = /\b(?:inspector|sub-inspector|constable|superintendent|commissioner|officer|ACP|DSP|SHO|SI|CI|SP|DCP|head constable)\b/i;

/** Whether the last paragraph of a letter is its closing block rather than letter text. */
function looksLikeClosing(lines: string[]): boolean {
  if (!lines.length || lines.length > 10) return false;
  if (VALEDICTION.test(lines[0]!)) return true;
  // "R. Devi, Inspector" or "Inspector of Police,": a short first line naming a rank, and short lines after it.
  return lines[0]!.length <= 60 && RANK.test(lines[0]!) && lines.every((l) => l.length <= 80);
}

/** Splits a letter into its text and its closing block (empty when the last paragraph is not a closing). */
export function splitClosing(body: string): { text: string; closing: string } {
  const trimmed = body.replace(/\s+$/, "");
  const at = trimmed.lastIndexOf("\n\n");
  if (at < 0) return { text: trimmed, closing: "" };
  const last = trimmed.slice(at + 2);
  return looksLikeClosing(last.split("\n").map((l) => l.trim()).filter(Boolean)) ? { text: trimmed.slice(0, at).replace(/\s+$/, ""), closing: last } : { text: trimmed, closing: "" };
}

export function joinClosing(text: string, closing: string): string {
  const t = text.replace(/\s+$/, "");
  const c = closing.trim();
  return c ? `${t}\n\n${c}` : t;
}

/** Closing lines as stored: trimmed, without blank lines. */
export const closingLines = (closing: string) => closing.split("\n").map((l) => l.trim()).filter(Boolean);
