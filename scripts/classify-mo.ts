import { getDb } from "../src/server/db";
import { classifyCase } from "../src/server/services/case-mo";
import { localModelStatus } from "../src/server/ai/local-model";
import type { SessionUser } from "../src/server/auth/session";

/**
 * Places every case not yet in an investigation vertical (data/MO.docx) in one: as its FIR states the MO, or else by
 * the local model from its brief and facts (the rules when the model is not running). Cases an officer has set are
 * never changed. Each decision is logged against the case.
 *   npm run mo:classify            cases not classified yet
 *   npm run mo:classify -- --redo  also cases classified by the rules while the model was not running
 */
async function main() {
  const db = getDb();
  const redo = process.argv.includes("--redo");
  const status = await localModelStatus();
  console.log(status.reachable && status.hasModel ? `Local model ${status.model} is ready.` : `The local model is not available (${status.note}); the rules will decide.`);
  const cases = await db.case.findMany({
    where: redo ? { OR: [{ moVertical: null }, { moBasis: { in: ["FACTS", "SECTIONS", "DEFAULT"] } }] } : { moVertical: null },
    select: { id: true, stationId: true, firNumber: true, firYear: true, complaintRef: true },
    orderBy: { createdAt: "asc" },
  });
  let done = 0;
  for (const c of cases) {
    const sup = await db.user.findFirst({ where: { stationId: c.stationId, role: "SUPERVISOR", active: true }, include: { station: true } });
    if (!sup) {
      console.log(`  ${c.firNumber ?? c.complaintRef}/${c.firYear}: no active supervisor at its station; skipped`);
      continue;
    }
    const user: SessionUser = { id: sup.id, username: sup.username, displayName: sup.displayName, rank: sup.rank, role: "SUPERVISOR", stationId: sup.stationId, stationCode: sup.station.code, stationName: sup.station.name };
    const d = await classifyCase(db, user, c.id);
    done++;
    console.log(`  ${c.firNumber ? `FIR ${c.firNumber}/${c.firYear}` : `Complaint ${c.complaintRef}`}: ${d.key}${d.subtype ? ` · ${d.subtype}` : ""} (${d.basis})`);
  }
  console.log(`Classified ${done} of ${cases.length} cases.`);
}
main();
