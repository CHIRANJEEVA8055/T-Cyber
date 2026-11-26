/**
 * Money is always handled as bigint minor units (paise). No floating point is used
 * anywhere in parsing, arithmetic or formatting. `null` means "unknown" and must be
 * rendered as such — never coerced to zero.
 */

export type Minor = bigint;
export type MaybeMinor = bigint | null;

export type ParseResult = { ok: true; value: Minor } | { ok: false; error: string };

/** ₹1,00,000 crore — far above any realistic single case, but bounded. */
const MAX_RUPEES = 1_000_000_000_000n;

const INDIAN_GROUPED = /^\d{1,2}(,\d{2})*,\d{3}$/;
const WESTERN_GROUPED = /^\d{1,3}(,\d{3})+$/;
const UNGROUPED = /^\d+$/;

export function parseRupeesToMinor(input: string): ParseResult {
  let text = input.trim();
  if (text === "") return { ok: false, error: "Enter an amount in rupees, for example 20,00,000." };

  text = text.replace(/^(₹|rs\.?|inr)\s*/i, "");
  text = text.replace(/\s*\/-$/, "").trim();

  const match = /^([\d,]+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) {
    return { ok: false, error: "Use digits only, with up to two decimal places (for example 4,00,000.50)." };
  }
  const whole = match[1] ?? "";
  const fraction = match[2] ?? "";

  if (!(UNGROUPED.test(whole) || INDIAN_GROUPED.test(whole) || WESTERN_GROUPED.test(whole))) {
    return { ok: false, error: "The digit grouping is not valid. Check the commas (for example 20,00,000)." };
  }

  const rupees = BigInt(whole.replace(/,/g, ""));
  if (rupees > MAX_RUPEES) {
    return { ok: false, error: "The amount is larger than this system supports. Check the figure." };
  }
  const paise = fraction === "" ? 0n : BigInt(fraction.padEnd(2, "0"));
  return { ok: true, value: rupees * 100n + paise };
}

function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits;
  const last3 = digits.slice(-3);
  let rest = digits.slice(0, -3);
  const groups: string[] = [];
  while (rest.length > 2) {
    groups.unshift(rest.slice(-2));
    rest = rest.slice(0, -2);
  }
  if (rest.length > 0) groups.unshift(rest);
  return `${groups.join(",")},${last3}`;
}

export function formatInr(minor: Minor): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const rupees = abs / 100n;
  const paise = abs % 100n;
  const body = groupIndian(rupees.toString()) + (paise === 0n ? "" : `.${paise.toString().padStart(2, "0")}`);
  return `${negative ? "−" : ""}₹${body}`;
}

export function formatMaybeInr(minor: MaybeMinor): string {
  return minor === null ? "Unknown" : formatInr(minor);
}

export function minorToString(minor: Minor): string {
  return minor.toString();
}

export function minorFromString(value: string): Minor {
  if (!/^-?\d+$/.test(value)) {
    throw new Error(`Invalid minor-unit amount: "${value}"`);
  }
  return BigInt(value);
}

export function maybeMinorFromString(value: string | null): MaybeMinor {
  return value === null ? null : minorFromString(value);
}

export function sumMinor(values: readonly Minor[]): Minor {
  let total = 0n;
  for (const v of values) total += v;
  return total;
}

/** "₹92.5 L" for a lakh and more (one decimal); smaller sums in full. For figures read at a glance. */
export function formatLakh(minor: Minor): string {
  const rupees = minor / 100n;
  if (rupees < 100000n && rupees > -100000n) return formatInr(minor);
  const tenths = Number((rupees * 10n + (rupees >= 0n ? 50000n : -50000n)) / 100000n);
  return `₹${(tenths / 10).toFixed(1)} L`;
}
