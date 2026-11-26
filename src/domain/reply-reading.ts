/**
 * Facts the local model reads from a reply that the rules could not place (a provider's free-text answer, a bank
 * letter worded differently). The model is only a reader: each fact must quote the reply, the quote must be in the
 * reply, and every value it reports (a number, an address, an amount, a name) must be in that quote. Anything else
 * is dropped. What survives is still only proposed: the officer accepts or rejects each one.
 */

export const FACT_TYPES = ["ACCOUNT_HOLDER", "REGISTERED_MOBILE", "REGISTERED_EMAIL", "ADDRESS", "IP_LOG", "HOLD", "BENEFICIARY_PAYMENT", "PRESERVED", "NOT_AVAILABLE"] as const;
export type FactType = (typeof FACT_TYPES)[number];

export interface ModelFact {
  type: FactType;
  quote: string;
  holder?: string;
  mobile?: string;
  email?: string;
  address?: string;
  ip?: string;
  at?: string;
  amount?: string;
  account?: string;
  ifsc?: string;
  bank?: string;
  reference?: string;
  date?: string;
  until?: string;
  what?: string;
}

/** The model's JSON answer, with or without a code fence; null when it is not JSON. */
export function parseModelJson(text: string): unknown {
  const body = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(body) as unknown;
  } catch {
    const m = /\{[\s\S]*\}/.exec(body);
    if (!m) return null;
    try {
      return JSON.parse(m[0]) as unknown;
    } catch {
      return null;
    }
  }
}

const squash = (s: string) => s.toLowerCase().replace(/[‘’`]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();
const digits = (s: string) => s.replace(/\D/g, "");
/** Rupee amounts written in a text, in paise ("Rs. 1,00,000.00" → 10000000). */
function amountsIn(text: string): Set<number> {
  const out = new Set<number>();
  for (const m of text.matchAll(/\d[\d,]*(?:\.\d{1,2})?/g)) {
    const v = Number(m[0].replace(/,/g, ""));
    if (Number.isFinite(v)) out.add(Math.round(v * 100));
  }
  return out;
}
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** Whether a value the model reports is written in the quote (numbers by their digits, amounts by their value). */
function inQuote(key: string, value: string, quote: string): boolean {
  if (key === "mobile" || key === "account" || key === "reference") {
    const d = digits(value);
    const q = digits(quote);
    if (key === "reference" && !/^\d+$/.test(value.replace(/[\s-]/g, ""))) return squash(quote).includes(squash(value));
    return d.length >= 6 && (q.includes(d) || (key === "mobile" && d.length > 10 && q.includes(d.slice(-10))));
  }
  if (key === "amount") {
    const v = Number(value.replace(/[^0-9.]/g, ""));
    return Number.isFinite(v) && v > 0 && amountsIn(quote).has(Math.round(v * 100));
  }
  return squash(quote).includes(squash(value));
}

const VALUE_KEYS = ["holder", "mobile", "email", "address", "ip", "amount", "account", "ifsc", "reference", "date", "until", "at"] as const;
/** The values each kind of fact must carry. */
const REQUIRED: Record<FactType, (typeof VALUE_KEYS)[number][]> = {
  ACCOUNT_HOLDER: ["holder"],
  REGISTERED_MOBILE: ["mobile"],
  REGISTERED_EMAIL: ["email"],
  ADDRESS: ["address"],
  IP_LOG: ["ip"],
  HOLD: ["amount"],
  BENEFICIARY_PAYMENT: ["account", "amount", "date"],
  PRESERVED: [],
  NOT_AVAILABLE: [],
};

export function checkModelFacts(answer: unknown, replyText: string): ModelFact[] {
  const facts = answer && typeof answer === "object" && Array.isArray((answer as { facts?: unknown }).facts) ? ((answer as { facts: unknown[] }).facts) : [];
  const text = squash(replyText);
  const out: ModelFact[] = [];
  for (const raw of facts) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const type = str(r.type)?.toUpperCase() as FactType | undefined;
    const quote = str(r.quote);
    if (!type || !FACT_TYPES.includes(type) || !quote || quote.length < 6) continue;
    // The quote must be the reply's own words.
    if (!text.includes(squash(quote))) continue;
    const fact: ModelFact = { type, quote };
    let ok = true;
    for (const k of VALUE_KEYS) {
      const v = str(r[k]);
      if (!v) continue;
      // Dates and times are checked by their digits, which survive any separator.
      const present = k === "date" || k === "until" || k === "at" ? digits(quote).includes(digits(v).slice(0, 8)) || squash(quote).includes(squash(v)) : inQuote(k, v, quote);
      if (!present) {
        ok = false;
        break;
      }
      fact[k] = v;
    }
    if (!ok || REQUIRED[type].some((k) => !fact[k])) continue;
    const what = str(r.what);
    if (what) fact.what = what.slice(0, 200);
    const bank = str(r.bank);
    if (bank && squash(quote).includes(squash(bank))) fact.bank = bank;
    out.push(fact);
  }
  return out;
}
