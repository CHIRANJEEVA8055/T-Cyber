/**
 * Request and reply references that say what they are about: the kind of request, the case, and its place in it.
 *
 *   P.REQ-412/2026-003      a preservation request, the third request in FIR 412/2026
 *   R.REQ-412/2026-002      a records request (statement, KYC, CDR, subscriber or account details)
 *   H.REQ-412/2026-005      a hold (debit freeze) request
 *   U.REQ-412/2026-009      a release (unhold, restoration of held money) request
 *   R.REQ-412/2026-002-R1   the first reminder for R.REQ-412/2026-002
 *   R.RES-412/2026-002      the reply to R.REQ-412/2026-002 (a second reply to it is R.RES-412/2026-002-2)
 *
 * The serial is the request's number in its case, whatever its kind, so the part after the letter ("the core",
 * REQ-412/2026-002) names one request on its own: a reply quoting the core without the letter, or the reply form, still
 * finds it. A case registered only on the NCRP portal uses its acknowledgement number in place of the FIR number
 * (R.REQ-31234567890123-001). Requests sent before references named their case (REQ-2026-0275) keep that reference
 * as their legacy reference, so a reply quoting it is still matched.
 */

export const RESPONSE_PREFIX = "RES";

/** The letter for each kind of request: P preservation, R records, H hold, U release (unhold). */
export const CATEGORY_LETTER: Record<string, string> = { PRESERVATION: "P", INFORMATION: "R", HOLD: "H", RESTORATION: "U" };
const LETTERS = ["P", "R", "H", "U"] as const;
export const letterFor = (category: string): string => CATEGORY_LETTER[category] ?? "R";

/** The part of the reference that names the case: "412/2026", or the NCRP acknowledgement number, or null. */
export function caseRefKey(c: { firNumber: number | null; firYear: number | null; complaintRef?: string | null }): string | null {
  if (c.firNumber && c.firYear) return `${c.firNumber}/${c.firYear}`;
  const ack = (c.complaintRef ?? "").replace(/\D/g, "");
  return ack.length >= 8 ? ack : null;
}

/** "R.REQ-412/2026-002": the kind's letter, the prefix, the case and the request's serial in the case (three digits, more past 999). */
export function formatRequestRef(prefix: string, caseKey: string, serial: number, category: string): string {
  if (!Number.isInteger(serial) || serial < 1) throw new Error("A request serial starts at 1.");
  return `${letterFor(category)}.${prefix}-${caseKey}-${String(serial).padStart(3, "0")}`;
}

/** "R.REQ-412/2026-002-R1": the n-th reminder for a request (it keeps its request's kind). */
export function reminderRef(parentRef: string, n: number): string {
  return `${parentRef.replace(/-R\d+$/, "")}-R${Math.max(1, Math.floor(n))}`;
}

/** "R.RES-412/2026-002" for the first reply to R.REQ-412/2026-002; later replies to it are "-2", "-3". */
export function responseRef(requestRef: string, index = 1, prefix = "REQ"): string {
  const m = new RegExp(`^((?:[A-Z]\\.)?)${esc(prefix)}-`).exec(requestRef);
  const base = m ? `${m[1]}${RESPONSE_PREFIX}-${requestRef.slice(m[0].length)}` : `${RESPONSE_PREFIX}-${requestRef}`;
  return index > 1 ? `${base}-${index}` : base;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** "R.REQ-412/2026-002" or "R.RES-412/2026-002" → "REQ-412/2026-002": the request's core, which names it on its own. */
export function coreRef(ref: string, prefix = "REQ"): string {
  const up = ref.trim().toUpperCase().replace(/^[A-Z]\./, "");
  return up.startsWith(`${RESPONSE_PREFIX}-`) && prefix.toUpperCase() !== RESPONSE_PREFIX ? `${prefix.toUpperCase()}-${up.slice(RESPONSE_PREFIX.length + 1)}` : up;
}

/** Every stored form a core can have: as it is, and with each kind's letter. */
export function refVariants(core: string): string[] {
  return [core, ...LETTERS.map((l) => `${l}.${core}`)];
}

/**
 * Finds request references in a reply's subject or text: the current form with or without the kind's letter
 * (R.REQ-412/2026-002, REQ-412/2026-002), reminders (…-R1), a complaint's (R.REQ-31234567890123-001), the reply form
 * (R.RES-…), and the legacy REQ-2026-0275. A slash may come through mail as a space; that is read too.
 */
export function requestRefPattern(prefix: string): RegExp {
  const p = esc(prefix);
  const r = esc(RESPONSE_PREFIX);
  return new RegExp(`(?<![\\w.])(?:[A-Za-z]\\.)?(?:${p}|${r})-(?:\\d{1,7}[/ ]\\d{4}|\\d{8,20})-\\d{3,5}(?:-R\\d{1,3})?(?![\\w/])|\\b${p}-\\d{4}-\\d{4}\\b`, "gi");
}

/** Each request quoted in the text, as its core (REQ-412/2026-002; a reply's RES-… read as REQ-…), in order. */
export function quotedRequestRefs(text: string, prefix: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(requestRefPattern(prefix))) {
    const ref = coreRef(m[0].replace(/^((?:[A-Za-z]\.)?[A-Za-z]+-\d{1,7}) (\d{4})/, "$1/$2"), prefix);
    if (!out.includes(ref)) out.push(ref);
  }
  return out;
}

/** A reference used in a file name: "R.REQ-412-2026-002" (a slash cannot be in a file name). */
export function fileSafeRef(ref: string): string {
  return ref.replace(/[/\\:*?"<>|\s]+/g, "-").replace(/-{2,}/g, "-");
}

/**
 * Whether a text quotes a request: its reference (with or without the kind's letter), the reply form of it (R.RES-…),
 * or its legacy reference. A reference is matched whole, so quoting R.REQ-412/2026-002-R1 is not taken as quoting
 * R.REQ-412/2026-002.
 */
export function quotesRequest(text: string, refs: readonly (string | null | undefined)[]): boolean {
  const upper = text.toUpperCase();
  for (const raw of refs) {
    if (!raw) continue;
    const prefix = /^(?:[A-Z]\.)?([A-Z]+)-/i.exec(raw)?.[1]?.toUpperCase() ?? "REQ";
    const core = coreRef(raw, prefix);
    if (quotedRequestRefs(text, prefix).includes(core)) return true;
    // A reference outside the usual forms (a station code added to keep it unique) is matched as written.
    const whole = raw.toUpperCase();
    if (!new RegExp(`^(?:${requestRefPattern(prefix).source})$`, "i").test(whole) && new RegExp(`(?<![\\w/.])(?:[A-Z]\\.)?${esc(coreRef(whole, prefix))}(?![\\w/-])`).test(upper)) return true;
  }
  return false;
}
