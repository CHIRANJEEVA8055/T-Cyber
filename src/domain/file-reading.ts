/**
 * Reads a file an officer adds to a case (a bank statement, call records, a letter or any document) against what the
 * case already knows, and keeps only what relates to this FIR:
 *  - a bank statement: the rows with the case's accounts, UPI IDs, numbers or references, and the complainant's money
 *    followed out of the account (debits after it arrived, until that amount had all left);
 *  - call records: calls with the case's numbers, the handsets used, and cell sites around the time of the offence;
 *  - any other document: identifiers the case already has, and new ones written next to them.
 * Everything else is counted and left out, with the reason. Each proposal keeps its row or line so it can be traced.
 * Nothing is guessed: a value that is not in the file is never proposed. Pure: no I/O.
 */
import { extractFromLines, extractFromTable, parseTableDate, statementHeader, type SourceLine } from "./extraction";
import { isMaskedValue, normalizeIdentifier, shownId } from "./identifiers";
import { formatInr, parseRupeesToMinor } from "./money";
import { formatDateIST, formatDayMonthIST, formatTimeIST } from "./time";

export interface KnownId {
  id: string;
  kind: string;
  value: string;
  normalized: string;
  label: string;
  victim: boolean;
}
export interface KnownTxn {
  id: string;
  fromId: string;
  toId: string;
  amountMinor: bigint;
  occurredAt: Date;
  reference: string | null;
  kind: string;
}
export interface CaseKnowledge {
  ids: KnownId[];
  txns: KnownTxn[];
  /** The period of the offence (for cell sites and for the complainant's payments). */
  windowFrom: Date | null;
  windowTo: Date | null;
}

/** An entity already in the case, or one this reading would add (by its proposal key). */
export type Ref = { id: string; label: string } | { key: string; label: string };
export interface Src {
  locator: string;
  excerpt: string;
  row: number | null;
  line: number | null;
  page: number | null;
}
export type IdentifierKind = "BANK_ACCOUNT" | "UPI_ID" | "PHONE" | "EMAIL" | "WEBSITE" | "IP_ADDRESS" | "DEVICE";
interface Base {
  key: string;
  /** One plain sentence for the officer. */
  text: string;
  src: Src;
  /** Keys of the proposals this one needs (an account it adds, for a transfer into it). */
  needs: string[];
}
export type Proposal =
  | (Base & { type: "IDENTIFIER"; kind: IdentifierKind; value: string; role: string; attrs: Record<string, string | boolean> })
  | (Base & { type: "TRANSFER"; from: Ref; to: Ref; amountMinor: string; occurredAt: string; reference: string | null; channel: string })
  | (Base & { type: "CASH"; from: Ref; amountMinor: string; occurredAt: string; place: string | null; terminal: string | null })
  | (Base & { type: "CONFIRMS"; transactionId: string })
  | (Base & { type: "MENTION"; entityId: string })
  | (Base & { type: "LINK"; a: Ref; b: Ref; rel: "CONTACTED" | "LINKED_IDENTIFIER"; statement: string })
  | (Base & { type: "LOCATION"; of: Ref; place: string; at: string | null; until: string | null })
  | (Base & { type: "NAME"; of: Ref; name: string })
  | (Base & { type: "NCRP_TRAIL"; rows: number });

export type FileKind = "BANK_STATEMENT" | "CALL_RECORDS" | "NCRP_TRAIL" | "DOCUMENT" | "NOTHING_READABLE";
export interface FileReadingResult {
  kind: FileKind;
  /** "Bank statement of Account B (···2093)" */
  title: string;
  /** What the file is: its period, rows, holder. */
  about: string[];
  summary: string;
  /** Things worth knowing that are not records: a mule pattern, the balance left, top contacts. */
  insights: string[];
  proposals: Proposal[];
  /** Rows or lines that were read but have nothing to do with this FIR. */
  leftOut: string | null;
  notes: string[];
  total: number;
  relevant: number;
}

// ───────────────────────── Helpers ─────────────────────────

