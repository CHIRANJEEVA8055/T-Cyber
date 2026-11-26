import { parseRupeesToMinor } from "../money";
import { narrativeSource, type At, type CctnsFir } from "./cctns";

/**
 * What a CCTNS FIR's complaint text and accused entries name, each with whose it is and where it was read. Roles
 * come only from the FIR's own words: item 7 (the accused), "whose mobile number is" (the complainant's own), "from
 * his own … account" (the victim's account), "to account number …" (where money went). Anything the words do not
 * settle is left as "role not stated" for the officer. Amounts are sorted by what the sentence says happened to the
 * money: paid, returned, only shown as profit, demanded, promised, or the stated loss.
 */

export type EntityKind = "PHONE" | "EMAIL" | "WEBSITE" | "HANDLE" | "UPI_ID" | "BANK_ACCOUNT" | "IFSC" | "TXN_REFERENCE" | "NCRP_ACK" | "BANK_SR";
export type EntityRole = "COMPLAINANT" | "SUSPECT" | "VICTIM_ACCOUNT" | "BENEFICIARY" | "UNSTATED";

export interface FirEntity {
  kind: EntityKind;
  value: string;
  normalized: string;
  role: EntityRole;
  /**
   * A name the FIR gives for it ("a vendor named Adharsh bearing account …"), kept only as what was stated: an FIR is
   * the complainant's account before any enquiry, so it neither makes that person the accused nor the holder.
   */
  statedName?: string | null;
  /** Why the role was given, in the FIR's words ("named in item 7", "WhatsApp user"). */
  basis: string;
  platform: string | null;
  foreign: boolean;
  at: At;
  excerpt: string;
}

export type AmountKind = "PAID" | "RETURNED" | "PROFIT_SHOWN" | "DEMANDED" | "PROMISED" | "LOSS" | "TOTAL_PAID" | "OTHER";
export interface FirAmount {
  kind: AmountKind;
  /** "they returned only Rs. …": the complaint's own summing-up of that kind of money. */
  summary: boolean;
  text: string;
  minor: bigint;
  date: string | null;
  reference: string | null;
  at: At;
  excerpt: string;
}

// ───────────────────────────── patterns ─────────────────────────────────────────────────────────────────────────

const TLD = "com|in|net|org|io|app|co|cc|shop|rest|vip|top|xyz|online|site|club|live|me|info|biz|pro|link|store|tech|fun|icu|cn|hk|uk|us|ai|gg|work|asia|life|world|today|trade|win|bet|money|finance|exchange|cyou|sbs|bond|buzz|lat|mom|cfd|homes|best|one|vin|ink|kim|loan|press|wiki|global|group|cloud|digital|email|tel|tv|ws|to|ly|gov\\.in|nic\\.in|co\\.in|org\\.in";
const RE = {
  url: /\bhttps?:\/\/[^\s,;)"”'<>]+/gi,
  domain: new RegExp(`(?<![@\\w.-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+(?:${TLD})\\b(?:/[^\\s,;)"”'<>]*)?`, "gi"),
  email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g,
  upi: /\b[A-Za-z0-9._-]{2,}@[A-Za-z]{2,}(?![A-Za-z0-9-]|\.[A-Za-z0-9])/g,
  handle: /(?<![\w.@/])@([A-Za-z][A-Za-z0-9_]{2,31})\b/g,
  phoneIn: /(?<![\d+])(?:\+91[\s-]?|0)?[6-9]\d{4}[\s-]?\d{5}(?!\d)/g,
  phoneIntl: /\+(?!91[\s-]?[6-9])\d{1,3}[\s-]?(?:\(\d{1,4}\)[\s-]?)?\d{1,4}(?:[\s-]?\d{1,4}){1,4}/g,
  // "account no. 5010…", "A/c 5010…", "bank account id - 5010…", "acc no: 5010…".
  account: /\b(?:account|a\/c|acct|acc)\.?\s*(?:id|no\.?|number|num)?\.?\s*[:.\-–]?\s*(\d{9,18})\b/gi,
  ifsc: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g,
  txn: /\b(?:UTR|RRN|UPI\s*ref(?:erence)?|txn\.?\s*(?:id|ref)|transaction\s*(?:id|ref(?:erence)?|no\.?)|(?:account\s+)?reference)\s*(?:no\.?|number)?\s*[:.-]?\s*([A-Z0-9]{10,22})\b/gi,
  ncrp: /\b(?:acknowledge?ment|ack(?:nowledgement)?\.?)\s*(?:number|no\.?)?\s*[:.-]?\s*(\d{14})\b|\bNCRP\b[^.;]{0,60}?\b(\d{14})\b/gi,
  sr: /\bService Request (?:No\.?|Number)\s*[:.-]?\s*([A-Z]{1,4}\d{6,14})\b/gi,
  amount: /(?:Rs\.?|INR|₹)\s?(\d[\d,]*(?:\.\d{1,2})?)(?:\s*\/-)?/gi,
  date: /\b(\d{2})[-/](\d{2})[-/](\d{4})\b/,
};

