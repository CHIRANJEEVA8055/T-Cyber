/**
 * The demo case assistant answers a small, stated set of questions from the case records. It recognises the
 * kind of question with plain rules, and says so when a question is outside what it can answer.
 */
import { coreRef } from "./request-ref";
export type CaseIntent = "WHAT_CHANGED" | "MISSING" | "SUPPORTED" | "NEXT" | "MONEY" | "HELP";

const RULES: [Exclude<CaseIntent, "HELP">, RegExp][] = [
  ["MONEY", /\b(money|funds?|how much|held|holds?|secured|loss|refunds?|returned|ledger|amounts?|rupees?)\b|₹/i],
  ["MISSING", /\b(missing|gaps?|unknowns?|not (yet )?known|still (need|open)|don'?t know|unanswered|outstanding questions?)\b/i],
  ["SUPPORTED", /\b(supported|supports?|evidence|proof|proves?|established|confirmed|sources?|verified)\b/i],
  ["WHAT_CHANGED", /\b(changed?|changes|new|latest|recent(ly)?|since|updates?|updated)\b/i],
  ["NEXT", /\b(next|review|priorit(y|ies|ise|ize)|should i|to do|todo|pending|follow[- ]?ups?)\b/i],
];

export function classifyCaseQuestion(question: string): CaseIntent {
  for (const [intent, re] of RULES) if (re.test(question)) return intent;
  return "HELP";
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** True when `needle` appears in `text` as a whole word or token (case-insensitive). */
function mentions(text: string, needle: string): boolean {
  const n = needle.trim();
  if (!n) return false;
  return new RegExp(`(^|[^a-z0-9])${escapeRe(n)}($|[^a-z0-9])`, "i").test(text);
}

/** "Demo Holder A (synthetic)" is also found as "Demo Holder A". */
const withoutQualifier = (label: string) => label.replace(/\s*\([^)]*\)\s*$/, "");

/** Records and requests a question names, by label, recorded value or request reference. */
export function findMentions(question: string, records: { id: string; label: string; value: string }[], requests: { id: string; reference: string }[]) {
  return {
    entityIds: records.filter((r) => mentions(question, r.label) || mentions(question, r.value) || mentions(question, withoutQualifier(r.label))).map((r) => r.id),
    // A request is found by its reference, or by its core without the kind's letter (REQ-412/2026-004).
    requestIds: requests.filter((r) => mentions(question, r.reference) || mentions(question, coreRef(r.reference))).map((r) => r.id),
  };
}
