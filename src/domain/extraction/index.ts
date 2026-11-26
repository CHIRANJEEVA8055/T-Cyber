/**
 * RULES_V1 — deterministic, transparent extraction. No model is involved.
 *
 * Every candidate keeps its exact source location (page/line/row + character span) and the
 * original text. Uncertainty is surfaced rather than resolved: masked values, ambiguous roles
 * and malformed figures are flagged for the officer. Nothing is invented: if a pattern is not
 * present in the source text, no candidate is produced.
 */
import { parseRupeesToMinor } from "../money";
import { normalizeIdentifier, isMaskedValue } from "../identifiers";
import { istInputToUtc } from "../time";
import { statedNameNear } from "./fir-entities";
import { cctnsCandidates } from "./cctns-candidates";

export const CANDIDATE_FIELDS = [
  "FIR_REFERENCE",
  "PERSON_NAME",
  "PHONE",
  "EMAIL",
  "UPI_ID",
  "WEBSITE",
  "IP_ADDRESS",
  "BANK_ACCOUNT",
  "IFSC",
  "AMOUNT",
  "DATE_TIME",
  "TXN_REFERENCE",
  "TRANSACTION_ROW",
  "PLATFORM_PROFILE",
] as const;
export type CandidateField = (typeof CANDIDATE_FIELDS)[number];

export type Uncertainty =
  | "NONE"
  | "MASKED"
  | "INCOMPLETE"
  | "UNCERTAIN_CHARACTERS"
  | "AMBIGUOUS_ROLE"
  | "AMBIGUOUS_FORMAT";

export interface SourceLine {
  page: number | null;
  line: number | null;
  row: number | null;
  text: string;
}

export interface ExtractedCandidate {
  field: CandidateField;
  originalValue: string;
  normalizedValue: string;
  structured?: Record<string, string | number | null>;
  roleHint: string | null;
  roleHintBasis: string | null;
  uncertainty: Uncertainty;
  uncertaintyNote: string | null;
  page: number | null;
  line: number | null;
  row: number | null;
  charStart: number | null;
  charEnd: number | null;
  excerpt: string;
}

// ───────────────────────── CSV ─────────────────────────

/** RFC 4180-style CSV parser: quoted fields, escaped quotes, CRLF/LF. Drops empty trailing lines. */
export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && input[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0]?.trim() === ""));
}

// ───────────────────────── Role hints ─────────────────────────

type RoleRule = { pattern: RegExp; hint: string; word: string };

const ROLE_RULES: Partial<Record<CandidateField, RoleRule[]>> = {
  BANK_ACCOUNT: [
    // Possessive only ("complainant's own account", "my account"): "the complainant paid to A/c …" is a beneficiary.
    { pattern: /\b(my|victim'?s|complainant'?s)\s+(?:own\s+)?(?:[A-Za-z]+\s+){0,3}?(?:a\/c|account)\b|\bdebited from\b/i, hint: "Complainant's own account", word: "own account" },
    { pattern: /beneficiar|transferred to|credited to|paid to|sent to|onward|\bto\s+(?:the\s+)?(?:a\/c|account)\b/i, hint: "Reported beneficiary account", word: "beneficiary / transferred to" },
  ],
  PHONE: [
    { pattern: /registered mobile|linked mobile|\bRMN\b/i, hint: "Registered mobile on the account (per bank record)", word: "registered mobile" },
    { pattern: /caller|called from|contacted|whatsapp|telegram|messag|advisor|fraudster|suspect/i, hint: "Contact used by the caller / alleged fraudster", word: "caller / contacted" },
    { pattern: /\b(my|complainant'?s?|victim'?s?)\b[^.]*\b(mobile|phone|number)\b/i, hint: "Complainant's own number", word: "complainant's number" },
  ],
  EMAIL: [
    { pattern: /\b(my|complainant'?s?|victim'?s?)\b[^.]*\bemail\b/i, hint: "Complainant's own email", word: "complainant's email" },
    { pattern: /repl(y|ies)|sent from|came from|advisor|fraud|scam/i, hint: "Email used by the alleged fraudster", word: "replies / sent from" },
  ],
  UPI_ID: [{ pattern: /paid|transferred|beneficiar|via upi|to upi/i, hint: "Reported beneficiary UPI ID", word: "paid / transferred" }],
  WEBSITE: [{ pattern: /website|platform|\bapp\b|link|url|portal/i, hint: "Website or app referenced in the complaint", word: "website / platform" }],
  IP_ADDRESS: [{ pattern: /log(ged)?\s?-?in|accessed|session/i, hint: "Login IP address (per record)", word: "login" }],
  AMOUNT: [
    { pattern: /\bheld\b|\bhold\b|lien|freez/i, hint: "Amount reported as held", word: "held / hold" },
    { pattern: /transferred|paid|debited|lost|\bloss\b|sent/i, hint: "Amount reported as paid or lost", word: "transferred / paid" },
  ],
};

