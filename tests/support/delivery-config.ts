import fs from "node:fs";
import path from "node:path";

/** Points this test file at a config copy with the given delivery settings (the station's file is untouched). */
export function useDelivery(delivery: Record<string, unknown>) {
  const current = process.env.T_CYBER_CONFIG!;
  const json = JSON.parse(fs.readFileSync(current, "utf8")) as Record<string, unknown>;
  const file = path.join(path.dirname(current), `${path.basename(current, ".json")}-${Object.values(delivery).join("-").replace(/[^\w-]/g, "")}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...json, delivery: { ...(json.delivery as object), ...delivery } }));
  process.env.T_CYBER_CONFIG = file;
  return file;
}

/** Points this test file at a config copy with the Gmail link switched on, a fake token, and Gmail delivery. */
export function useGmail(account = "station.test@example.invalid", extra: { gmail?: Record<string, unknown>; scope?: string } = {}) {
  const current = process.env.T_CYBER_CONFIG!;
  const dir = path.dirname(current);
  const credentialsFile = path.join(dir, "gmail-credentials.test.json");
  // One token file per test file (they run side by side): what one writes never changes another's link.
  const tokenFile = path.join(dir, `${path.basename(current, ".json")}-gmail-token.json`);
  fs.writeFileSync(credentialsFile, JSON.stringify({ installed: { client_id: "test-client", client_secret: "test-secret" } }));
  fs.writeFileSync(tokenFile, JSON.stringify({ refresh_token: "test-refresh", account, connectedAt: "2000-01-01T00:00:00.000Z", ...(extra.scope ? { scope: extra.scope } : {}) }));
  const json = JSON.parse(fs.readFileSync(current, "utf8")) as Record<string, unknown>;
  const file = path.join(dir, `${path.basename(current, ".json")}-gmail.json`);
  fs.writeFileSync(file, JSON.stringify({ ...json, delivery: { ...(json.delivery as object), mode: "gmail" }, gmail: { enabled: true, account, credentialsFile, tokenFile, syncSeconds: 20, ...(extra.gmail ?? {}) } }));
  process.env.T_CYBER_CONFIG = file;
  return file;
}
