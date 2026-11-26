import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// Give every test file its own database copy and storage directory, in this run's folder (see global-setup.ts).
const root = path.resolve(import.meta.dirname, "../..");
const dir = process.env.T_CYBER_TEST_DIR ?? "";
const template = process.env.T_CYBER_TEST_TEMPLATE_DB ?? "";
// Never fall back to the station's own database (DATABASE_URL in .env): a test without its copy must not run at all.
if (!dir || !template || !fs.existsSync(template)) {
  throw new Error(`The test database template is missing (${template || "not set"}). Run the tests with "npx vitest run"; nothing was run against the station's database.`);
}
const id = crypto.randomBytes(6).toString("hex");
const dbFile = path.join(dir, `file-${id}.db`);
fs.copyFileSync(template, dbFile);
process.env.DATABASE_URL = `file:${dbFile}`;
process.env.STORAGE_DIR = path.join(dir, `storage-${id}`);
process.env.T_CYBER_DISABLE_NETWORK = "1";
// Tests send straight to the (simulated) recipient unless a test sets delivery "via-io" itself, with its own config
// copy (see tests/support/delivery-config.ts). The station's config file is never edited by tests.
{
  const station = JSON.parse(fs.readFileSync(path.join(root, "config", "t-cyber.config.json"), "utf8")) as Record<string, unknown>;
  const file = path.join(dir, `config-${id}.json`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...station, delivery: { ...(station.delivery as object), mode: "direct" }, gmail: { ...(station.gmail as object), enabled: false } }));
  process.env.T_CYBER_CONFIG = file;
}