const DAY = 24 * 3600 * 1000;
const inr = (m: bigint | string) => formatInr(BigInt(m));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const UPI_RE = /\b[a-z0-9][a-z0-9._-]{1,63}@[a-z][a-z0-9]{1,30}\b(?!\.[a-z])/gi;
const EMAIL_RE = /\b[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+\b/gi;
const PHONE_RE = /(?<![\dA-Za-z])(?:\+?91[-\s]?|0)?([6-9]\d{9})(?![\dA-Za-z])/g;
const LONG_DIGITS_RE = /(?<![\dA-Za-z])(\d{9,18})(?![\dA-Za-z])/g;
const MASKED_ACCOUNT_RE = /(?<![\dA-Za-z])([X*x•]{2,}[\dX*x•]*\d{3,6})(?![\dA-Za-z])/g;
const IFSC_RE = /\b([A-Z]{4}0[A-Z0-9]{6})\b/;
const UTR_ALNUM_RE = /\b([A-Z]{4}[RHN]?\d{8,18}|[A-Z]{4}\d[A-Z0-9]{9,17})\b/g;

/** How an account in a file compares with one in the case: the same, possibly the same (one is masked), or not. */
export function compareAccounts(a: string, b: string): "SAME" | "POSSIBLE" | null {
  const na = normalizeIdentifier("BANK_ACCOUNT", a);
  const nb = normalizeIdentifier("BANK_ACCOUNT", b);
  if (!na || !nb) return null;
  if (na === nb) return "SAME";
  const ma = na.includes("X");
  const mb = nb.includes("X");
  if (!ma && !mb) return null;
  const da = na.replace(/X/g, "");
  const db = nb.replace(/X/g, "");
  const ta = /(\d{4,})$/.exec(na)?.[1];
  const tb = /(\d{4,})$/.exec(nb)?.[1];
  if (!ta || !tb || da.length < 4 || db.length < 4) return null;
  const n = Math.min(ta.length, tb.length);
  if (ta.slice(-n) !== tb.slice(-n)) return null;
  // Same length with every shown digit in place: possibly the same account.
  if (na.length === nb.length) {
    for (let i = 0; i < na.length; i++) if (na[i] !== "X" && nb[i] !== "X" && na[i] !== nb[i]) return null;
  }
  return "POSSIBLE";
}

function findKnown(know: CaseKnowledge, kind: string, value: string): { id: KnownId; how: "SAME" | "POSSIBLE" } | null {
  const pool = know.ids.filter((k) => k.kind === kind);
  if (kind === "BANK_ACCOUNT" || kind === "WALLET") {
    const same = pool.find((k) => compareAccounts(k.value, value) === "SAME");
    if (same) return { id: same, how: "SAME" };
    const possible = pool.filter((k) => compareAccounts(k.value, value) === "POSSIBLE");
    return possible.length === 1 ? { id: possible[0]!, how: "POSSIBLE" } : null;
  }
  const n = normalizeIdentifier(kind, value);
  const hit = pool.find((k) => k.normalized === n);
  return hit ? { id: hit, how: "SAME" } : null;
}

const knownRef = (know: CaseKnowledge, ref: string) => know.txns.find((t) => t.reference && t.reference.toUpperCase() === ref.toUpperCase()) ?? null;

function shortLabel(k: { kind: string; value: string; label: string }) {
  if (k.label && k.label !== k.value) return k.label;
  if (k.kind === "BANK_ACCOUNT") return `account ${shownId(k.value)}`;
  if (k.kind === "PHONE") return `mobile ${shownId(k.value)}`;
  if (k.kind === "UPI_ID") return `UPI ID ${k.value}`;
  return k.value;
}

// ───────────────────────── Bank statements ─────────────────────────

interface StatementSubject {
  known: KnownId | null;
  how: "SAME" | "POSSIBLE" | null;
  value: string | null;
  holder: string | null;
  ifsc: string | null;
  bank: string | null;
  period: string | null;
}

const ACCOUNT_LABEL = /\b(a\/?c|acct|account)\b\.?\s*(no|number|num)?\b/i;
const HOLDER_LABEL = /\b(account\s*name|customer\s*name|name of (the )?(account )?holder|holder'?s? name|a\/c name)\b/i;

/** The account a statement is for, its holder and period, from the title rows above the table and the file name. */
export function statementSubject(titleRows: string[][], fileName: string, know: CaseKnowledge): StatementSubject {
  const cells = titleRows.flat().map((c) => c.replace(/\s+/g, " ").trim()).filter(Boolean);
  const values: string[] = [];
  let holder: string | null = null;
  let ifsc: string | null = null;
  let bank: string | null = null;
  let period: string | null = null;
  const after = (i: number, label: RegExp) => {
    const c = cells[i]!;
    const m = label.exec(c);
    const rest = m ? c.slice(m.index + m[0].length).replace(/^[\s:.\-–]+/, "").trim() : "";
    return rest || (cells[i + 1] ?? "");
  };
  cells.forEach((c, i) => {
    if (ACCOUNT_LABEL.test(c) && !/name|type|branch|open|status|currency/i.test(c.replace(ACCOUNT_LABEL, ""))) {
      const v = after(i, ACCOUNT_LABEL);
      const m = /([X*x•\d][X*x•\d\s-]{6,24}\d)/.exec(v);
      if (m) values.push(m[1]!.replace(/[\s-]/g, ""));
    }
    if (!holder && HOLDER_LABEL.test(c)) {
      const v = after(i, HOLDER_LABEL).replace(/^(mr|mrs|ms|shri|smt)\.?\s+/i, "");
      if (/^[A-Za-z][A-Za-z .']{2,60}$/.test(v)) holder = v.trim();
    }
    if (!ifsc) ifsc = IFSC_RE.exec(c)?.[1] ?? null;
    if (!bank && /\bbank\b/i.test(c) && c.length <= 60 && !/statement|account|branch|ifsc|address/i.test(c)) bank = c;
    if (!period) {
      const p = /(?:from|period)\s*:?\s*(\d{1,2}[-/.][A-Za-z0-9]{2,3}[-/.]\d{2,4})\s*(?:to|-|till)\s*(\d{1,2}[-/.][A-Za-z0-9]{2,3}[-/.]\d{2,4})/i.exec(c);
      if (p) period = `${p[1]} to ${p[2]}`;
    }
  });
  // A cell that is only an account number is a weaker sign; the file name is the last resort.
  if (!values.length) for (const c of cells) if (/^[X*x•\d]{9,18}$/.test(c.replace(/[\s-]/g, "")) && /\d{4}$/.test(c)) values.push(c.replace(/[\s-]/g, ""));
  if (!values.length) for (const m of fileName.matchAll(/(?<!\d)(\d{9,18})(?!\d)/g)) values.push(m[1]!);
  for (const v of values) {
    const k = findKnown(know, "BANK_ACCOUNT", v);
    if (k) return { known: k.id, how: k.how, value: v, holder, ifsc, bank, period };
  }
  return { known: null, how: null, value: values[0] ?? null, holder, ifsc, bank, period };
}

/** What a narration says about the other side of a row: a UPI ID, an account, a phone, references, an ATM. */
export function readNarration(text: string) {
  const t = text ?? "";
  const emails = new Set((t.match(EMAIL_RE) ?? []).map((e) => e.toLowerCase()));
  // Many banks separate a narration's fields with hyphens ("UPI-NAME-vpa@bank-ref"): there a hyphen ends the UPI ID.
  const hyphenFields = /^\s*(UPI|IMPS|NEFT|RTGS|MMT|BIL|POS|ATM)-/i.test(t) || (t.match(/-/g) ?? []).length >= 3;
  const upiRe = hyphenFields ? /\b[a-z0-9][a-z0-9._]{1,63}@[a-z][a-z0-9]{1,30}\b(?!\.[a-z])/gi : UPI_RE;
  const upis = [...new Set((t.match(upiRe) ?? []).map((u) => u.toLowerCase()))].filter((u) => !emails.has(u) && ![...emails].some((e) => e.startsWith(u)));
  const digits = [...t.matchAll(LONG_DIGITS_RE)].map((m) => m[1]!);
  const masked = [...t.matchAll(MASKED_ACCOUNT_RE)].map((m) => m[1]!);
  const phones = [...new Set([...t.matchAll(PHONE_RE)].map((m) => m[1]!))];
  const alnumRefs = [...t.toUpperCase().matchAll(UTR_ALNUM_RE)].map((m) => m[1]!).filter((r) => /\d{6,}/.test(r));
  const atm = /\b(ATM|ATW|NWD|CASH\s*W(?:ITH)?D(?:RAWA)?L|CWDR|CASH WDL|SELF\s*W\/?D)\b/i.test(t);
  // An ATM's ID: written after "ATM ID", or the code with letters and digits at the end of an ATM entry.
  const terminal = /\bATM\s*(?:ID|TID|TERMINAL)\s*[:/\-]?\s*([A-Z0-9]{6,12})\b/i.exec(t)?.[1] ?? (atm ? ([...t.toUpperCase().matchAll(/\b(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{6,12}\b/g)].map((m) => m[0]).filter((x) => !/^(IMPS|NEFT|RTGS|UPI)/.test(x)).at(-1) ?? null) : null);
  return { upis, digits, masked, phones, alnumRefs, atm, terminal: terminal && /\d/.test(terminal) && /[A-Z]/i.test(terminal) ? terminal.toUpperCase() : null, ifsc: IFSC_RE.exec(t.toUpperCase())?.[1] ?? null };
}

interface Row {
  row: number;
  excerpt: string;
  at: Date | null;
  amount: bigint | null;
  direction: "DEBIT" | "CREDIT" | "UNKNOWN";
  account: string | null;
  ifsc: string | null;
  bank: string | null;
  refs: string[];
  description: string;
  channel: string | null;
  balance: bigint | null;
  n: ReturnType<typeof readNarration>;
}

function statementRows(rows: string[][]): { rows: Row[]; skipped: number } {
  const head = statementHeader(rows)!;
  const balanceAt = head.header.findIndex((h) => /balance/i.test(h) && !/opening/i.test(h));
  const table = extractFromTable(rows);
  let skipped = 0;
  const out: Row[] = [];
  for (const c of table.candidates) {
    const s = c.structured ?? {};
    const description = String(s.description ?? "");
    const n = readNarration(`${description} ${s.reference ?? ""}`);
    const amount = s.amountMinor ? BigInt(String(s.amountMinor)) : null;
    const at = s.occurredAt ? new Date(String(s.occurredAt)) : null;
    if (!amount || !at) {
      skipped++;
      continue;
    }
    const balText = balanceAt >= 0 ? (rows[(c.row ?? 0) - 1]?.[balanceAt] ?? "") : "";
    const bal = balText ? parseRupeesToMinor(balText.replace(/\s*(cr|dr)\.?$/i, "")) : null;
    const refs = [s.reference ? String(s.reference) : null, ...n.alnumRefs, ...n.digits.filter((d) => d.length === 12)].filter((x): x is string => !!x);
    out.push({
      row: c.row ?? 0,
      excerpt: c.excerpt,
      at,
      amount,
      direction: (s.direction as Row["direction"]) ?? "UNKNOWN",
      account: s.counterpartyAccount ? String(s.counterpartyAccount) : null,
      ifsc: s.counterpartyIfsc ? String(s.counterpartyIfsc).toUpperCase() : n.ifsc,
      bank: s.counterpartyBank ? String(s.counterpartyBank) : null,
      refs: [...new Set(refs.map((r) => r.toUpperCase()))],
      description,
      channel: s.channel ? String(s.channel) : null,
      balance: bal && bal.ok ? bal.value : null,
      n,
    });
  }
  return { rows: out, skipped };
}

/** The other side of a row: the account column, else a UPI ID, an account or a phone number in the narration. */
function counterpartyOf(r: Row, subjectValue: string | null): { kind: IdentifierKind; value: string; from: "column" | "narration" } | null {
  if (r.account && !(subjectValue && compareAccounts(r.account, subjectValue) === "SAME")) return { kind: /@/.test(r.account) ? "UPI_ID" : "BANK_ACCOUNT", value: r.account, from: "column" };
  if (r.n.upis.length) return { kind: "UPI_ID", value: r.n.upis[0]!, from: "narration" };
  // In "IMPS/P2A/<12-digit ref>/<account>/…" the account is the long number that is not the reference.
  const accounts = [...r.n.digits, ...r.n.masked].filter((d) => !r.refs.includes(d.toUpperCase()) && !(subjectValue && compareAccounts(d, subjectValue) === "SAME") && !/^[6-9]\d{9}$/.test(d));
  if (accounts.length) return { kind: "BANK_ACCOUNT", value: accounts.at(-1)!, from: "narration" };
  return null;
}

export function readStatement(rows: string[][], fileName: string, know: CaseKnowledge): FileReadingResult | null {
  const head = statementHeader(rows);
  if (!head) return null;
  const table = extractFromTable(rows);
  if (!table.recognised || !table.candidates.length) return null;
  const subject = statementSubject(rows.slice(0, head.headerAt), fileName, know);
  const { rows: all, skipped } = statementRows(rows);
  const ordered = [...all].sort((a, b) => a.at!.getTime() - b.at!.getTime() || a.row - b.row);
  const proposals: Proposal[] = [];
  const insights: string[] = [];
  const notes: string[] = [];
  const relevantRows = new Set<number>();
  const src = (r: Row): Src => ({ locator: `${fileName}, row ${r.row}`, excerpt: r.excerpt.slice(0, 300), row: r.row, line: null, page: null });

  // The statement's own account: in the case already, or added when anything in it relates to the case.
  const subjectLabel = subject.known ? shortLabel(subject.known) : subject.value ? `account ${shownId(subject.value)}` : `the account in ${fileName}`;
  const subjectRef: Ref = subject.known ? { id: subject.known.id, label: subjectLabel } : { key: "S", label: subjectLabel };
  const subjectNeeds = subject.known ? [] : ["S"];
  const used = new Set<string>();
  const newIds = new Map<string, Proposal & { type: "IDENTIFIER" }>();
  const refFor = (kind: IdentifierKind, value: string, role: string, r: Row, attrs: Record<string, string | boolean> = {}): { ref: Ref; needs: string[] } => {
    const k = findKnown(know, kind, value);
    if (k) return { ref: { id: k.id.id, label: shortLabel(k.id) }, needs: [] };
    const norm = normalizeIdentifier(kind, value);
    const key = `C:${kind}:${norm}`;
    if (!newIds.has(key)) {
      const label = kind === "BANK_ACCOUNT" ? `account ${shownId(value)}` : kind === "UPI_ID" ? `UPI ID ${value}` : value;
      newIds.set(key, { key, type: "IDENTIFIER", kind, value, role, attrs, text: `Add ${label}${attrs.bank ? ` (${attrs.bank})` : ""}: ${role.charAt(0).toLowerCase()}${role.slice(1)}.`, src: src(r), needs: [] });
    }
    return { ref: { key, label: kind === "BANK_ACCOUNT" ? `account ${shownId(value)}` : value }, needs: [key] };
  };

  // 1. Rows the case already knows: a recorded reference, a recorded counterparty, a recorded payment's amount.
  const known: Map<number, { reason: string; txn?: KnownTxn; counter?: KnownId }> = new Map();
  for (const r of ordered) {
    const ref = r.refs.map((x) => knownRef(know, x)).find(Boolean);
    if (ref) {
      known.set(r.row, { reason: "ref", txn: ref });
      continue;
    }
    const cp = counterpartyOf(r, subject.value);
    const ids = [cp ? findKnown(know, cp.kind, cp.value) : null, ...r.n.upis.map((u) => findKnown(know, "UPI_ID", u)), ...r.n.phones.map((p) => findKnown(know, "PHONE", p)), ...r.n.digits.map((d) => findKnown(know, "BANK_ACCOUNT", d))].filter(Boolean);
    const hit = ids.find((x) => x && !(subject.known && x.id.id === subject.known.id));
    if (hit) {
      known.set(r.row, { reason: "counter", counter: hit.id });
      continue;
    }
    // A movement the case already records (money in, or out of this account, the same amount within days) is the
    // same movement: it is confirmed, never added twice.
    if (subject.known && r.direction !== "UNKNOWN") {
      const credit = r.direction === "CREDIT";
      const t = know.txns.find((x) => (credit ? x.toId : x.fromId) === subject.known!.id && x.amountMinor === r.amount && !used.has(x.id) && Math.abs(x.occurredAt.getTime() - r.at!.getTime()) <= (credit ? 3 : 1) * DAY);
      if (t) {
        used.add(t.id);
        known.set(r.row, { reason: "amount", txn: t });
      }
    }
  }

  // 2. The complainant's money followed out: debits after it arrived, until that amount had all left the account.
  let pool = 0n;
  let firstIn: Date | null = null;
  const trail: { r: Row; attributed: bigint }[] = [];
  for (const r of ordered) {
    const k = known.get(r.row);
    // Money in that is the complainant's: a recorded payment, or a credit from the complainant's own account or from
    // an account the case's money already passed through. A credit from any other known party is noted, not traced.
    const caseMoneyIn = r.direction === "CREDIT" && !!k && (!!k.txn || (!!k.counter && (k.counter.victim || know.txns.some((t) => t.toId === k.counter!.id))));
    if (caseMoneyIn) {
      pool += r.amount!;
      firstIn ??= r.at;
    } else if (r.direction === "DEBIT" && pool > 0n) {
      const attributed = r.amount! < pool ? r.amount! : pool;
      pool -= attributed;
      trail.push({ r, attributed });
    }
  }
  const inTrail = new Map(trail.map((t) => [t.r.row, t.attributed]));

  for (const r of ordered) {
    const k = known.get(r.row);
    const attributed = inTrail.get(r.row);
    if (!k && attributed === undefined) continue;
    relevantRows.add(r.row);
    const when = `${formatDayMonthIST(r.at!)} ${formatTimeIST(r.at!).replace(" IST", "")}`;
    if (k?.txn) {
      const t = k.txn;
      const what = t.toId === subject.known?.id ? `money into ${subjectLabel}` : t.fromId === subject.known?.id ? (t.kind === "CASH_WITHDRAWAL" ? `cash withdrawal from ${subjectLabel}` : `transfer out of ${subjectLabel}`) : "payment";
      proposals.push({ key: `R${r.row}:confirms`, type: "CONFIRMS", transactionId: t.id, text: `Row ${r.row} shows the recorded ${inr(t.amountMinor)} ${what} on ${formatDayMonthIST(r.at!)}${k.reason === "ref" ? ` (same reference ${t.reference})` : " (same amount and day)"}: it is added as the bank's confirmation, not as a new record.`, src: src(r), needs: [] });
      continue;
    }
    const cp = counterpartyOf(r, subject.value);
    const isCash = r.direction === "DEBIT" && (r.channel === "CASH_WITHDRAWAL" || r.n.atm);
    if (isCash) {
      const place = /\bATM\b[^A-Za-z0-9]*(?:WDL|W\/D|CASH)?[^A-Za-z0-9]*([A-Za-z][A-Za-z .]{2,40}?)(?:[\/,|]|$)/i.exec(r.description)?.[1]?.trim() ?? null;
      proposals.push({ key: `R${r.row}:cash`, type: "CASH", from: subjectRef, amountMinor: r.amount!.toString(), occurredAt: r.at!.toISOString(), place: place && !/^(wdl|cash|withdrawal)$/i.test(place) ? place : null, terminal: r.n.terminal, text: `${inr(r.amount!)} taken out in cash${r.n.atm ? " at an ATM" : ""} on ${when}${r.n.terminal ? ` (ATM ${r.n.terminal})` : ""}${attributed !== undefined && attributed < r.amount! ? `; ${inr(attributed)} of it is the complainant's money` : ""}.`, src: src(r), needs: subjectNeeds });
      continue;
    }
    if (!cp) {
      const card = r.direction === "DEBIT" && /\b(POS|ECOM|E-COM|CARD|VISA|RUPAY|MASTERCARD|PURCHASE)\b/i.test(r.description);
      insights.push(
        card
          ? `Row ${r.row}: ${inr(r.amount!)} spent by card on ${when} (“${r.description.slice(0, 60)}”). The merchant's record of this purchase may show who used the account.`
          : `Row ${r.row}: ${inr(r.amount!)} ${r.direction === "DEBIT" ? "left" : "came in"} on ${when}${r.channel ? ` by ${r.channel}` : ""}, but the statement does not show the other account. Ask the bank for the ${r.direction === "DEBIT" ? "beneficiary" : "remitter"} of this entry.`,
      );
      continue;
    }
    const counterRole = r.direction === "DEBIT" ? `Received money from ${subjectLabel} (bank statement ${fileName}, row ${r.row})` : `Sent money to ${subjectLabel} (bank statement ${fileName}, row ${r.row})`;
    const bank = r.bank ?? null;
    const c = refFor(cp.kind, cp.value, counterRole, r, { ...(bank ? { bank } : {}), ...(r.ifsc && cp.kind === "BANK_ACCOUNT" ? { ifsc: r.ifsc } : {}), ...(cp.from === "narration" ? { readFrom: "the statement's narration" } : {}) });
    const ref = r.refs[0] ?? null;
    const channel = r.channel && !["CASH_WITHDRAWAL"].includes(r.channel) ? r.channel.toUpperCase() : /\bUPI\b/i.test(r.description) ? "UPI" : /\bIMPS\b/i.test(r.description) ? "IMPS" : /\bNEFT\b/i.test(r.description) ? "NEFT" : /\bRTGS\b/i.test(r.description) ? "RTGS" : "OTHER";
    const why = k?.counter ? `${shortLabel(k.counter)} is already in this case` : attributed !== undefined ? `it left after the complainant's money arrived${attributed < r.amount! ? `; ${inr(attributed)} of it is the complainant's money` : ""}` : "";
    proposals.push(
      r.direction === "DEBIT"
        ? { key: `R${r.row}:out`, type: "TRANSFER", from: subjectRef, to: c.ref, amountMinor: r.amount!.toString(), occurredAt: r.at!.toISOString(), reference: ref, channel, text: `${inr(r.amount!)} sent from ${subjectLabel} to ${c.ref.label} on ${when}${ref ? ` (ref ${ref})` : ""}: ${why}.`, src: src(r), needs: [...subjectNeeds, ...c.needs] }
        : { key: `R${r.row}:in`, type: "TRANSFER", from: c.ref, to: subjectRef, amountMinor: r.amount!.toString(), occurredAt: r.at!.toISOString(), reference: ref, channel, text: `${inr(r.amount!)} received into ${subjectLabel} from ${c.ref.label} on ${when}${ref ? ` (ref ${ref})` : ""}: ${why}.`, src: src(r), needs: [...subjectNeeds, ...c.needs] },
    );
  }

  // The statement's own account, when it is new and something in it relates to the case.
  if (!subject.known && relevantRows.size) {
    const value = subject.value ?? `Account in ${fileName} (number not shown)`;
    proposals.unshift({
      key: "S",
      type: "IDENTIFIER",
      kind: "BANK_ACCOUNT",
      value,
      role: `Account whose bank statement was added (${fileName})`,
      attrs: { ...(subject.ifsc ? { ifsc: subject.ifsc } : {}), ...(subject.bank ? { bank: subject.bank } : {}), ...(subject.holder ? { statedName: subject.holder, statedNameBasis: `Holder named in the statement ${fileName}` } : {}), ...(subject.value ? {} : { numberNotStated: true }) },
      text: `Add ${subjectLabel}${subject.holder ? ` (holder: ${subject.holder})` : ""}, the account this statement is for.`,
      src: { locator: `${fileName}, title rows`, excerpt: rows.slice(0, head.headerAt).map((r) => r.filter(Boolean).join(" ")).filter(Boolean).join(" · ").slice(0, 300) || fileName, row: null, line: null, page: null },
      needs: [],
    });
  }
  proposals.splice(subject.known ? 0 : 1, 0, ...newIds.values());
  if (subject.known && subject.holder) proposals.push({ key: "S:name", type: "NAME", of: subjectRef, name: subject.holder, text: `The statement names the holder of ${subjectLabel} as ${subject.holder}.`, src: { locator: `${fileName}, title rows`, excerpt: subject.holder, row: null, line: null, page: null }, needs: [] });

  // What is worth knowing beyond the records.
  const credits = all.filter((r) => r.direction === "CREDIT");
  const senders = new Set(credits.map((r) => counterpartyOf(r, subject.value)?.value ?? r.description.slice(0, 40)).filter(Boolean));
  if (credits.length >= 10 && senders.size >= 5) {
    const total = credits.reduce((s, r) => s + r.amount!, 0n);
    insights.unshift(`${plural(credits.length, "credit")} from ${senders.size} different senders (${inr(total)} in all) between ${formatDayMonthIST(ordered[0]!.at!)} and ${formatDayMonthIST(ordered.at(-1)!.at!)}: many small payments in from strangers is often how a mule account looks. Other victims may be among the senders.`);
  }
  const lastBal = [...ordered].reverse().find((r) => r.balance !== null);
  if (lastBal && subject.known) insights.push(`Balance after the last entry (${formatDateIST(lastBal.at!)}): ${inr(lastBal.balance!)}.${lastBal.balance! > 0n ? " If no hold is in place, this is money that can still be frozen." : ""}`);
  if (pool > 0n) insights.push(`${inr(pool)} of the complainant's money had not left the account by the last entry of the statement.`);
  if (subject.how === "POSSIBLE" && subject.known) {
    const caseHidden = isMaskedValue(subject.known.value);
    notes.push(
      caseHidden && subject.value && !isMaskedValue(subject.value)
        ? `The case has ${subjectLabel} only with its last digits (${shownId(subject.known.value)}); this statement gives the full number, ${subject.value}, and was matched to it by those digits. Check with the bank that it is the same account before relying on it.`
        : `The statement shows the account number only partly; it was matched to ${subjectLabel} by its last digits. Check the full number with the bank.`,
    );
  }
  if (skipped) notes.push(`${plural(skipped, "row")} without a readable date or amount ${skipped === 1 ? "was" : "were"} not read.`);

  const about = [subject.value ? `Account ${shownId(subject.value)}${subject.known ? " (in this case)" : ""}` : "Account number not shown", subject.holder ? `Holder: ${subject.holder}` : null, subject.period ? `Period ${subject.period}` : all.length ? `${formatDateIST(ordered[0]!.at!)} to ${formatDateIST(ordered.at(-1)!.at!)}` : null, plural(all.length, "entry", "entries")].filter((x): x is string => !!x);
  const relevant = relevantRows.size;
  const outs = trail.length;
  const summary = !relevant
    ? `Nothing in this statement links to the FIR: none of its ${plural(all.length, "entry", "entries")} has an account, UPI ID, number or reference recorded in this case${subject.known ? ", and no payment the case records reached this account in this period" : `, and its own account${subject.value ? ` (${shownId(subject.value)})` : ""} is not in the case`}. The file is kept with the case's evidence; nothing else is added.`
    : `${plural(relevant, "entry", "entries")} of ${all.length} relate to this FIR${firstIn ? `: the complainant's money reached ${subjectLabel} on ${formatDayMonthIST(firstIn)}${outs ? `, and ${plural(outs, "debit")} after it carried it on` : ""}` : ""}.`;
  return {
    kind: "BANK_STATEMENT",
    title: `Bank statement of ${subjectLabel}`,
    about,
    summary,
    insights,
    proposals,
    leftOut: all.length - relevant > 0 ? `${plural(all.length - relevant, "entry", "entries")} ${all.length - relevant === 1 ? "has" : "have"} no link to this FIR (no case account, number or reference, and not the complainant's money) and ${all.length - relevant === 1 ? "was" : "were"} left out.` : null,
    notes,
    total: all.length,
    relevant,
  };
}

// ───────────────────────── Call records ─────────────────────────

const CDR_COLS: Record<string, string[]> = {
  a: ["a party", "a party number", "calling number", "calling no", "calling party", "msisdn", "target no", "target number", "a number", "source number", "caller", "a no", "aparty"],
  b: ["b party", "b party number", "called number", "called no", "called party", "other party", "b number", "destination number", "callee", "other number", "b no", "bparty", "other party number"],
  date: ["date", "call date", "start date", "date time", "datetime", "call start time", "start time", "call date time", "date and time", "call start date time"],
  time: ["time", "call time", "start time hh mm ss"],
  duration: ["duration", "call duration", "dur", "duration sec", "duration seconds", "duration in sec", "call duration sec"],
  type: ["call type", "type", "in out", "direction", "service type", "call direction", "type of call", "usage type"],
  imei: ["imei", "imei a", "a imei", "imei number", "a party imei"],
  imsi: ["imsi", "imsi a", "a party imsi"],
  cell: ["first cell id", "cell id", "first cgi", "cgi", "cell global id", "first cell global id", "lac cell id", "a party first cell id", "first cell id a", "cellid"],
  site: ["first cell site address", "cell site address", "tower address", "site address", "location", "address", "first bts location", "bts address", "first cell address", "first cell id address", "cell address", "site name", "first cell site name", "bts location"],
};
const key = (h: string) => h.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
function cdrColumns(header: string[]) {
  const n = header.map(key);
  const out: Record<string, number> = {};
  for (const [k, syn] of Object.entries(CDR_COLS)) {
    const i = n.findIndex((h, idx) => syn.includes(h) && !Object.values(out).includes(idx));
    if (i >= 0) out[k] = i;
  }
  return out;
}
const phoneOf = (v: string) => {
  const d = (v ?? "").replace(/\D/g, "");
  const ten = d.length > 10 ? d.slice(-10) : d;
  return /^[6-9]\d{9}$/.test(ten) ? ten : null;
};

export function readCallRecords(rows: string[][], fileName: string, know: CaseKnowledge): FileReadingResult | null {
  const at = rows.slice(0, 25).findIndex((h) => {
    const c = cdrColumns(h);
    return (c.a !== undefined || c.b !== undefined) && c.date !== undefined && (c.duration !== undefined || c.type !== undefined || c.imei !== undefined || c.cell !== undefined);
  });
  if (at < 0) return null;
  const cols = cdrColumns(rows[at]!);
  const cell = (r: string[], k: string) => (cols[k] === undefined ? "" : (r[cols[k]!] ?? "").trim());
  // The number the records are for: named above the table, else the A party that appears most.
  const title = rows.slice(0, at).flat().join(" ");
  const titled = /(?:target|msisdn|mobile|subscriber|number)\s*(?:no\.?|number)?\s*[:\-]?\s*(?:\+?91)?\s*([6-9]\d{9})/i.exec(title)?.[1] ?? null;
  const counts = new Map<string, number>();
  for (const r of rows.slice(at + 1)) {
    const a = phoneOf(cell(r, "a"));
    if (a) counts.set(a, (counts.get(a) ?? 0) + 1);
  }
  const subjectNo = titled ?? [...counts.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? null;
  if (!subjectNo) return null;
  const subjectKnown = findKnown(know, "PHONE", subjectNo)?.id ?? null;
  const subjectLabel = subjectKnown ? shortLabel(subjectKnown) : `mobile ${shownId(subjectNo)}`;
  const subjectRef: Ref = subjectKnown ? { id: subjectKnown.id, label: subjectLabel } : { key: "S", label: subjectLabel };
  const subjectNeeds = subjectKnown ? [] : ["S"];
  type Call = { row: number; other: string | null; at: Date | null; type: string; imei: string | null; site: string; excerpt: string };
  const calls: Call[] = [];
  rows.slice(at + 1).forEach((r, i) => {
    if (!r.some((c) => c && c.trim())) return;
    const a = phoneOf(cell(r, "a"));
    const b = phoneOf(cell(r, "b"));
    const other = a === subjectNo ? b : b === subjectNo ? a : (b ?? a);
    const when = parseTableDate([cell(r, "date"), cols.time !== undefined && cols.time !== cols.date ? cell(r, "time") : ""].filter(Boolean).join(" "));
    const imei = (cell(r, "imei").replace(/\D/g, "") || null);
    calls.push({ row: at + i + 2, other, at: when, type: cell(r, "type"), imei: imei && imei.length >= 14 && imei.length <= 16 ? imei : null, site: [cell(r, "site"), cell(r, "cell") ? `cell ${cell(r, "cell")}` : ""].filter(Boolean).join(", "), excerpt: r.filter(Boolean).join(", ").slice(0, 300) });
  });
  const src = (c: Call): Src => ({ locator: `${fileName}, row ${c.row}`, excerpt: c.excerpt, row: c.row, line: null, page: null });
  const proposals: Proposal[] = [];
  const insights: string[] = [];
  const relevantRows = new Set<number>();

  // Calls with numbers the case already has.
  const byKnown = new Map<string, { k: KnownId; calls: Call[] }>();
  for (const c of calls) {
    if (!c.other || c.other === subjectNo) continue;
    const k = findKnown(know, "PHONE", c.other)?.id;
    if (!k || k.id === subjectKnown?.id) continue;
    const g = byKnown.get(k.id) ?? { k, calls: [] };
    g.calls.push(c);
    byKnown.set(k.id, g);
  }
  const relevantSubject = !!subjectKnown || byKnown.size > 0;
  if (!subjectKnown && byKnown.size) {
    proposals.push({ key: "S", type: "IDENTIFIER", kind: "PHONE", value: subjectNo, role: `Mobile whose call records were added (${fileName}); in contact with ${[...byKnown.values()].map((g) => shortLabel(g.k)).join(", ")}`, attrs: {}, text: `Add mobile ${shownId(subjectNo)}, the number these call records are for: it was in contact with ${[...byKnown.values()].map((g) => shortLabel(g.k)).join(", ")}.`, src: { locator: `${fileName}, all rows`, excerpt: `${calls.length} call records of ${subjectNo}`, row: null, line: null, page: null }, needs: [] });
  }
  for (const g of byKnown.values()) {
    g.calls.forEach((c) => relevantRows.add(c.row));
    const dated = g.calls.filter((c) => c.at).sort((x, y) => x.at!.getTime() - y.at!.getTime());
    const span = dated.length ? `${formatDayMonthIST(dated[0]!.at!)}${dated.length > 1 && formatDayMonthIST(dated.at(-1)!.at!) !== formatDayMonthIST(dated[0]!.at!) ? ` to ${formatDayMonthIST(dated.at(-1)!.at!)}` : ""}` : "dates not given";
    proposals.push({ key: `K:${g.k.id}`, type: "LINK", a: subjectRef, b: { id: g.k.id, label: shortLabel(g.k) }, rel: "CONTACTED", statement: `${plural(g.calls.length, "call or SMS", "calls or SMS")} between ${subjectLabel} and ${shortLabel(g.k)} (${span}), per the call records ${fileName}`, text: `${subjectLabel} and ${shortLabel(g.k)} were in contact ${plural(g.calls.length, "time")} (${span}).`, src: src(g.calls[0]!), needs: subjectNeeds });
  }
  if (relevantSubject) {
    // The handsets the number was used in.
    const imeis = new Map<string, Call[]>();
    for (const c of calls) if (c.imei) imeis.set(c.imei, [...(imeis.get(c.imei) ?? []), c]);
    for (const [imei, cs] of imeis) {
      const known = findKnown(know, "DEVICE", imei);
      const ref: Ref = known ? { id: known.id.id, label: `handset IMEI ${imei}` } : { key: `D:${imei}`, label: `handset IMEI ${imei}` };
      if (!known) proposals.push({ key: `D:${imei}`, type: "IDENTIFIER", kind: "DEVICE", value: imei, role: `Handset used with ${subjectLabel} (call records ${fileName})`, attrs: { imei }, text: `Add the handset IMEI ${imei}, used with ${subjectLabel} in ${plural(cs.length, "call")}.`, src: src(cs[0]!), needs: [] });
      proposals.push({ key: `DL:${imei}`, type: "LINK", a: ref, b: subjectRef, rel: "LINKED_IDENTIFIER", statement: `Handset IMEI ${imei} was used with ${subjectLabel} in ${plural(cs.length, "call")} (call records ${fileName})`, text: `IMEI ${imei} was the handset for ${subjectLabel} in ${plural(cs.length, "call")}.`, src: src(cs[0]!), needs: [...subjectNeeds, ...(known ? [] : [`D:${imei}`])] });
      cs.forEach((c) => relevantRows.add(c.row));
    }
    if (imeis.size > 1) insights.push(`${subjectLabel} was used in ${imeis.size} different handsets in this period.`);
    // Where the number was around the time of the offence.
    if (know.windowFrom) {
      const from = know.windowFrom.getTime() - DAY;
      const to = (know.windowTo ?? know.windowFrom).getTime() + DAY;
      const near = calls.filter((c) => c.at && c.site && c.at.getTime() >= from && c.at.getTime() <= to);
      const sites = new Map<string, Call[]>();
      for (const c of near) sites.set(c.site, [...(sites.get(c.site) ?? []), c]);
      [...sites.entries()]
        .sort((x, y) => y[1].length - x[1].length)
        .slice(0, 8)
        .forEach(([site, cs]) => {
          const ts = cs.map((c) => c.at!).sort((x, y) => x.getTime() - y.getTime());
          proposals.push({ key: `L:${site}`, type: "LOCATION", of: subjectRef, place: site, at: ts[0]!.toISOString(), until: ts.at(-1)!.toISOString(), text: `${subjectLabel} was on the tower at ${site} ${plural(cs.length, "time")} between ${formatDayMonthIST(ts[0]!)} ${formatTimeIST(ts[0]!).replace(" IST", "")} and ${formatDayMonthIST(ts.at(-1)!)} ${formatTimeIST(ts.at(-1)!).replace(" IST", "")}, around the time of the offence.`, src: src(cs[0]!), needs: subjectNeeds });
          cs.forEach((c) => relevantRows.add(c.row));
        });
      if (!near.length) insights.push("None of the calls with a tower location falls within a day of the offence.");
    } else insights.push("The case has no offence date yet, so tower locations were not picked out.");
  }
  // The most frequent other numbers: worth a look, not added.
  const others = new Map<string, number>();
  for (const c of calls) if (c.other && c.other !== subjectNo && !findKnown(know, "PHONE", c.other)) others.set(c.other, (others.get(c.other) ?? 0) + 1);
  const top = [...others.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (top.length && relevantSubject) insights.push(`Most frequent other numbers (not in the case, not added): ${top.map(([n, k]) => `${shownId(n)} (${k})`).join(", ")}.`);
  const dated = calls.filter((c) => c.at).sort((x, y) => x.at!.getTime() - y.at!.getTime());
  const relevant = relevantRows.size;
  return {
    kind: "CALL_RECORDS",
    title: `Call records of ${subjectLabel}`,
    about: [`Mobile ${shownId(subjectNo)}${subjectKnown ? " (in this case)" : ""}`, dated.length ? `${formatDateIST(dated[0]!.at!)} to ${formatDateIST(dated.at(-1)!.at!)}` : null, plural(calls.length, "record")].filter((x): x is string => !!x),
    summary: !relevantSubject
      ? `Nothing in these call records links to the FIR: the number ${shownId(subjectNo)} is not in the case and none of its ${plural(calls.length, "call")} is with a number the case has. The file is kept with the case's evidence; nothing else is added.`
      : `${plural(relevant, "record")} of ${calls.length} relate to this FIR${byKnown.size ? `: contact with ${[...byKnown.values()].map((g) => shortLabel(g.k)).join(", ")}` : ""}.`,
    insights,
    proposals,
    leftOut: calls.length - relevant > 0 ? `${plural(calls.length - relevant, "record")} with numbers and places that have no link to this FIR ${calls.length - relevant === 1 ? "was" : "were"} left out.` : null,
    notes: [],
    total: calls.length,
    relevant,
  };
}

// ───────────────────────── Other documents ─────────────────────────

const FIELD_KIND: Record<string, IdentifierKind | undefined> = { PHONE: "PHONE", EMAIL: "EMAIL", UPI_ID: "UPI_ID", WEBSITE: "WEBSITE", IP_ADDRESS: "IP_ADDRESS", BANK_ACCOUNT: "BANK_ACCOUNT" };
const NAME_LINE = /\b(account holder(?:'s)? name|name of (?:the )?(?:account )?holder|holder name|customer name|subscriber name|registered (?:to|in the name of)|in the name of)\b\s*[:\-]?\s*(?:mr\.?|mrs\.?|ms\.?|shri|smt\.?)?\s*([A-Z][A-Za-z.' ]{2,60}?)(?=\s*(?:[,;|(]|$|\bs\/o\b|\bd\/o\b|\bw\/o\b|\bage\b))/i;

export function readDocumentLines(lines: SourceLine[], fileName: string, know: CaseKnowledge): FileReadingResult {
  const cands = extractFromLines(lines, { source: "RECORD" });
  const proposals: Proposal[] = [];
  const insights: string[] = [];
  const relevantLines = new Set<string>();
  const where = (c: { page: number | null; line: number | null; row: number | null }) => `${fileName}, ${c.page ? `page ${c.page}, ` : ""}${c.row ? `row ${c.row}` : `line ${c.line ?? "?"}`}`;
  const lineKey = (c: { page: number | null; line: number | null; row: number | null }) => `${c.page ?? 0}:${c.line ?? c.row ?? 0}`;
  const srcOf = (c: { page: number | null; line: number | null; row: number | null; excerpt: string }): Src => ({ locator: where(c), excerpt: c.excerpt.slice(0, 300), row: c.row, line: c.line, page: c.page });
  const hits: { kind: IdentifierKind; k: KnownId; c: (typeof cands)[number] }[] = [];
  const mentioned = new Set<string>();
  for (const c of cands) {
    if (c.field === "TXN_REFERENCE") {
      const t = knownRef(know, c.originalValue);
      if (t && !mentioned.has(t.id)) {
        mentioned.add(t.id);
        relevantLines.add(lineKey(c));
        proposals.push({ key: `T:${t.id}`, type: "CONFIRMS", transactionId: t.id, text: `It quotes the reference ${t.reference} of the recorded ${inr(t.amountMinor)} payment (${where(c).replace(`${fileName}, `, "")}).`, src: srcOf(c), needs: [] });
      }
      continue;
    }
    const kind = FIELD_KIND[c.field];
    if (!kind) continue;
    const k = findKnown(know, kind, c.originalValue);
    if (!k) continue;
    hits.push({ kind, k: k.id, c });
    relevantLines.add(lineKey(c));
    if (!mentioned.has(k.id.id)) {
      mentioned.add(k.id.id);
      proposals.push({ key: `M:${k.id.id}`, type: "MENTION", entityId: k.id.id, text: `It mentions ${shortLabel(k.id)} (${where(c).replace(`${fileName}, `, "")}).`, src: srcOf(c), needs: [] });
    }
  }
  // New identifiers written next to one the case has (the same line or the two lines around it).
  const near = (a: { page: number | null; line: number | null; row: number | null }, b: { page: number | null; line: number | null; row: number | null }) => (a.page ?? 0) === (b.page ?? 0) && Math.abs((a.line ?? a.row ?? 0) - (b.line ?? b.row ?? 0)) <= 2;
  const added = new Set<string>();
  for (const c of cands) {
    const kind = FIELD_KIND[c.field];
    if (!kind || findKnown(know, kind, c.originalValue)) continue;
    const anchor = hits.find((h) => near(h.c, c) && !(h.kind === kind && normalizeIdentifier(kind, h.c.originalValue) === normalizeIdentifier(kind, c.originalValue)));
    if (!anchor) continue;
    const norm = normalizeIdentifier(kind, c.originalValue);
    const key = `N:${kind}:${norm}`;
    if (added.has(key)) continue;
    added.add(key);
    relevantLines.add(lineKey(c));
    const label = kind === "BANK_ACCOUNT" ? `account ${shownId(c.originalValue)}` : kind === "PHONE" ? `mobile ${shownId(c.originalValue)}` : c.originalValue;
    proposals.push({ key, type: "IDENTIFIER", kind, value: c.originalValue, role: `Written next to ${shortLabel(anchor.k)} in ${fileName}`, attrs: isMaskedValue(c.originalValue) ? { masked: true } : {}, text: `Add ${label}: it is written next to ${shortLabel(anchor.k)} (${where(c).replace(`${fileName}, `, "")}).`, src: srcOf(c), needs: [] });
    proposals.push({ key: `NL:${kind}:${norm}`, type: "LINK", a: { key, label }, b: { id: anchor.k.id, label: shortLabel(anchor.k) }, rel: "LINKED_IDENTIFIER", statement: `Written next to each other in ${fileName}: “${c.excerpt.slice(0, 160)}”`, text: `Link ${label} with ${shortLabel(anchor.k)}, as the document puts them together.`, src: srcOf(c), needs: [key] });
  }
  // A holder's name the document gives beside an account or number the case has.
  const named = new Set<string>();
  for (const h of hits) {
    if (named.has(h.k.id)) continue;
    const around = lines.filter((l) => (l.page ?? 0) === (h.c.page ?? 0) && Math.abs((l.line ?? l.row ?? 0) - (h.c.line ?? h.c.row ?? 0)) <= 2);
    for (const l of around) {
      const m = NAME_LINE.exec(l.text);
      if (!m) continue;
      const name = m[2]!.trim().replace(/\s+/g, " ");
      if (name.split(" ").length > 6 || /\b(bank|branch|account|limited|ltd)\b/i.test(name)) continue;
      named.add(h.k.id);
      relevantLines.add(`${l.page ?? 0}:${l.line ?? l.row ?? 0}`);
      proposals.push({ key: `NM:${h.k.id}`, type: "NAME", of: { id: h.k.id, label: shortLabel(h.k) }, name, text: `It names ${name} as the holder of ${shortLabel(h.k)} (${l.page ? `page ${l.page}, ` : ""}line ${l.line ?? l.row}). Kept as stated, not verified.`, src: { locator: where({ page: l.page, line: l.line, row: l.row }), excerpt: l.text.slice(0, 300), row: l.row, line: l.line, page: l.page }, needs: [] });
      break;
    }
  }
  const ids = cands.filter((c) => FIELD_KIND[c.field]);
  const unlinked = new Set(ids.filter((c) => !findKnown(know, FIELD_KIND[c.field]!, c.originalValue) && !added.has(`N:${FIELD_KIND[c.field]}:${normalizeIdentifier(FIELD_KIND[c.field]!, c.originalValue)}`)).map((c) => `${c.field}:${c.normalizedValue}`));
  if (unlinked.size && hits.length) insights.push(`${plural(unlinked.size, "other identifier")} in the document ${unlinked.size === 1 ? "is" : "are"} not next to anything in the case and ${unlinked.size === 1 ? "was" : "were"} not added. Add ${unlinked.size === 1 ? "it" : "them"} by hand if ${unlinked.size === 1 ? "it matters" : "they matter"}.`);
  const total = lines.filter((l) => l.text.trim()).length;
  const relevant = relevantLines.size;
  return {
    kind: "DOCUMENT",
    title: fileName,
    about: [plural(total, "line"), ids.length ? plural(new Set(ids.map((c) => `${c.field}:${c.normalizedValue}`)).size, "identifier") : "no identifiers"],
    summary: !proposals.length
      ? `This document does not mention any account, number, UPI ID, email, website or reference recorded in this FIR${unlinked.size ? ` (it has ${plural(unlinked.size, "identifier")} the case does not)` : ""}, so nothing is added from it. It is kept with the case's evidence.`
      : `It mentions ${plural(mentioned.size, "record")} the case already has${added.size ? ` and ${plural(added.size, "new identifier")} written next to them` : ""}.`,
    insights,
    proposals,
    leftOut: total - relevant > 0 && proposals.length ? `${plural(total - relevant, "line")} with nothing tied to this FIR ${total - relevant === 1 ? "was" : "were"} not used.` : null,
    notes: [],
    total,
    relevant,
  };
}

/** Joins a reading's proposals that need ones the officer left out: they cannot be added without them. */
export function selectable(proposals: Proposal[], chosen: Set<string>): { keep: Proposal[]; dropped: Proposal[] } {
  const keep: Proposal[] = [];
  const dropped: Proposal[] = [];
  const ok = new Set<string>();
  // Identifiers first, then what depends on them.
  for (const p of [...proposals].sort((a, b) => Number(a.type !== "IDENTIFIER") - Number(b.type !== "IDENTIFIER"))) {
    if (!chosen.has(p.key)) continue;
    if (p.needs.every((n) => ok.has(n))) {
      ok.add(p.key);
      keep.push(p);
    } else dropped.push(p);
  }
  return { keep, dropped };
}
