/**
 * All timestamps are stored in UTC and displayed in Asia/Kolkata (IST, UTC+05:30, no DST).
 * Formatting is done arithmetically rather than through locale data so the server and the
 * browser always render identical strings.
 */

const IST_OFFSET_MS = 330 * 60 * 1000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const pad = (n: number) => n.toString().padStart(2, "0");

function istParts(date: Date) {
  const d = new Date(date.getTime() + IST_OFFSET_MS);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth(),
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
  };
}

export function formatDateIST(date: Date): string {
  const p = istParts(date);
  return `${pad(p.day)} ${MONTHS[p.month]} ${p.year}`;
}

/** "05 Nov": day and month in IST, for places where the year is plain from context. */
export function formatDayMonthIST(date: Date): string {
  const p = istParts(date);
  return `${pad(p.day)} ${MONTHS[p.month]}`;
}

export function formatDateTimeIST(date: Date, opts: { seconds?: boolean; label?: boolean } = {}): string {
  const p = istParts(date);
  const time = `${pad(p.hour)}:${pad(p.minute)}${opts.seconds ? `:${pad(p.second)}` : ""}`;
  return `${pad(p.day)} ${MONTHS[p.month]} ${p.year}, ${time}${opts.label === false ? "" : " IST"}`;
}

export function formatTimeIST(date: Date): string {
  const p = istParts(date);
  return `${pad(p.hour)}:${pad(p.minute)} IST`;
}

/** Value for <input type="datetime-local"> showing the IST wall-clock time. */
export function utcToIstInput(date: Date): string {
  const p = istParts(date);
  return `${p.year}-${pad(p.month + 1)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

export function utcToIstDateInput(date: Date): string {
  const p = istParts(date);
  return `${p.year}-${pad(p.month + 1)}-${pad(p.day)}`;
}

/** Parses an IST wall-clock value (YYYY-MM-DDTHH:mm[:ss]) to a UTC Date. */
export function istInputToUtc(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(value.trim());
  if (!m) return null;
  const [year, month, day, hour, minute, second] = [m[1], m[2], m[3], m[4] ?? "0", m[5] ?? "0", m[6] ?? "0"].map(Number) as [
    number, number, number, number, number, number,
  ];
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  const utcMs = Date.UTC(year, month - 1, day, hour, minute, second) - IST_OFFSET_MS;
  const check = new Date(utcMs + IST_OFFSET_MS);
  if (check.getUTCDate() !== day) return null; // e.g. 31 Feb
  return new Date(utcMs);
}

/**
 * Location observations whose event time is a calendar date with no time of day (a KYC record carries
 * the account-opening date). They are shown as a date so no time is invented.
 */
const DATE_ONLY_OBSERVATIONS = new Set(["KYC_ADDRESS"]);
export function isDateOnlyObservation(observationType: string): boolean {
  return DATE_ONLY_OBSERVATIONS.has(observationType);
}
