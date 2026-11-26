import { z } from "zod";
import type { Db, Tx } from "../db";
import type { SessionUser } from "../auth/session";
import { getAppConfig } from "../config";
import { recordAudit } from "../audit";
import { AppError } from "../errors";
import { closingLines, defaultClosing } from "@/domain/closing";

/**
 * What an officer's new drafts are sent from and signed with. The station mailbox and closing come from the
 * configuration; an officer who corrects them on a draft can make the correction their own default, for their new
 * drafts only. Existing drafts keep what they were written with.
 */
export interface MailDefaults {
  /** The From address new drafts use. */
  from: string;
  /** The closing lines new drafts end with. */
  closing: string[];
  stationFrom: string;
  stationClosing: string[];
  /** Whether the officer has set their own From address and closing. */
  own: { from: boolean; closing: boolean };
}

const parseLines = (json: string | null) => {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) && v.every((x) => typeof x === "string") && v.length ? (v as string[]) : null;
  } catch {
    return null;
  }
};

export async function mailDefaultsFor(db: Db | Tx, user: Pick<SessionUser, "id" | "displayName" | "rank">): Promise<MailDefaults> {
  const cfg = getAppConfig().mailbox;
  const u = await db.user.findUnique({ where: { id: user.id }, select: { mailFrom: true, mailClosingJson: true } });
  const stationClosing = defaultClosing(user, cfg);
  const mine = parseLines(u?.mailClosingJson ?? null);
  return { from: u?.mailFrom ?? cfg.fromAddress, closing: mine ?? stationClosing, stationFrom: cfg.fromAddress, stationClosing, own: { from: !!u?.mailFrom, closing: !!mine } };
}

const emailSchema = z.string().trim().max(120).regex(/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/, "Enter the From address as an email address, like io.ps@police.gov.in.");

/** A From address as stored on a version: null when it is the station mailbox. */
export function storedFrom(address: string | null | undefined): string | null {
  const a = address?.trim();
  if (!a) return null;
  const ok = emailSchema.safeParse(a);
  if (!ok.success) throw new AppError(ok.error.issues[0]!.message, "VALIDATION", { fromAddress: ok.error.issues[0]!.message });
  return a.toLowerCase() === getAppConfig().mailbox.fromAddress.toLowerCase() ? null : a;
}

/** Makes a From address and/or a closing block the officer's default for new drafts; null returns to the station's. */
export async function setMailDefaults(db: Db, user: SessionUser, input: { fromAddress?: string | null; closing?: string | null }) {
  const data: { mailFrom?: string | null; mailClosingJson?: string | null } = {};
  if (input.fromAddress !== undefined) data.mailFrom = storedFrom(input.fromAddress);
  if (input.closing !== undefined) {
    const lines = input.closing === null ? [] : closingLines(input.closing);
    if (lines.length > 10 || lines.some((l) => l.length > 120)) throw new AppError("Keep the closing to ten short lines.", "VALIDATION", { closing: "Keep the closing to ten short lines." });
    const station = defaultClosing(user, getAppConfig().mailbox);
    data.mailClosingJson = !lines.length || JSON.stringify(lines) === JSON.stringify(station) ? null : JSON.stringify(lines);
  }
  if (!Object.keys(data).length) return mailDefaultsFor(db, user);
  await db.$transaction(async (tx) => {
    await tx.user.update({ where: { id: user.id }, data });
    const parts = [data.mailFrom !== undefined ? `From address ${data.mailFrom ?? `the station mailbox (${getAppConfig().mailbox.fromAddress})`}` : null, data.mailClosingJson !== undefined ? (data.mailClosingJson ? "their own closing block" : "the station's closing block") : null].filter(Boolean);
    await recordAudit(tx, { caseId: null, actorId: user.id, action: "user.mail_defaults_changed", objectType: "User", objectId: user.id, summary: `${user.displayName} set ${parts.join(" and ")} for their new drafts`, detail: data });
  });
  return mailDefaultsFor(db, user);
}
