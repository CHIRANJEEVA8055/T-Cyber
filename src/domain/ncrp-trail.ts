/**
 * Reads the NCRP money-trail export (the "action taken by banks" sheet downloaded from the National Cyber Crime
 * Reporting Portal): which account received the money at which layer, and what the bank did with it, such as moving
 * it on to another account, putting it on hold, or paying it out at an ATM. The columns are found by their
 * headings, whatever their order, and every row keeps its sheet line so each record can be traced back. A row that
 * cannot be used is listed with the reason; nothing is guessed. Pure: no I/O.
 */

export type TrailAction = "TRANSFER" | "HOLD" | "ATM" | "CASH" | "OTHER";

export interface TrailAccount {
  account: string;
  bank: string | null;
  ifsc: string | null;
}

export interface TrailRow {
  /** The row's line in the sheet (1-based), for tracing it back. */
  line: number;
  layer: number | null;
  /** The account the bank acted on (the account the money reached at this layer). */
  from: TrailAccount;
  action: TrailAction;
  actionText: string;
  /** Where it moved to, for a transfer. */
  to: TrailAccount | null;
  utr: string | null;
  occurredAt: string | null;
  amountMinor: bigint | null;
  holdMinor: bigint | null;
  /** The complainant's own payment that reached this layer-1 account, when the sheet gives it. */
  victimUtr: string | null;
  disputedMinor: bigint | null;
  terminal: string | null;
  place: string | null;
  ack: string | null;
  remarks: string | null;
}

export type Role =
  | "ack"
  | "victimUtr"
  | "layer"
  | "fromAccount"
  | "fromBank"
  | "action"
  | "toAccount"
  | "toIfsc"
  | "toBank"
  | "occurredAt"
  | "utr"
  | "amount"
  | "holdAmount"
  | "disputed"
  | "terminal"
  | "place"
  | "remarks"
  | "actionDate";

export interface TrailReading {
  /** The heading row's line in the sheet (1-based). */
  headerRow: number;
  columns: { role: Role; header: string; index: number }[];
  rows: TrailRow[];
  skipped: { line: number; reason: string }[];
  acks: string[];
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Heading patterns per role, most specific first. Matched against the normalised heading. */
const PATTERNS: [Role, RegExp][] = [
  ["ack", /^(acknowledg(e)?ment|ack)( no| number)?$/],
  ["layer", /^layer( no)?$/],
  ["fromAccount", /^account no wallet pg pa id$|^(beneficiary|suspect|credited|layer) account( no| number)?$|^account no wallet id$/],
  ["fromBank", /^bank wallet pg pa merchant insurance$|^bank wallet merchant$|^(beneficiary )?bank( name)?$/],
  ["action", /^action taken by bank$|^action( taken)?$|^status$/],
  ["toAccount", /^account no$|^account number$|^(to|transferred to|destination|receiver) account( no| number)?$/],
  ["toIfsc", /^ifsc( code)?$|^(to|destination) ifsc( code)?$/],
  ["toBank", /^(to|destination|receiver) bank( name)?$/],
  ["occurredAt", /^transaction date( time)?$|^txn date$|^date of transaction$/],
  ["utr", /^transaction id utr number$|^utr( no| number)?$|^transaction (id|ref(erence)?)( no)?$|^rrn$/],
  ["amount", /^transaction amount$|^amount( rs| inr)?$|^txn amount$|^transferred amount$/],
  ["holdAmount", /^put on hold amount$|^(hold|lien|frozen|freeze)( marked)? amount$|^amount (put )?on hold$/],
  ["disputed", /^disputed amount$|^fraud amount$/],
  ["terminal", /^tid$|^atm id$|^terminal id$/],
  ["place", /^branch location$|^(atm )?location$|^place$/],
  ["remarks", /^remarks?$/],
  ["actionDate", /^date of action$|^put on hold date$|^action date$/],
];

function roleOf(header: string): Role | null {
  const h = norm(header);
  if (!h) return null;
  for (const [role, re] of PATTERNS) if (re.test(h)) return role;
  return null;
}

/** "1,00,000.00", "₹ 5000", "Rs.5,000/-" → paise; null when empty or not a number. */
export function amountMinor(v: string): bigint | null {
  const t = v.replace(/₹|rs\.?|inr|\/-|,|\s/gi, "");
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const [r, p = ""] = t.split(".");
  return BigInt(r!) * 100n + BigInt((p + "00").slice(0, 2));
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** A sheet date-time in IST ("05-11-2026 10:32:00", "06/11/2026 21:14", "2026-11-05", "05-Nov-2026") → UTC ISO. */
export function istDate(v: string): string | null {
  const t = v.trim();
  let m = /^(\d{1,2})[-/.](\d{1,2}|[A-Za-z]{3})[-/.](\d{2,4})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?$/i.exec(t);
  let y: number, mo: number, d: number, h = 0, mi = 0, s = 0, ampm: string | undefined;
  if (m) {
    d = Number(m[1]);
    mo = /^\d+$/.test(m[2]!) ? Number(m[2]) : MONTHS.indexOf(m[2]!.toLowerCase()) + 1;
    y = Number(m[3]!.length === 2 ? `20${m[3]}` : m[3]);
    [h, mi, s] = [Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0)];
    ampm = m[7];
  } else if ((m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(t))) {
    [y, mo, d, h, mi, s] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0)];
  } else return null;
  if (ampm) h = (h % 12) + (/pm/i.test(ampm) ? 12 : 0);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const ms = Date.UTC(y, mo - 1, d, h, mi, s) - 330 * 60 * 1000;
  const back = new Date(ms + 330 * 60 * 1000);
  if (back.getUTCDate() !== d) return null;
  return new Date(ms).toISOString();
}

