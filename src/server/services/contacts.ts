import { z } from "zod";
import { istInputToUtc } from "@/domain/time";
import { now } from "../clock";
import type { Db } from "../db";
import type { SessionUser } from "../auth/session";
import { loadCaseForUser } from "../auth/access";
import { recordAudit } from "../audit";
import { AppError } from "../errors";

const contactSchema = z.object({
  victimEntityId: z.string().min(1, "Choose who you spoke to."),
  /** CALL: the officer called. CALL_IN: the victim called the station. */
  channel: z.enum(["CALL", "CALL_IN", "VISIT", "MESSAGE"]).default("CALL"),
  summary: z.string().trim().min(1, "Write what they were told before saving.").max(1000),
  followUp: z.string().trim().max(200).nullable().optional(),
  nextDueAt: z.string().trim().nullable().optional(),
});

/** Records a call, visit or message to a victim: what they were told, and when to call next. */
export async function logContact(db: Db, user: SessionUser, caseId: string, raw: z.input<typeof contactSchema>) {
  const parsed = contactSchema.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors = Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0]), i.message]));
    throw new AppError(parsed.error.issues[0]!.message, "VALIDATION", fieldErrors);
  }
  const v = parsed.data;
  const nextDueAt = v.nextDueAt ? istInputToUtc(v.nextDueAt) : null;
  if (v.nextDueAt && !nextDueAt) throw new AppError("Enter the next call as a date and time.", "VALIDATION", { nextDueAt: "Enter a date and time." });
  return db.$transaction(async (tx) => {
    await loadCaseForUser(tx, user, caseId, "write");
    const victim = await tx.entity.findFirst({ where: { id: v.victimEntityId, caseId } });
    if (!victim) throw new AppError("Choose a victim in this case.", "VALIDATION", { victimEntityId: "Choose a victim in this case." });
    const at = now();
    const log = await tx.contactLog.create({ data: { caseId, victimEntityId: victim.id, channel: v.channel, summary: v.summary, followUp: v.followUp ?? null, nextDueAt, at, byUserId: user.id } });
    await recordAudit(tx, {
      caseId,
      actorId: user.id,
      action: "contact.logged",
      objectType: "ContactLog",
      objectId: log.id,
      summary: `${v.channel === "CALL" ? "Call with" : v.channel === "CALL_IN" ? "Call from" : v.channel === "VISIT" ? "Visit to" : "Message to"} ${victim.label}: ${v.summary}`,
      detail: { nextDueAt: nextDueAt?.toISOString() ?? null, followUp: v.followUp ?? null },
    });
    return log;
  });
}

export async function listContacts(db: Db, user: SessionUser, caseId: string) {
  await loadCaseForUser(db, user, caseId, "read");
  const [logs, people, users] = await Promise.all([
    db.contactLog.findMany({ where: { caseId }, orderBy: { at: "desc" } }),
    db.entity.findMany({ where: { caseId, kind: "PERSON" }, select: { id: true, label: true } }),
    db.user.findMany({ select: { id: true, displayName: true, rank: true } }),
  ]);
  return logs.map((l) => ({
    id: l.id,
    victimEntityId: l.victimEntityId,
    victimLabel: people.find((p) => p.id === l.victimEntityId)?.label ?? "Victim",
    channel: l.channel,
    summary: l.summary,
    followUp: l.followUp,
    nextDueAt: l.nextDueAt,
    at: l.at,
    byUserId: l.byUserId,
    byName: users.find((u) => u.id === l.byUserId)?.displayName ?? null,
  }));
}
