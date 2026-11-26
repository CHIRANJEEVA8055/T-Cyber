import "dotenv/config";
import { getDb } from "../src/server/db";
import { seedDemo } from "../src/server/seed";
import { DEMO_PASSWORD } from "../src/server/seed/directory";

async function main() {
  const db = getDb();
  const existing = await db.station.count();
  if (existing > 0) {
    console.log("The database already contains data. Nothing was changed.");
    console.log("To start again from the demonstration data, run: npm run db:reset");
    return;
  }
  console.log("Seeding synthetic demonstration data (this runs the real workflows; about 30 seconds)...");
  const ids = await seedDemo(db);
  console.log("Done. Cases:", ids);
  console.log(`Demo accounts (password "${DEMO_PASSWORD}"): officer1 (SI Krishna), officer2 (SI P. Lavanya), officer3 (SI M. Arjun), supervisor (Inspector R. Devi)`);
  await db.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
