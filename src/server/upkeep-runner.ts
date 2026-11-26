import { getDb } from "./db";
import { upkeepOpenCases } from "./services/upkeep";

/**
 * Runs the case upkeep (services/upkeep.ts) in the background of the T-CYBER server: a minute after it starts, then
 * every T_CYBER_UPKEEP_MINUTES (15 by default); T_CYBER_UPKEEP=0 switches it off. One pass at a time; a failure is
 * logged, never thrown. The drafts it writes are copied to Gmail by the Gmail sync like any other unsent draft;
 * nothing is ever sent.
 */
const g = globalThis as unknown as { __tcyberUpkeep?: { timer: NodeJS.Timeout; busy: boolean; last: { at: string; result: string } | null } };

async function pass() {
  const st = g.__tcyberUpkeep;
  if (!st || st.busy) return;
  st.busy = true;
  try {
    const r = await upkeepOpenCases(getDb());
    st.last = { at: new Date().toISOString(), result: `${r.cases} open cases checked${r.drafted.length ? `; ${r.drafted.length} reminders drafted: ${r.drafted.map((d) => d.reference).join(", ")}` : ""}${r.failed ? `; ${r.failed} failed` : ""}` };
    if (r.drafted.length || r.failed) console.log(`[upkeep] ${st.last.result}`);
  } catch (err) {
    st.last = { at: new Date().toISOString(), result: `failed: ${(err as Error).message}` };
    console.error(`[upkeep] ${st.last.result}`);
  } finally {
    st.busy = false;
  }
}

export function startUpkeepRunner() {
  if (g.__tcyberUpkeep) clearInterval(g.__tcyberUpkeep.timer);
  // Switched off for the browser tests (T_CYBER_UPKEEP=0), whose figures are fixed.
  if (process.env.T_CYBER_UPKEEP === "0") return;
  const minutes = Math.max(1, Number(process.env.T_CYBER_UPKEEP_MINUTES ?? 15) || 15);
  g.__tcyberUpkeep = { timer: setInterval(() => void pass(), minutes * 60 * 1000), busy: false, last: g.__tcyberUpkeep?.last ?? null };
  g.__tcyberUpkeep.timer.unref?.();
  setTimeout(() => void pass(), 60 * 1000).unref?.();
}

/** The last pass, for a status line: when, and what it did. */
export function upkeepStatus() {
  return g.__tcyberUpkeep?.last ?? null;
}
