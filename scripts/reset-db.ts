import "dotenv/config";
import readline from "node:readline/promises";
import { getDb } from "../src/server/db";
import { resetDemo } from "../src/server/seed";

/**
 * Explicit, confirmed demo reset: deletes ALL data in the configured database and stored
 * evidence files, then reseeds the synthetic demonstration. Pass --yes to skip the prompt
 * (used by automated tests only).
 */
async function main() {
  const url = process.env.DATABASE_URL ?? "file:./data/t-cyber.db";
  if (!process.argv.includes("--yes")) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log(`This deletes ALL data in ${url} and in ${process.env.STORAGE_DIR ?? "./data/storage"}, then reloads the synthetic demonstration.`);
    const answer = await rl.question('Type RESET to continue: ');
    rl.close();
    if (answer.trim() !== "RESET") {
      console.log("Reset cancelled. Nothing was changed.");
      return;
    }
  }
  const db = getDb();
  const ids = await resetDemo(db, null);
  console.log("Demonstration data reset.", ids);
  await db.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
