import fs from "node:fs";
import path from "node:path";
import { getDb } from "../src/server/db";
import { importNodalWorkbook } from "../src/server/services/nodal";
import type { SessionUser } from "../src/server/auth/session";

/** Imports or refreshes the nodal officer list as the developer account:  npm run nodal:import -- data/nodal_officers.xlsx */
async function main() {
  const file = process.argv[2];
  if (!file || !fs.existsSync(file)) {
    console.error("Give the workbook, e.g. npm run nodal:import -- data/nodal_officers.xlsx");
    process.exit(1);
  }
  const db = getDb();
  const dev = await db.user.findFirst({ where: { role: "DEVELOPER", active: true }, include: { station: true } });
  if (!dev) {
    console.error("No active developer account. Reset or seed the demonstration first.");
    process.exit(1);
  }
  const user: SessionUser = { id: dev.id, username: dev.username, displayName: dev.displayName, rank: dev.rank, role: "DEVELOPER", stationId: dev.stationId, stationCode: dev.station.code, stationName: dev.station.name };
  const r = await importNodalWorkbook(db, user, { fileName: path.basename(file), buffer: fs.readFileSync(file) });
  console.log(`Nodal officer list: ${r.added} added, ${r.updated} updated, ${r.skipped} skipped (${r.total} contacts).`);
}
main();