/** Sites named only as the way the complainant was approached; not the fraud's own. */
const BENIGN = /(^|\.)(facebook|instagram|whatsapp|telegram|google|gmail|youtube|linkedin|twitter|cybercrime\.gov|gov|nic|sbi|hdfcbank|icicibank|axisbank|swiggy)\.(com|in|org|gov\.in)$/i;
const PLATFORMS: [RegExp, string][] = [
  [/telegram|t\.me/i, "Telegram"],
  [/\bX\b|twitter|x\.com/i, "X (Twitter)"],
  [/instagram/i, "Instagram"],
  [/whats\s?app/i, "WhatsApp"],
  [/facebook/i, "Facebook"],
];

const norm = {
  phone: (v: string) => {
    const d = v.replace(/[^\d+]/g, "");
    if (/^\+91\d{10}$/.test(d)) return d.slice(3);
    if (/^0\d{10}$/.test(d)) return d.slice(1);
    return d;
  },
  web: (v: string) => v.replace(/[.,;:]+$/, "").replace(/\/+$/, "").toLowerCase(),
};
export const domainOf = (url: string) => url.replace(/^https?:\/\//i, "").replace(/[/?#].*$/, "").toLowerCase();

/** The text from the start of the clause a position sits in (after the last ";" or sentence end) up to it. A full
 *  stop after "Rs", "No", "Sri", an initial and the like is not a sentence end. */
function clause(text: string, index: number, span = 160): string {
  const before = text.slice(Math.max(0, index - span), index);
  let start = before.lastIndexOf(";");
  for (const m of before.matchAll(/(?<!\b(?:Rs|No|Nos|Sri|Smt|Mr|Mrs|Ms|Dr|St|Ltd|Pvt|vs|Occ|Occp|Sec|U\/Sec|[A-Za-z]))\.\s/g)) start = Math.max(start, m.index);
  return before.slice(start + 1);
}

// ───────────────────────────── entities ─────────────────────────────────────────────────────────────────────────

/** Words that are never a person's name, however a sentence places them. */
const NOT_A_NAME = new Set(
  "a an the he she they him her his them their it its this that one person someone unknown fraudster fraudsters accused suspect suspects vendor company firm complainant victim informant bank account mobile number phone upi id email mail amount money rs inr total same said above below and or with bearing having holding of to from into by on in at for transferred transactioned paid sent deposited credited debited given told asked trader agent customer care executive officer manager team support".split(" "),
);
/** Bank names and abbreviations that follow "of" or "with" beside an account: a bank, never a holder. */
const BANKISH = /\b(?:bank|sbi|hdfc|icici|axis|kotak|pnb|canara|baroda|bob|union|idfc|idbi|indusind|yes|federal|rbl|bandhan|equitas|ujjivan|airtel|paytm|fino|ippb|kvb|uco|iob|boi)\b/i;

function cleanName(raw: string | undefined): string | null {
  if (!raw) return null;
  // A name ends with its sentence ("Kiran Kumar. Hence …"); an initial's full stop ("R. Kumar") does not end it.
  const words = raw.split(/(?<=[A-Za-z]{3,})\.\s+/)[0]!.replace(/[,.;:]+$/, "").trim().split(/\s+/);
  while (words.length && NOT_A_NAME.has(words[words.length - 1]!.toLowerCase().replace(/[.,]/g, ""))) words.pop();
  if (!words.length || words.length > 4) return null;
  if (words.some((w) => NOT_A_NAME.has(w.toLowerCase().replace(/[.,]/g, "")) || !/^[A-Za-z][A-Za-z.'’-]*$/.test(w))) return null;
  const name = words.join(" ");
  if (BANKISH.test(name) || name.replace(/[^A-Za-z]/g, "").length < 3) return null;
  return name;
}

/**
 * The name the text gives for the identifier at [start, end), as stated, or null: "a vendor named adharsh bearing
 * account …", "… in the name of Kiran Kumar", "Suresh with bank account …", "Ravi's account …". A bare capitalised word
 * before "with/bearing … account" counts only when it looks like a name; a bank after "of" never does.
 */
export function statedNameNear(text: string, start: number, end: number): string | null {
  const before = text.slice(Math.max(0, start - 110), start);
  const after = text.slice(end, end + 70);
  const TAIL = "(?:\\s+(?:with|bearing|having|holding|whose|using|of)\\b|\\s*[,(]|\\s+(?:bank\\s+)?(?:account|a\\/c|mobile|phone|number|upi|e-?mail)\\b)";
  const NAME = "((?:mr\\.?|mrs\\.?|ms\\.?|sri\\.?|smt\\.?|shri)?\\s*[A-Za-z][A-Za-z.'’-]*(?:\\s+[A-Za-z][A-Za-z.'’-]*){0,3}?)";
  // "named X …", "by name X …", "beneficiary name X …" shortly before the value.
  const named = [...before.matchAll(new RegExp(`\\b(?:named|by (?:the )?name(?: of)?|in the name of|beneficiary name|holder(?:'s)? name|account holder|a\\/c holder)\\s*[:\\-]?\\s*${NAME}${TAIL}`, "gi"))].at(-1);
  const fromNamed = cleanName(named?.[1]?.replace(/^(?:mr|mrs|ms|sri|smt|shri)\.?\s*/i, ""));
  if (fromNamed) return fromNamed;
  // "… in the name of X", "held by X", "belonging to X" just after the value.
  const held = /^[^.;]{0,25}?\b(?:in the name of|held by|belonging to|registered (?:in the name of|to))\s+(?:mr\.?|mrs\.?|ms\.?|sri\.?|smt\.?|shri)?\s*([A-Za-z][A-Za-z.'’-]*(?:\s+[A-Za-z][A-Za-z.'’-]*){0,3})/i.exec(after);
  const fromHeld = cleanName(held?.[1]?.split(/\s+(?:and|with|who|for|on|at|from|to)\b/i)[0]);
  if (fromHeld) return fromHeld;
  // "Ravi's account 5010…" or "Ravi Kumar with bank account id - 5010…": capitalised, right before the value.
  const own = /\b([A-Z][a-z][A-Za-z.'’-]*(?:\s+[A-Z][A-Za-z.'’-]*){0,2})(?:['’]s\s+(?:\w+\s+){0,2}|\s+(?:with|bearing|having|holding)\s+(?:\w+\s+){0,3})(?:account|a\/c|mobile|phone|number|upi)\b[^.;]{0,25}$/.exec(before);
  return cleanName(own?.[1]);
}

/** The person an item-7 accused entry names first ("Ravi Example, mobile …"), when it names one. */
function accusedName(text: string): string | null {
  const m = /^\s*(?:mr\.?|mrs\.?|ms\.?|sri\.?|smt\.?|shri)?\s*([A-Z][A-Za-z.'’-]*(?:\s+[A-Z][A-Za-z.'’-]*){0,3})\s*(?:,|\(|\bS\/o\b|\bD\/o\b|\bW\/o\b|-|$)/.exec(text);
  return cleanName(m?.[1]);
}

export function firEntities(fir: CctnsFir): FirEntity[] {
  const out: FirEntity[] = [];
  const add = (e: FirEntity) => {
    const same = out.find((x) => x.kind === e.kind && x.normalized === e.normalized);
    if (!same) out.push(e);
    else if (same.role === "UNSTATED" && e.role !== "UNSTATED") Object.assign(same, { role: e.role, basis: e.basis, platform: same.platform ?? e.platform });
  };
  const own = new Set<string>();
  const complainantFirst = fir.complainant.name?.value.trim().toLowerCase().split(/\s+/)[0] ?? null;
  if (fir.complainant.mobile) {
    own.add(norm.phone(fir.complainant.mobile.value));
    add({ kind: "PHONE", value: fir.complainant.mobile.value, normalized: norm.phone(fir.complainant.mobile.value), role: "COMPLAINANT", basis: "the complainant's mobile (item 6)", platform: null, foreign: false, at: fir.complainant.mobile, excerpt: `Mobile No. ${fir.complainant.mobile.value}` });
  }

  const scan = (text: string, where: (i: number) => At, baseRole: (i: number, value: string, kind: EntityKind) => { role: EntityRole; basis: string }, named: string | null = null) => {
    const taken: [number, number][] = [];
    const free = (s: number, e: number) => !taken.some(([a, b]) => s < b && a < e);
    const hit = (kind: EntityKind, value: string, index: number, extra: Partial<FirEntity> = {}) => {
      taken.push([index, index + value.length]);
      const normalized = kind === "PHONE" ? norm.phone(value) : kind === "WEBSITE" ? norm.web(value) : value.toLowerCase();
      const r = kind === "PHONE" && own.has(normalized) ? { role: "COMPLAINANT" as const, basis: "the complainant's mobile (item 6)" } : baseRole(index, value, kind);
      const ctx = clause(text, index, 120);
      // The platform word nearest before the value ("… the WhatsApp user +235 …"), for numbers and handles only.
      let platform: string | null = extra.platform ?? null;
      if (!platform && (kind === "PHONE" || kind === "HANDLE")) {
        let best = -1;
        for (const [re, name] of PLATFORMS) {
          const g = new RegExp(re.source, "gi");
          for (const m of ctx.matchAll(g)) if (m.index > best) [best, platform] = [m.index, name];
        }
      }
      const statedName = kind === "IFSC" || kind === "TXN_REFERENCE" || kind === "NCRP_ACK" || kind === "BANK_SR" || kind === "WEBSITE" ? null : (extra.statedName ?? named ?? statedNameNear(text, index, index + value.length));
      // "Suresh with bank account id …" where Suresh is the complainant: the complainant's own account.
      if (kind === "BANK_ACCOUNT" && r.role === "UNSTATED" && statedName && complainantFirst && statedName.toLowerCase().split(/\s+/)[0] === complainantFirst) {
        Object.assign(r, { role: "VICTIM_ACCOUNT", basis: "the complainant's own account (named as the complainant's)" });
      }
      add({ kind, value, normalized, role: r.role, basis: r.basis, platform, foreign: false, at: where(index), excerpt: text.slice(Math.max(0, index - 60), index + value.length + 20).trim(), ...extra, statedName });
    };
    for (const m of text.matchAll(RE.email)) hit("EMAIL", m[0], m.index);
    for (const m of text.matchAll(RE.url)) {
      const v = m[0].replace(/[.,;:]+$/, "");
      if (!free(m.index, m.index + v.length)) continue;
      const d = domainOf(v);
      if (/^t\.me$/.test(d)) {
        const h = /t\.me\/([A-Za-z0-9_]{3,32})/i.exec(v)?.[1];
        if (h) hit("HANDLE", `@${h}`, m.index, { platform: "Telegram" });
        taken.push([m.index, m.index + v.length]);
        continue;
      }
      if (/^(?:www\.)?(?:x|twitter)\.com$/.test(d)) {
        const h = /(?:x|twitter)\.com\/([A-Za-z0-9_]{2,32})/i.exec(v)?.[1];
        if (h) hit("HANDLE", `@${h}`, m.index, { platform: "X (Twitter)" });
        // A post's own address is the evidence to preserve.
        if (/\/status\/\d+/.test(v)) hit("WEBSITE", v.replace(/\?.*$/, ""), m.index, { platform: "X (Twitter)", basis: "post named in the FIR" });
        taken.push([m.index, m.index + v.length]);
        continue;
      }
      if (BENIGN.test(d)) {
        taken.push([m.index, m.index + v.length]);
        continue;
      }
      hit("WEBSITE", v, m.index);
    }
    for (const m of text.matchAll(RE.domain)) {
      const v = m[0].replace(/[.,;:]+$/, "");
      if (!free(m.index, m.index + v.length) || BENIGN.test(domainOf(v)) || /@/.test(text[m.index - 1] ?? "")) continue;
      // A bare word ending like a domain inside an email or a sentence ("…shop.") needs a dot inside it.
      if (!/[a-z0-9-]\.[a-z]/i.test(v)) continue;
      hit("WEBSITE", v, m.index);
    }
    for (const m of text.matchAll(RE.upi)) if (free(m.index, m.index + m[0].length)) hit("UPI_ID", m[0], m.index);
    for (const m of text.matchAll(RE.handle)) if (free(m.index, m.index + m[0].length)) hit("HANDLE", m[0], m.index);
    for (const m of text.matchAll(RE.ncrp)) {
      const v = m[1] ?? m[2]!;
      const i = m.index + m[0].lastIndexOf(v);
      if (free(i, i + v.length)) hit("NCRP_ACK", v, i, { role: "UNSTATED", basis: "NCRP acknowledgement" });
    }
    for (const m of text.matchAll(RE.sr)) {
      const i = m.index + m[0].lastIndexOf(m[1]!);
      if (free(i, i + m[1]!.length)) hit("BANK_SR", m[1]!, i, { role: "UNSTATED", basis: "bank's service request" });
    }
    for (const m of text.matchAll(RE.txn)) {
      const i = m.index + m[0].lastIndexOf(m[1]!);
      if (/\d{6}/.test(m[1]!) && free(i, i + m[1]!.length)) hit("TXN_REFERENCE", m[1]!, i, { role: "UNSTATED", basis: "transaction reference" });
    }
    for (const m of text.matchAll(RE.account)) {
      const i = m.index + m[0].lastIndexOf(m[1]!);
      if (free(i, i + m[1]!.length)) hit("BANK_ACCOUNT", m[1]!, i);
    }
    for (const m of text.matchAll(RE.ifsc)) if (free(m.index, m.index + m[0].length)) hit("IFSC", m[0], m.index);
    for (const m of text.matchAll(RE.phoneIn)) if (free(m.index, m.index + m[0].length)) hit("PHONE", m[0].trim(), m.index);
    for (const m of text.matchAll(RE.phoneIntl)) {
      const v = m[0].trim();
      const digits = v.replace(/\D/g, "");
      if (digits.length < 8 || digits.length > 15 || !free(m.index, m.index + v.length)) continue;
      hit("PHONE", v, m.index, { foreign: true });
    }
  };

  // Item 7: everything named there is the suspects'.
  // A name entered there is kept as stated for every identifier of that entry.
  for (const a of fir.accused) scan(a.text.value, () => a.text, () => ({ role: "SUSPECT", basis: `named as accused (item 7, serial ${a.serial})` }), accusedName(a.text.value));

  // Item 12: roles from the sentence each value sits in.
  const n = fir.narrative;
  if (n) {
    const intro = n.text.search(/submitted that|stated that|In which (?:he|she|they) stated/i);
    scan(n.text, (i) => narrativeSource(n, i), (i, value, kind) => {
      const ctx = clause(n.text, i, 320).toLowerCase();
      const near = n.text.slice(Math.max(0, i - 90), i).toLowerCase();
      if (intro > 0 && i < intro && (kind === "PHONE" || kind === "EMAIL")) return { role: "COMPLAINANT", basis: "the complainant's own, as the complaint introduces them" };
      if (kind === "BANK_ACCOUNT") {
        // "their Current Account No. …" is the complainant's own, whatever came before it.
        if (/\b(?:his|her|their|my|our)\s+(?:own\s+)?(?:\w+\s+){0,2}(?:account|a\/c)\s*(?:id|no\.?|number)?\.?\s*[:\-–]?\s*$/.test(near)) return { role: "VICTIM_ACCOUNT", basis: "the complainant's own account" };
        // "… to account no. …", "… beneficiary …", and after a money verb a longer way round: "… transactioned to a vendor
        // named X bearing with bank account id - …".
        if (/\b(?:to|into)\s+(?:the\s+)?(?:\w+\s+){0,3}(?:account|a\/c)\s*(?:id|no\.?|number)?\.?\s*[:\-–]?\s*$|beneficiary[^.;]*$/.test(near)) return { role: "BENEFICIARY", basis: "account the money was sent to" };
        if (/\b(?:paid|transferred|transactioned|sent|deposited|credited|remitted|moved)\b[^.;]{0,40}?\b(?:to|into|in favour of)\s+(?:the\s+)?(?:[\w.'’-]+\s+){0,8}?(?:bank\s+)?(?:account|a\/c)\s*(?:id|no\.?|number)?\.?\s*[:\-–]?\s*$/.test(near)) return { role: "BENEFICIARY", basis: "account the money was sent to" };
        if (/\badded\b|\bdeposit/.test(near)) return { role: "BENEFICIARY", basis: "account the money was sent to" };
        return { role: "UNSTATED", basis: "account named in the complaint" };
      }
      if (kind === "WEBSITE") return { role: "SUSPECT", basis: /fraudulent|fake|forged|domain|link|website|web link|url/.test(ctx) ? "website used in the fraud" : "website named in the complaint" };
      if (kind === "HANDLE") return { role: "SUSPECT", basis: "account that contacted or abused the complainant" };
      if (kind === "UPI_ID") return /\b(?:to|into)\b/.test(ctx) ? { role: "BENEFICIARY", basis: "UPI ID the money was sent to" } : { role: "UNSTATED", basis: "UPI ID named in the complaint" };
      if (/fraudster|fake|forged|impersonat|whats\s?app|telegram|group admin|from the number|contacted|caller|called|user\b|suspect|hacked/.test(ctx)) return { role: "SUSPECT", basis: "used by the fraudsters, per the complaint" };
      return { role: "UNSTATED", basis: "named in the complaint" };
    });
  }
  return out;
}

// ───────────────────────────── amounts ───────────────────────────────────────────────────────────────────────────

const AMOUNT_RULES: [AmountKind, RegExp][] = [
  ["RETURNED", /reverted only|returned only|\bwithdrew\b|got back/],
  ["PROFIT_SHOWN", /profit|dashboard|displayed|showed a virtual|account showed|wallet showed/],
  ["PROMISED", /\bearn\b|could earn|per day for|offering|promis/],
  ["DEMANDED", /asked (?:him|her|them) to pay|pay a further|needed to pay|would have to pay|demanded|as tax|commission/],
  ["RETURNED", /returned|reverted|refund|\bwithdrew\b|credited to (?:his|her|their)|received rs|got back/],
  ["LOSS", /wrongful loss|financial loss|lost an amount|loss (?:was|of)|total loss/],
  ["TOTAL_PAID", /transferred a total|a total (?:amount )?of|in total|total amount/],
  ["PAID", /\badded\b|invested|\bpaid\b|transferred|deposited|\bsent\b|recharge|online transfer|was made|debited/],
];

export function firAmounts(fir: CctnsFir): FirAmount[] {
  const n = fir.narrative;
  if (!n) return [];
  const out: FirAmount[] = [];
  for (const m of n.text.matchAll(RE.amount)) {
    const p = parseRupeesToMinor(m[1]!);
    if (!p.ok || p.value <= 0n) continue;
    const ctx = clause(n.text, m.index, 400).toLowerCase();
    // The words right after the figure settle it too: "Rs. 10,000 … per day", "Rs. 6,00,000 for withdrawal access".
    const after = n.text.slice(m.index + m[0].length, m.index + m[0].length + 60).toLowerCase();
    // The words just before the figure decide first; a figure in a list ("added Rs. 1,00,000/-, Rs. 7,50,000/- on …")
    // takes the verb that heads the list.
    const nearest = (w: string): AmountKind | null => {
      let best: { kind: AmountKind; at: number } | null = null;
      for (const [k, re] of AMOUNT_RULES) for (const mm of w.matchAll(new RegExp(re.source, "g"))) if (!best || mm.index + mm[0].length > best.at) best = { kind: k, at: mm.index + mm[0].length };
      return best?.kind ?? null;
    };
    let kind: AmountKind = nearest(ctx.slice(-45)) ?? nearest(ctx.slice(-110)) ?? "OTHER";
    if (kind === "OTHER" && /\b(?:added|invested|paid|transferred|deposited)\b/.test(clause(n.text, m.index, 900).toLowerCase())) kind = "PAID";
    if (/^\s*(?:to rs|per day|a day)/.test(after) || /could earn|earn rs/.test(ctx.slice(-40))) kind = "PROMISED";
    if (/^\s*as profits?|^\s*\(?as profit/.test(after)) kind = "PROFIT_SHOWN";
    const tail = n.text.slice(m.index + m[0].length, m.index + m[0].length + 40);
    const date = RE.date.exec(tail.split(/[;,]\s*(?:rs|inr)/i)[0] ?? "")?.[0] ?? null;
    const reference = /\((?:as stated in the account )?reference\s+(\w{8,22})\)/i.exec(tail)?.[1] ?? null;
    out.push({ kind, summary: /\b(?:returned|reverted) only\s*$|a total (?:amount )?of\s*$/.test(ctx.slice(-40)), text: m[0].trim().replace(/\s*\/-$/, ""), minor: p.value, date, reference, at: narrativeSource(n, m.index), excerpt: n.text.slice(Math.max(0, m.index - 80), m.index + m[0].length + 30).trim() });
  }
  return out;
}

// ───────────────────────────── kind of fraud ───────────────────────────────────────────────────────────────────

export const FRAUD_KINDS = [
  { key: "BEC", label: "Business email compromise", hints: [/vendor/i, /impersonat/i, /account details (?:had been |were )?changed/i, /fake email/i, /business email/i] },
  { key: "ABUSE", label: "Abusive posts online", hints: [/abusive/i, /obscene|vulgar|filthy/i, /derogatory|demeaning|offensive/i, /unparliamentary|insult/i, /comments?|posts?|tweets?/i] },
  { key: "SEXTORTION", label: "Sextortion", hints: [/video call/i, /nude|intimate/i, /morph/i, /sextort/i] },
  { key: "DIGITAL_ARREST", label: "Digital arrest scam", hints: [/digital arrest/i, /CBI|narcotics|customs officer|ED officer/i, /arrest warrant/i, /money laundering/i] },
  { key: "JOB", label: "Part-time job / task fraud", hints: [/part[- ]time/i, /\btasks?\b/i, /work from home/i, /prepaid task|task group|product visibility/i, /\bjob\b/i] },
  { key: "INVESTMENT", label: "Investment / trading fraud", hints: [/\binvest(?:ment|ed|ing)?\b/i, /trading|forex|stock|share market|upper circuit|block trade|IPO/i, /returns|profits?/i, /crypto/i, /institutional account|DEMAT/i] },
  { key: "LOAN", label: "Loan-app extortion", hints: [/loan app|instant loan/i, /\bloan\b/i, /harass/i] },
  { key: "COURIER", label: "Courier-parcel scam", hints: [/courier|parcel/i, /customs/i, /fedex|dhl/i] },
  { key: "OTP", label: "OTP / remote-access fraud", hints: [/\bOTP\b|one[- ]time password/i, /customer care/i, /screen shar|anydesk|teamviewer|remote access/i, /KYC update/i] },
  { key: "ROMANCE", label: "Romance / friendship fraud", hints: [/dating|matrimon/i, /befriend|friendship/i, /gift|customs duty on gift/i] },
] as const;

/** The kind of fraud the complaint describes: the kind whose signs it shows most, each sign counted once. */
export function fraudKind(text: string): { key: string; label: string; score: number } {
  const scored = FRAUD_KINDS.map((k, i) => ({ k, i, score: k.hints.filter((h) => h.test(text)).length }));
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  const best = scored[0]!;
  return best.score >= 2 ? { key: best.k.key, label: best.k.label, score: best.score } : { key: "OTHER", label: "Cyber fraud", score: best.score };
}