export function actionOf(text: string, hasTo: boolean, hold: bigint | null): TrailAction {
  const t = text.toLowerCase();
  if (/hold|lien|freez|frozen|debit restrict/.test(t)) return "HOLD";
  if (/atm/.test(t)) return "ATM";
  if (/cheque|cash|withdraw|pos|aeps/.test(t)) return "CASH";
  if (/transfer|transferred|moved|imps|neft|rtgs|upi/.test(t)) return "TRANSFER";
  if (!t && hasTo) return "TRANSFER";
  if (!t && hold && hold > 0n) return "HOLD";
  return "OTHER";
}

const clean = (v: string | undefined) => {
  const t = (v ?? "").replace(/\s+/g, " ").trim();
  return t && !/^(na|n\/a|nil|null|-+|0)$/i.test(t) ? t : null;
};
/** Account numbers keep their leading zeros and masking; Excel's "1.23E+13" cannot be trusted and is refused. */
const account = (v: string | undefined) => {
  const t = clean(v)?.replace(/^'/, "").replace(/\s/g, "") ?? null;
  return t && !/e\+/i.test(t) ? t : null;
};

export function readTrailRows(rows: string[][]): TrailReading {
  // The heading row: the first of the top 20 rows naming at least four known columns.
  let headerIdx = -1;
  let best = 0;
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const n = new Set((rows[i] ?? []).map(roleOf).filter(Boolean)).size;
    if (n >= 4 && n > best) {
      best = n;
      headerIdx = i;
    }
  }
  if (headerIdx < 0) throw new Error("This sheet does not look like an NCRP money-trail export: no row names the layer, account, action and amount columns.");
  const head = rows[headerIdx]!;
  const columns: TrailReading["columns"] = [];
  const utrCols: number[] = [];
  const accountCols: number[] = [];
  head.forEach((h, index) => {
    const role = roleOf(h);
    if (!role) return;
    if (role === "utr") return void utrCols.push(index);
    if (role === "toAccount") return void accountCols.push(index);
    if (!columns.some((c) => c.role === role)) columns.push({ role, header: h.trim(), index });
  });
  // The export names the UTR column twice: the first is the complainant's payment, the second the bank's onward one.
  if (utrCols.length >= 2) {
    columns.push({ role: "victimUtr", header: head[utrCols[0]!]!.trim(), index: utrCols[0]! });
    columns.push({ role: "utr", header: head[utrCols[1]!]!.trim(), index: utrCols[1]! });
  } else if (utrCols.length === 1) columns.push({ role: "utr", header: head[utrCols[0]!]!.trim(), index: utrCols[0]! });
  // A sheet with only a plain "Account No" column uses it for the account acted on.
  if (accountCols.length) {
    const hasFrom = columns.some((c) => c.role === "fromAccount");
    columns.push({ role: hasFrom ? "toAccount" : "fromAccount", header: head[accountCols[0]!]!.trim(), index: accountCols[0]! });
    if (!hasFrom && accountCols[1] !== undefined) columns.push({ role: "toAccount", header: head[accountCols[1]]!.trim(), index: accountCols[1] });
  }
  const at = (role: Role) => columns.find((c) => c.role === role)?.index;
  if (at("fromAccount") === undefined || (at("action") === undefined && at("toAccount") === undefined && at("holdAmount") === undefined)) {
    throw new Error("This sheet does not look like an NCRP money-trail export: it has no account column with an action, onward account or hold amount.");
  }

  const out: TrailRow[] = [];
  const skipped: TrailReading["skipped"] = [];
  const acks = new Set<string>();
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i] ?? [];
    const get = (role: Role) => {
      const idx = at(role);
      return idx === undefined ? undefined : r[idx];
    };
    if (!r.some((c) => c && c.trim())) continue;
    const line = i + 1;
    const fromAcct = account(get("fromAccount"));
    if (!fromAcct) {
      skipped.push({ line, reason: /e\+/i.test(get("fromAccount") ?? "") ? "The account number was turned into a number by Excel (like 5.01E+13); its digits are lost." : "No account number in the row." });
      continue;
    }
    const toAcct = account(get("toAccount"));
    const hold = amountMinor(get("holdAmount") ?? "");
    const actionText = clean(get("action")) ?? "";
    const action = actionOf(actionText, !!toAcct, hold);
    const layerText = clean(get("layer"));
    const layer = layerText && /^\d{1,2}$/.test(layerText) ? Number(layerText) : null;
    const ack = clean(get("ack"));
    if (ack) acks.add(ack);
    out.push({
      line,
      layer,
      from: { account: fromAcct, bank: clean(get("fromBank")), ifsc: null },
      action,
      actionText,
      to: action === "TRANSFER" && toAcct ? { account: toAcct, bank: clean(get("toBank")), ifsc: clean(get("toIfsc"))?.toUpperCase() ?? null } : null,
      utr: clean(get("utr")),
      occurredAt: istDate(get("occurredAt") ?? "") ?? istDate(get("actionDate") ?? ""),
      amountMinor: amountMinor(get("amount") ?? ""),
      holdMinor: hold,
      victimUtr: clean(get("victimUtr")),
      disputedMinor: amountMinor(get("disputed") ?? ""),
      terminal: clean(get("terminal")),
      place: clean(get("place")),
      ack,
      remarks: clean(get("remarks")),
    });
  }
  return { headerRow: headerIdx + 1, columns, rows: out, skipped, acks: [...acks] };
}
