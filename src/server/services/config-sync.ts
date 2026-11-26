import type { Db } from "../db";
import { recordAudit } from "../audit";
import { now } from "../clock";
import { configVersion, getAppConfig, type AppConfig } from "../config";
import { formatDateIST } from "@/domain/time";

/**
 * Applies the configuration file to the database: station identity and the recipient directory.
 * Contact details are owned by the file; verification is an audited in-app decision. If a
 * recipient's address changes in the file, it becomes unverified until a supervisor verifies it.
 */
export async function applyConfig(db: Db, cfg: AppConfig): Promise<{ changed: number; details: string[] }> {
  return db.$transaction(async (tx) => {
    const details: string[] = [];
    const at = now();
    const s = cfg.station;
    const station = await tx.station.findUnique({ where: { code: s.code } });
    if (!station) {
      await tx.station.create({ data: { code: s.code, name: s.name, district: s.district, address: s.address, phone: s.phone, email: s.email, createdAt: at } });
      details.push(`Station ${s.code} created`);
    } else if (station.name !== s.name || station.district !== s.district || station.address !== s.address || station.phone !== s.phone || station.email !== s.email) {
      await tx.station.update({ where: { id: station.id }, data: { name: s.name, district: s.district, address: s.address, phone: s.phone, email: s.email } });
      details.push(`Station details updated (${s.name})`);
    }

    const keys = cfg.directory.map((d) => d.key);
    for (const r of cfg.directory) {
      const data = {
        name: r.name,
        organisation: r.organisation,
        organisationType: r.organisationType,
        channel: r.channel,
        address: r.address,
        ifscPrefix: r.ifscPrefix ?? null,
        categoriesJson: JSON.stringify(r.categories),
        notes: r.notes ?? null,
        active: true,
        isSynthetic: r.synthetic,
      };
      const existing = await tx.recipient.findUnique({ where: { configKey: r.key } });
      if (!existing) {
        await tx.recipient.create({
          data: {
            ...data,
            configKey: r.key,
            verificationStatus: r.verified ? "VERIFIED" : "UNVERIFIED",
            verifiedAt: r.verified ? at : null,
            verificationNote: r.verificationNote ?? (r.verified ? "Marked verified in the station configuration file." : null),
            createdAt: at,
          },
        });
        details.push(`Recipient added: ${r.name}`);
        continue;
      }
      const addressChanged = existing.address !== r.address;
      const otherChanged =
        existing.name !== data.name ||
        existing.organisation !== data.organisation ||
        existing.organisationType !== data.organisationType ||
        existing.channel !== data.channel ||
        existing.ifscPrefix !== data.ifscPrefix ||
        existing.categoriesJson !== data.categoriesJson ||
        existing.notes !== data.notes ||
        !existing.active;
      if (!addressChanged && !otherChanged) continue;
      await tx.recipient.update({
        where: { id: existing.id },
        data: {
          ...data,
          ...(addressChanged
            ? {
                verificationStatus: "UNVERIFIED",
                verifiedById: null,
                verifiedAt: null,
                verificationNote: `Address changed in the configuration file from ${existing.address} to ${r.address} on ${formatDateIST(at)}. Verify it again before submitting.`,
              }
            : {}),
        },
      });
      details.push(addressChanged ? `Recipient address changed and verification reset: ${r.name}` : `Recipient details updated: ${r.name}`);
    }

    const removed = await tx.recipient.findMany({ where: { configKey: { not: null, notIn: keys }, active: true } });
    for (const r of removed) {
      await tx.recipient.update({ where: { id: r.id }, data: { active: false } });
      details.push(`Recipient removed from the configuration file and deactivated: ${r.name}`);
    }

    if (details.length) {
      await recordAudit(tx, { caseId: null, actorId: null, action: "config.applied", objectType: "Configuration", summary: `Configuration file applied: ${details.length === 1 ? "1 change" : `${details.length} changes`}`, detail: { details } });
    }
    return { changed: details.length, details };
  });
}

let lastApplied: string | null = null;

/** Applies the configuration file once per change. Called from server layouts before rendering. */
export async function ensureConfigApplied(db: Db): Promise<void> {
  const v = configVersion();
  const token = `${v.file}:${v.mtimeMs}:${v.size}:${process.env.DATABASE_URL ?? ""}`;
  if (lastApplied === token) return;
  await applyConfig(db, getAppConfig());
  lastApplied = token;
}
