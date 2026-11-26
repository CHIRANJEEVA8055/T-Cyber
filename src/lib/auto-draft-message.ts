/** Toast text for an officer action that was followed by automatic drafting (see services/auto-draft). */
export function autoDraftMessage(done: string, a: { drafted: number } | null | undefined): string {
  const n = a?.drafted ?? 0;
  if (!n) return done;
  return `${done}. ${n === 1 ? "1 request drafted" : `${n} requests drafted`} for your review; nothing was sent`;
}
