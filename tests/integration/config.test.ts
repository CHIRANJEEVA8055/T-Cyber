import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, expect, it } from "vitest";
import { getDb } from "@/server/db";
import { loadConfigFromFile, ConfigError, getAppConfig, getConfigStatus } from "@/server/config";
import { applyConfig } from "@/server/services/config-sync";

const repoConfig = path.resolve(import.meta.dirname, "../../config/t-cyber.config.json");

function writeTemp(obj: unknown): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tcyber-cfg-")), "config.json");
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
  return file;
}

describe("configuration file", () => {
  it("loads and validates the repository configuration", () => {
    const cfg = loadConfigFromFile(repoConfig);
    expect(cfg.station.code).toMatch(/^[A-Z0-9-]+$/);
    expect(cfg.mailbox.fromAddress).toContain("@");
    expect(cfg.directory.length).toBeGreaterThan(5);
    expect(new Set(cfg.directory.map((d) => d.key)).size).toBe(cfg.directory.length);
  });

  it("keeps the last valid configuration when the file becomes invalid, reports why, and picks up the fix", () => {
    const base = JSON.parse(fs.readFileSync(repoConfig, "utf8"));
    const file = writeTemp(base);
    const touch = (offsetMs: number) => fs.utimesSync(file, new Date(), new Date(Date.now() + offsetMs));
    const previous = process.env.T_CYBER_CONFIG;
    process.env.T_CYBER_CONFIG = file;
    try {
      expect(getAppConfig().station.name).toBe(base.station.name);
      expect(getConfigStatus()).toMatchObject({ file, ok: true, error: null });

      fs.writeFileSync(file, "{ not json");
      touch(2000);
      expect(getAppConfig().station.name).toBe(base.station.name);
      const broken = getConfigStatus();
      expect(broken.ok).toBe(false);
      expect(broken.error).toMatch(/not valid JSON/);

      fs.writeFileSync(file, JSON.stringify({ ...base, station: { ...base.station, name: "Changed station name" } }));
      touch(4000);
      expect(getAppConfig().station.name).toBe("Changed station name");
      expect(getConfigStatus()).toMatchObject({ ok: true, error: null });
    } finally {
      if (previous === undefined) delete process.env.T_CYBER_CONFIG;
      else process.env.T_CYBER_CONFIG = previous;
    }
  });

  it("rejects invalid values with the path of each problem", () => {
    const base = JSON.parse(fs.readFileSync(repoConfig, "utf8"));
    base.mailbox.fromAddress = "not-an-email";
    base.directory.push({ ...base.directory[0] });
    const file = writeTemp(base);
    try {
      loadConfigFromFile(file);
      throw new Error("expected a ConfigError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const msg = (err as ConfigError).message;
      expect(msg).toContain("mailbox.fromAddress");
      expect(msg).toMatch(/duplicate directory key/i);
    }
  });

  it("applies station and directory details, and resets verification when an address changes", async () => {
    const db = getDb();
    const base = JSON.parse(fs.readFileSync(repoConfig, "utf8"));
    base.station.code = `TEST-${Date.now()}`;
    const first = loadConfigFromFile(writeTemp(base));
    await applyConfig(db, first);
    const station = await db.station.findUniqueOrThrow({ where: { code: base.station.code } });
    expect(station.name).toBe(base.station.name);
    const key = first.directory[0]!.key;
    const before = await db.recipient.findUniqueOrThrow({ where: { configKey: key } });
    expect(before.verificationStatus).toBe(first.directory[0]!.verified ? "VERIFIED" : "UNVERIFIED");

    base.station.name = "Renamed Station (Demo)";
    base.directory[0].address = "changed.desk@bank-a.example.invalid";
    base.directory[1].notes = "Notes only changed";
    const second = loadConfigFromFile(writeTemp(base));
    const summary = await applyConfig(db, second);
    expect(summary.changed).toBeGreaterThan(0);
    expect((await db.station.findUniqueOrThrow({ where: { code: base.station.code } })).name).toBe("Renamed Station (Demo)");
    const after = await db.recipient.findUniqueOrThrow({ where: { configKey: key } });
    expect(after.address).toBe("changed.desk@bank-a.example.invalid");
    expect(after.verificationStatus).toBe("UNVERIFIED");
    expect(after.verificationNote).toMatch(/address changed in the configuration file/i);
    const notesOnly = await db.recipient.findUniqueOrThrow({ where: { configKey: second.directory[1]!.key } });
    expect(notesOnly.verificationStatus).toBe(second.directory[1]!.verified ? "VERIFIED" : "UNVERIFIED");
  });

  it("is idempotent when nothing changed", async () => {
    const db = getDb();
    const base = JSON.parse(fs.readFileSync(repoConfig, "utf8"));
    base.station.code = `IDEM-${Date.now()}`;
    const cfg = loadConfigFromFile(writeTemp(base));
    await applyConfig(db, cfg);
    const again = await applyConfig(db, cfg);
    expect(again.changed).toBe(0);
  });
});