const ROLE_REQUIRED: readonly CandidateField[] = ["BANK_ACCOUNT", "PHONE", "EMAIL", "UPI_ID"];

function roleFor(field: CandidateField, text: string): { hint: string | null; basis: string | null } {
  for (const rule of ROLE_RULES[field] ?? []) {
    if (rule.pattern.test(text)) return { hint: rule.hint, basis: `Line mentions "${rule.word}"` };
  }
  return { hint: null, basis: null };
}

// ───────────────────────── Line rules ─────────────────────────

interface Hit {
  field: CandidateField;
  value: string;
  start: number;
  end: number;
  structured?: Record<string, string | number | null>;
  forceUncertainty?: Uncertainty;
  note?: string;
  roleOverride?: string;
}

const RE = {
  fir: /\bFIR\s*(?:No\.?|Number)?\s*[:.]?\s*(\d{1,6})\s*\/\s*(\d{4})\b/gi,
  maskedPhone: /\+91[\s-]?[Xx*]{4,8}\d{2,6}\b/g,
  phone: /(?<![\dXx*])(?:\+91[\s-]?|0)?[6-9]\d{4}[\s-]?\d{5}(?![\dXx*])/g,
  email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g,
  // A full stop after the handle ends the sentence; a dot followed by more letters would make it an email domain.
  upi: /\b[A-Za-z0-9._-]{2,}@[A-Za-z]{2,}(?![A-Za-z0-9-]|\.[A-Za-z0-9])/g,
  url: /\bhttps?:\/\/[^\s)>,;]+/gi,
  domain: /\b(?:[a-z0-9-]+\.)+(?:invalid|com|in|net|org|io|app|co)\b(?:\/[^\s)>,;]*)?/gi,
  ip: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
  account: /\b(?:A\/c|Account|Acct)\.?\s*(?:No\.?|Number)?\s*[:.-]?\s*([Xx*\d]{2,}(?:[ -][Xx*\d]{2,}){0,4})/gi,
  ifsc: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g,
  amount: /(?:Rs\.?|INR|₹)\s?(\d[\d,]*(?:\.\d{1,2})?)(?:\s*\/-)?/gi,
  dateTime: /\b(\d{2})[-/.](\d{2})[-/.](\d{4})(?:[ ,T]+(\d{2}):(\d{2})(?::(\d{2}))?)?/g,
  // "?" stands for a character the copy does not show; such a reference is kept as read and marked uncertain.
  txnRef: /\b(?:UTR|RRN|UPI\s+ref(?:erence)?|Txn\.?\s?(?:ID|Ref)|Transaction\s(?:ID|Ref(?:erence)?))\s*(?:No\.?)?\s*[:.-]?\s*([A-Z0-9?]{8,22})(?![A-Z0-9?])/gi,
  profile: /\bprofile (?:named|called|name)\s*:?\s*["“]([^"”]{2,40})["”]/gi,
  name: /\b(Name of (?:the )?complainant|Complainant(?:'s)? name|Complainant|Name of (?:the )?account holder|Account holder(?:'s)? name|Account holder)\s*[:-]\s*([A-Z][A-Za-z0-9.' ]{1,60}?)\s*(?=\(|,|;|$)/g,
};

function overlaps(a: { start: number; end: number }, spans: { start: number; end: number }[]): boolean {
  return spans.some((s) => a.start < s.end && s.start < a.end);
}

function findHits(text: string, source: TextSource = "STATEMENT_OF_COMPLAINANT"): Hit[] {
  const hits: Hit[] = [];
  const taken: { start: number; end: number }[] = [];
  const push = (h: Hit) => {
    hits.push(h);
    taken.push({ start: h.start, end: h.end });
  };

  for (const m of text.matchAll(RE.fir)) {
    push({ field: "FIR_REFERENCE", value: `${m[1]}/${m[2]}`, start: m.index, end: m.index + m[0].length, structured: { number: Number(m[1]), year: Number(m[2]) } });
  }
  for (const m of text.matchAll(RE.name)) {
    const label = (m[1] ?? "").toLowerCase();
    const value = (m[2] ?? "").trim();
    const start = m.index + m[0].indexOf(value, (m[1] ?? "").length);
    push({
      field: "PERSON_NAME",
      value,
      start,
      end: start + value.length,
      // Only a bank's own record names the holder on record; in a complaint the name is what was stated.
      roleOverride: label.includes("complainant") ? "Complainant" : source === "RECORD" ? "Account holder on record (per bank)" : "Name stated for the account (not verified)",
    });
  }
  for (const m of text.matchAll(RE.profile)) {
    const value = (m[1] ?? "").trim();
    const start = m.index + m[0].indexOf(value);
    push({ field: "PLATFORM_PROFILE", value, start, end: start + value.length, roleOverride: "Profile that contacted the complainant (per the FIR)" });
  }
  for (const m of text.matchAll(RE.email)) {
    push({ field: "EMAIL", value: m[0], start: m.index, end: m.index + m[0].length });
  }
  for (const m of text.matchAll(RE.upi)) {
    const span = { start: m.index, end: m.index + m[0].length };
    if (!overlaps(span, taken)) push({ field: "UPI_ID", value: m[0], ...span });
  }
  for (const m of text.matchAll(RE.url)) {
    const span = { start: m.index, end: m.index + m[0].length };
    if (!overlaps(span, taken)) push({ field: "WEBSITE", value: m[0], ...span });
  }
  for (const m of text.matchAll(RE.domain)) {
    const span = { start: m.index, end: m.index + m[0].length };
    if (!overlaps(span, taken) && text[m.index - 1] !== "@") push({ field: "WEBSITE", value: m[0], ...span });
  }
  for (const m of text.matchAll(RE.account)) {
    const value = (m[1] ?? "").trim();
    const start = m.index + m[0].lastIndexOf(value);
    const span = { start, end: start + value.length };
    if (/\d/.test(value) && !overlaps(span, taken)) push({ field: "BANK_ACCOUNT", value, ...span });
  }
  for (const m of text.matchAll(RE.maskedPhone)) {
    const span = { start: m.index, end: m.index + m[0].length };
    if (!overlaps(span, taken)) push({ field: "PHONE", value: m[0], ...span });
  }
  for (const m of text.matchAll(RE.phone)) {
    const span = { start: m.index, end: m.index + m[0].length };
    if (!overlaps(span, taken)) push({ field: "PHONE", value: m[0], ...span });
  }
  for (const m of text.matchAll(RE.ip)) {
    const span = { start: m.index, end: m.index + m[0].length };
    const valid = m[0].split(".").every((o) => Number(o) <= 255);
    if (valid && !overlaps(span, taken)) push({ field: "IP_ADDRESS", value: m[0], ...span });
  }
  for (const m of text.matchAll(RE.ifsc)) {
    const span = { start: m.index, end: m.index + m[0].length };
    if (!overlaps(span, taken)) push({ field: "IFSC", value: m[0], ...span });
  }
  for (const m of text.matchAll(RE.txnRef)) {
    const value = m[1] ?? "";
    const start = m.index + m[0].lastIndexOf(value);
    const span = { start, end: start + value.length };
    const hidden = (value.match(/\?/g) ?? []).length;
    if (!overlaps(span, taken)) {
      push(
        hidden
          ? { field: "TXN_REFERENCE", value, ...span, forceUncertainty: "UNCERTAIN_CHARACTERS", note: `${hidden} ${hidden === 1 ? "character" : "characters"} could not be read. They stay unknown and are never guessed; ask for a clearer copy.` }
          : { field: "TXN_REFERENCE", value, ...span },
      );
    }
  }
  for (const m of text.matchAll(RE.amount)) {
    const span = { start: m.index, end: m.index + m[0].length };
    if (overlaps(span, taken)) continue;
    const parsed = parseRupeesToMinor(m[1] ?? "");
    push(
      parsed.ok
        ? { field: "AMOUNT", value: m[0].trim(), ...span, structured: { amountMinor: parsed.value.toString() } }
        : {
            field: "AMOUNT",
            value: m[0].trim(),
            ...span,
            forceUncertainty: "UNCERTAIN_CHARACTERS",
            note: `The figure could not be read reliably (${parsed.error}) Check the original.`,
          },
    );
  }
  for (const m of text.matchAll(RE.dateTime)) {
    const span = { start: m.index, end: m.index + m[0].length };
    if (overlaps(span, taken)) continue;
    const [, dd, mm, yyyy, hh, mi, ss] = m;
    const iso = `${yyyy}-${mm}-${dd}${hh ? `T${hh}:${mi}${ss ? `:${ss}` : ""}` : ""}`;
    const date = istInputToUtc(iso);
    push(
      date
        ? { field: "DATE_TIME", value: m[0], ...span, structured: { iso: date.toISOString() }, note: hh ? "Read as DD-MM-YYYY in IST." : "Date only; no time stated. Read as DD-MM-YYYY." }
        : { field: "DATE_TIME", value: m[0], ...span, forceUncertainty: "AMBIGUOUS_FORMAT", note: "Not a valid DD-MM-YYYY date. Check the original." },
    );
  }
  return hits.sort((a, b) => a.start - b.start);
}

function normalizedFor(field: CandidateField, value: string): string {
  switch (field) {
    case "PHONE":
    case "EMAIL":
    case "UPI_ID":
    case "WEBSITE":
    case "IP_ADDRESS":
    case "BANK_ACCOUNT":
      return normalizeIdentifier(field, value);
    case "IFSC":
    case "TXN_REFERENCE":
      return value.toUpperCase();
    default:
      return value.trim();
  }
}

/**
 * What a document is: a complainant's or officer's account (an FIR, a complaint, a statement), where a name given
 * for an account is only stated; or a record of the bank or provider itself, where it is the holder on record.
 */
export type TextSource = "STATEMENT_OF_COMPLAINANT" | "RECORD";

export function extractFromLines(lines: readonly SourceLine[], opts: { source?: TextSource } = {}): ExtractedCandidate[] {
  // A CCTNS FIR is read item by item, with each identifier's role from the FIR's own words; only dates and IP
  // addresses come from the line rules below.
  const cctns = cctnsCandidates(lines);
  if (cctns) return [...cctns, ...lineCandidates(lines, "STATEMENT_OF_COMPLAINANT").filter((c) => c.field === "DATE_TIME" || c.field === "IP_ADDRESS")];
  const out = lineCandidates(lines, opts.source ?? "STATEMENT_OF_COMPLAINANT");
  return [...out, ...paymentsInText(lines, out)];
}

const STATED_FIELDS: string[] = ["BANK_ACCOUNT", "UPI_ID", "PHONE", "EMAIL", "PLATFORM_PROFILE"];

function lineCandidates(lines: readonly SourceLine[], source: TextSource): ExtractedCandidate[] {
  const out: ExtractedCandidate[] = [];
  for (const src of lines) {
    for (const hit of findHits(src.text, source)) {
      const role = hit.roleOverride ? { hint: hit.roleOverride, basis: "Stated by the field label" } : roleFor(hit.field, src.text);
      const masked = isMaskedValue(hit.value);
      let uncertainty: Uncertainty = hit.forceUncertainty ?? "NONE";
      const notes: string[] = hit.note ? [hit.note] : [];
      if (uncertainty === "NONE" && masked) {
        uncertainty = "MASKED";
        notes.push("Partly masked in the source document; the full value is not available.");
      }
      if (ROLE_REQUIRED.includes(hit.field) && role.hint === null) {
        if (uncertainty === "NONE") uncertainty = "AMBIGUOUS_ROLE";
        notes.push("The document does not state whose identifier this is. Assign a role during review.");
      }
      // In a complaint, a name given beside an account, number or email is kept only as stated.
      const stated = source === "STATEMENT_OF_COMPLAINANT" && STATED_FIELDS.includes(hit.field) ? statedNameNear(src.text, hit.start, hit.end) : null;
      const structured = stated ? { ...(hit.structured ?? {}), statedName: stated, statedNameBasis: "As stated in the complaint; not verified" } : hit.structured;
      out.push({
        field: hit.field,
        originalValue: hit.value,
        normalizedValue: normalizedFor(hit.field, hit.value),
        ...(structured ? { structured } : {}),
        roleHint: stated && role.hint ? `${role.hint}; stated to be “${stated}” (per the complaint, not verified)` : role.hint,
        roleHintBasis: role.basis,
        uncertainty,
        uncertaintyNote: notes.length ? notes.join(" ") : null,
        page: src.page,
        line: src.line,
        row: src.row,
        charStart: hit.start,
        charEnd: hit.end,
        excerpt: src.text,
      });
    }
  }
  return out;
}

/**
 * Payment lines in narrative documents (an FIR's "Rs. 10,00,000 paid to A/c No. …, IFSC …, UTR No. …")
 * become one payment row each, like a row of a receipts table, so applying them records the money
 * trail. The separate identifiers stay as candidates too. A stated total is never a payment.
 */
function paymentsInText(lines: readonly SourceLine[], found: readonly ExtractedCandidate[]): ExtractedCandidate[] {
  const out: ExtractedCandidate[] = [];
  const at = (c: { page: number | null; line: number | null }, page: number | null, line: number | null) => c.page === page && c.line === line;
  for (const src of lines) {
    if (src.line == null || /\btotal\b/i.test(src.text) || !/\b(?:paid|transferred|sent|deposited|credited)\b/i.test(src.text)) continue;
    const here = found.filter((c) => at(c, src.page, src.line));
    const amount = here.find((c) => c.field === "AMOUNT");
    const account = here.find((c) => c.field === "BANK_ACCOUNT" || c.field === "UPI_ID");
    if (!amount || !account || typeof amount.structured?.amountMinor !== "string") continue;
    const next = lines.find((l) => l.page === src.page && l.line === src.line! + 1);
    // A continuation line (indented, or starting with a bracket) carries the bank, mode and UTR.
    const cont = next && /^\s|^\(/.test(next.text) && !/^\s*\(?[a-z]\)\s/i.test(next.text.trimStart()) ? next : null;
    const near = (field: ExtractedCandidate["field"]) => here.find((c) => c.field === field) ?? (cont ? found.find((c) => c.field === field && at(c, cont.page, cont.line)) : undefined);
    const when = near("DATE_TIME");
    const reference = near("TXN_REFERENCE")?.originalValue ?? null;
    const ifsc = near("IFSC")?.originalValue ?? null;
    const bank = cont ? (/\(([^)]*\bbank\b[^)]*)\)/i.exec(cont.text)?.[1] ?? null) : null;
    const channel = detectChannel(`${src.text} ${cont?.text ?? ""}`);
    const occurredAt = typeof when?.structured?.iso === "string" ? when.structured.iso : null;
    const notes: string[] = [];
    let uncertainty: Uncertainty = "NONE";
    if (!occurredAt) {
      uncertainty = "INCOMPLETE";
      notes.push("No date and time on this payment line.");
    } else if (account.uncertainty === "MASKED") {
      uncertainty = "MASKED";
      notes.push("Beneficiary account is partly masked in the source.");
    }
    out.push({
      field: "TRANSACTION_ROW",
      originalValue: `${when?.originalValue ?? "Undated"}, paid ${amount.originalValue} to ${account.originalValue}${reference ? ` (ref ${reference})` : ""}`,
      normalizedValue: reference ? reference.toUpperCase() : `${occurredAt ?? "undated"}|${amount.structured.amountMinor}|${account.normalizedValue}`,
      structured: {
        occurredAt,
        amountMinor: amount.structured.amountMinor,
        direction: "DEBIT",
        counterpartyAccount: account.originalValue,
        counterpartyIfsc: ifsc,
        counterpartyBank: bank,
        reference,
        description: null,
        channel,
      },
      roleHint: "Payment reported by the complainant",
      roleHintBasis: "Payment line in the document",
      uncertainty,
      uncertaintyNote: notes.length ? notes.join(" ") : null,
      page: src.page,
      line: src.line,
      row: null,
      charStart: null,
      charEnd: null,
      excerpt: cont ? `${src.text} ${cont.text.trim()}` : src.text,
    });
  }
  return out;
}

// ───────────────────────── Tables ─────────────────────────

/** Column headings as banks and CSV exports write them, compared after dropping case and punctuation. */
const COLUMN_SYNONYMS: Record<string, string[]> = {
  date: ["date", "txn date", "transaction date", "value date", "date/time", "datetime", "date & time", "date and time", "tran date", "txn dt", "trans date", "posting date", "transaction date and time", "transaction date time", "txn date time"],
  time: ["time", "txn time", "transaction time"],
  amount: ["amount", "amount (inr)", "amount (rs)", "txn amount", "amount (rs.)", "transaction amount", "amount in rs", "amount in inr", "amt"],
  debit: ["debit", "withdrawal", "dr", "debit (inr)", "debit amount", "withdrawal amt", "withdrawals", "withdrawal amount", "debit amt", "dr amount", "amount debited", "withdrawal dr", "debits"],
  credit: ["credit", "deposit", "cr", "credit (inr)", "credit amount", "deposit amt", "deposits", "deposit amount", "credit amt", "cr amount", "amount credited", "deposit cr", "credits"],
  drcr: ["dr/cr", "cr/dr", "debit/credit", "credit/debit", "transaction type", "txn type", "dr cr indicator", "type dr cr"],
  reference: ["utr", "rrn", "utr/rrn", "reference", "ref no", "ref no.", "txn id", "transaction id", "utr no", "utr no.", "utr number", "rrn no", "rrn number", "chq/ref no", "chq ref no", "cheque no", "chq no", "ref no/chq no", "reference no", "reference number", "transaction reference", "ref number", "chq/ref number"],
  account: ["counterparty a/c", "counterparty account", "beneficiary account", "beneficiary a/c", "to account", "beneficiary account no", "account", "a/c no", "account number", "beneficiary account number", "beneficiary acct no", "credited account", "to account number", "beneficiary a/c no", "payee account", "remitter account", "counterparty account number"],
  ifsc: ["counterparty ifsc", "beneficiary ifsc", "ifsc", "ifsc code", "beneficiary ifsc code", "payee ifsc"],
  bank: ["counterparty bank", "beneficiary bank", "bank name", "bank", "beneficiary bank name"],
  description: ["description", "narration", "remarks", "particulars", "details", "transaction remarks", "transaction details", "transaction particulars", "transaction description"],
  mode: ["mode", "channel", "payment mode", "type", "txn mode", "transaction mode"],
};
const headingKey = (h: string) => h.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const SYNONYM_KEYS = Object.fromEntries(Object.entries(COLUMN_SYNONYMS).map(([k, v]) => [k, v.map(headingKey)]));

function mapColumns(header: string[]): Record<string, number> {
  const normalized = header.map(headingKey);
  const map: Record<string, number> = {};
  for (const [key, synonyms] of Object.entries(SYNONYM_KEYS)) {
    const idx = normalized.findIndex((h, i) => synonyms.includes(h) && !Object.values(map).includes(i));
    if (idx >= 0) map[key] = idx;
  }
  return map;
}

const MONTHS: Record<string, string> = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", sept: "09", oct: "10", nov: "11", dec: "12" };

/** A statement date in IST: 03-10-2026, 03/10/26, 03-Oct-2026, 3 Oct 2026, 2026-10-03, with an optional time (and AM/PM). */
export function parseTableDate(raw: string): Date | null {
  const v = raw.trim().replace(/\s+/g, " ");
  const m = /^(\d{1,2})[-/. ]([A-Za-z]{3,4}|\d{1,2})[-/. ,]+(\d{4}|\d{2})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?$/.exec(v);
  if (m) {
    const [, d, mon, y, h, mi, ss, ap] = m;
    const mm = /^\d+$/.test(mon!) ? mon!.padStart(2, "0") : MONTHS[mon!.toLowerCase()];
    if (!mm || Number(mm) > 12 || Number(d) > 31) return null;
    const yyyy = y!.length === 2 ? `20${y}` : y!;
    let hh = h ? Number(h) : null;
    if (hh !== null && ap) hh = (hh % 12) + (/p/i.test(ap) ? 12 : 0);
    return istInputToUtc(`${yyyy}-${mm}-${d!.padStart(2, "0")}${hh !== null ? `T${String(hh).padStart(2, "0")}:${mi}${ss ? `:${ss}` : ""}` : ""}`);
  }
  return /^\d{4}-\d{2}-\d{2}/.test(v) ? istInputToUtc(v.replace(" ", "T")) : null;
}

/** "0.00", "-" or blank in the column a row does not use. */
const noAmount = (v: string) => !/[1-9]/.test(v);

function detectChannel(text: string): string | null {
  const m = /\b(IMPS|NEFT|RTGS|UPI|ATM|CASH)\b/i.exec(text);
  if (!m) return null;
  const v = (m[1] ?? "").toUpperCase();
  return v === "ATM" || v === "CASH" ? "CASH_WITHDRAWAL" : v;
}

/** A statement's heading row and its recognised columns (the same reading extractFromTable makes), or null. */
export function statementHeader(rows: string[][]): { headerAt: number; cols: Record<string, number>; header: string[] } | null {
  const at = rows.slice(0, 25).findIndex((h) => {
    const c = mapColumns(h);
    return c.date !== undefined && (c.amount !== undefined || c.debit !== undefined || c.credit !== undefined);
  });
  if (at < 0) return null;
  return { headerAt: at, cols: mapColumns(rows[at]!), header: rows[at]! };
}

export function extractFromTable(rows: string[][]): { recognised: boolean; candidates: ExtractedCandidate[]; note: string | null } {
  // Bank statements open with title rows (bank, holder, period): the headings are the first row naming a date and an amount.
  const usable = (h: string[]) => {
    const c = mapColumns(h);
    return c.date !== undefined && (c.amount !== undefined || c.debit !== undefined || c.credit !== undefined);
  };
  const headerAt = Math.max(0, rows.slice(0, 25).findIndex(usable));
  const header = rows[headerAt] ?? [];
  const cols = mapColumns(header);
  const hasAmount = cols.amount !== undefined || cols.debit !== undefined || cols.credit !== undefined;
  if (cols.date === undefined || !hasAmount) {
    return {
      recognised: false,
      candidates: [],
      note: `Column headings not recognised (found: ${header.map((h) => h.trim()).filter(Boolean).join(", ") || "none"}). The file is stored as an original; review it manually.`,
    };
  }
  const cell = (r: string[], key: string) => (cols[key] === undefined ? "" : (r[cols[key] as number] ?? "").trim());
  const candidates: ExtractedCandidate[] = [];
  rows.slice(headerAt + 1).forEach((r, i) => {
    const rowNo = headerAt + i + 2; // row numbers as in the source file
    const dateText = [cell(r, "date"), cell(r, "time")].filter(Boolean).join(" ");
    const debit = noAmount(cell(r, "debit")) ? "" : cell(r, "debit");
    const credit = noAmount(cell(r, "credit")) ? "" : cell(r, "credit");
    const single = noAmount(cell(r, "amount")) ? "" : cell(r, "amount");
    // Blank lines, page footers and opening/closing balance lines are not transactions.
    if (!dateText && !debit && !credit && !single) return;
    if (/^(opening|closing) balance|^balance (b\/f|c\/f|brought|carried)|^total/i.test(`${cell(r, "description")} ${r.join(" ")}`.trim()) && !dateText) return;
    const date = parseTableDate(dateText);
    const amountText = single || debit || credit;
    const drcr = cell(r, "drcr").toUpperCase();
    const direction = debit ? "DEBIT" : credit ? "CREDIT" : /^D|DEBIT|WITHDRAW/.test(drcr) ? "DEBIT" : /^C|CREDIT|DEPOSIT/.test(drcr) ? "CREDIT" : "UNKNOWN";
    const parsed = amountText ? parseRupeesToMinor(amountText) : null;
    const notes: string[] = [];
    let uncertainty: Uncertainty = "NONE";
    if (!date) {
      uncertainty = "AMBIGUOUS_FORMAT";
      notes.push(`Date "${dateText}" could not be read.`);
    }
    if (!parsed || !parsed.ok) {
      uncertainty = amountText ? "UNCERTAIN_CHARACTERS" : "INCOMPLETE";
      notes.push(amountText ? `Amount "${amountText}" could not be read reliably.` : "No amount on this row.");
    }
    const account = cell(r, "account");
    if (uncertainty === "NONE" && isMaskedValue(account)) {
      uncertainty = "MASKED";
      notes.push("Counterparty account is partly masked in the source.");
    }
    const reference = cell(r, "reference");
    const description = cell(r, "description");
    const amountMinor = parsed && parsed.ok ? parsed.value.toString() : null;
    const summary = `${dateText || "Undated"}, ${direction.toLowerCase()} ${amountText || "no amount"}${account ? ` with ${account}` : ""}${reference ? ` (ref ${reference})` : ""}`;
    candidates.push({
      field: "TRANSACTION_ROW",
      originalValue: summary,
      normalizedValue: reference ? reference.toUpperCase() : `${date?.toISOString() ?? dateText}|${amountMinor ?? amountText}|${normalizeIdentifier("BANK_ACCOUNT", account)}`,
      structured: {
        occurredAt: date ? date.toISOString() : null,
        amountMinor,
        direction,
        counterpartyAccount: account || null,
        counterpartyIfsc: cell(r, "ifsc") || null,
        counterpartyBank: cell(r, "bank") || null,
        reference: reference || null,
        description: description || null,
        channel: cell(r, "mode") || detectChannel(description),
      },
      roleHint: direction === "DEBIT" ? "Outgoing transfer from the account in this statement" : direction === "CREDIT" ? "Incoming credit to the account in this statement" : null,
      roleHintBasis: direction === "UNKNOWN" ? null : `"${direction === "DEBIT" ? "Debit" : "Credit"}" column`,
      uncertainty,
      uncertaintyNote: notes.length ? notes.join(" ") : null,
      page: null,
      line: null,
      row: rowNo,
      charStart: null,
      charEnd: null,
      excerpt: r.join(", "),
    });
  });
  return { recognised: true, candidates, note: null };
}
