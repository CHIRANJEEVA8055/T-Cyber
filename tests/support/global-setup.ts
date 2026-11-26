import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Builds a migrated template database once per test run, in a folder of its own (data/test/run-…), so two test runs
 * at the same time never remove each other's files. Each test file copies the template (see per-file-setup.ts) so
 * integration tests never share mutable state. The folder is removed when the run ends; folders left by runs that
 * were killed are removed after a day.
 */
export default function setup() {
  const root = path.resolve(import.meta.dirname, "../..");
  const base = path.join(root, "data", "test");
  fs.mkdirSync(base, { recursive: true });
  for (const name of fs.readdirSync(base)) {
    const p = path.join(base, name);
    const old = Date.now() - fs.statSync(p).mtimeMs > 24 * 3600 * 1000;
    // The flat files of the earlier layout, and run folders a killed run left behind.
    if (!name.startsWith("run-") || old) fs.rmSync(p, { recursive: true, force: true });
  }
  const dir = path.join(base, `run-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
  fs.mkdirSync(dir, { recursive: true });
  const template = path.join(dir, "template.db");
  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: `file:${template}`, CHECKPOINT_DISABLE: "1" },
    stdio: "pipe",
  });
  process.env.T_CYBER_TEST_DIR = dir;
  process.env.T_CYBER_TEST_TEMPLATE_DB = template;
  return () => fs.rmSync(dir, { recursive: true, force: true });
}
