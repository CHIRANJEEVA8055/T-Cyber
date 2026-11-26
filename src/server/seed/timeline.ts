import { istInputToUtc } from "@/domain/time";

/**
 * The demonstration is seeded relative to a "today" (the anchor), so it reads the same whenever it is reset:
 * FIR 412/2026 is on day 7, a hold expires in 2 days, this morning's replies are this morning's. The anchor is
 * today in IST, or yesterday when the reset happens before 11:00 IST, so this morning's events are never in the future.
 */
export interface DemoTimeline {
  /** YYYY-MM-DD (IST): the demonstration's "today". */
  anchor: string;
  /** YYYY-MM-DD, `offset` days from the anchor. */
  date(offset: number): string;
  /** The instant at hh:mm IST, `offset` days from the anchor. */
  at(offset: number, hhmm: string): Date;
  /** "YYYY-MM-DDTHH:MM" in IST, the form services take. */
  input(offset: number, hhmm: string): string;
  /** "DD-MM-YYYY", as documents write dates. */
  doc(offset: number): string;
  /** "DD-MM-YYYY HH:MM". */
  docTime(offset: number, hhmm: string): string;
}

const shift = (date: string, days: number) => {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};

export function demoAnchor(now = new Date()): string {
  const ist = new Date(now.getTime() + 330 * 60 * 1000);
  const today = ist.toISOString().slice(0, 10);
  return ist.getUTCHours() >= 11 ? today : shift(today, -1);
}

export function makeTimeline(anchor: string): DemoTimeline {
  const date = (offset: number) => shift(anchor, offset);
  const input = (offset: number, hhmm: string) => `${date(offset)}T${hhmm}`;
  const doc = (offset: number) => date(offset).split("-").reverse().join("-");
  return {
    anchor,
    date,
    input,
    at: (offset, hhmm) => istInputToUtc(input(offset, hhmm))!,
    doc,
    docTime: (offset, hhmm) => `${doc(offset)} ${hhmm}`,
  };
}
