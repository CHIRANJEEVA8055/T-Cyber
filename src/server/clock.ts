/**
 * Single source of "now" for services. The seed script runs the real workflows at historical
 * times by overriding the clock; at runtime it is always the system time. Not used for any
 * security decision (session expiry uses Date.now()).
 */
let override: Date | null = null;

export function now(): Date {
  return override ? new Date(override.getTime()) : new Date();
}

/** Seed/test only: pins the clock to a fixed instant (null restores the system clock). */
export function setClock(instant: Date | null): void {
  override = instant ? new Date(instant.getTime()) : null;
}
