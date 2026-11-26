import { execFileSync } from "node:child_process";
import path from "node:path";

/** Resets the E2E database (or the dev database when PW_DEV=1) to the seeded demonstration. */
export default function globalSetup() {
  const root = path.resolve(import.meta.dirname, "../..");
  const dev = process.env.PW_DEV === "1";
  const env = {
    ...process.env,
    DATABASE_URL: dev ? "file:./data/t-cyber.db" : "file:./data/e2e.db",
    STORAGE_DIR: dev ? "./data/storage" : "./data/e2e-storage",
    CHECKPOINT_DISABLE: "1",
  };
  execFileSync("npx", ["prisma", "migrate", "deploy"], { cwd: root, env, stdio: "pipe" });
  execFileSync("npx", ["tsx", "scripts/reset-db.ts", "--yes"], { cwd: root, env, stdio: "pipe" });
}
