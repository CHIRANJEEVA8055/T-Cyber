import { z } from "zod";
import { canManageKnowledge } from "@/domain/permissions";
import type { Db } from "../db";
import type { SessionUser } from "../auth/session";
import { recordAudit } from "../audit";
import { now } from "../clock";
import { AppError, notFoundError } from "../errors";

/**
 * The procedure assistant's ready questions ("saved prompts"). Officers see the active ones as suggestions; only the
 * developer adds, edits, orders, hides and deletes them, and each change is audited.
 */

const schema = z.object({
  title: z.string().trim().min(3, "Give the template a short title.").max(90, "Keep the title under 90 characters."),
  question: z.string().trim().min(8, "Write the question the officer will ask.").max(600, "Keep the question under 600 characters."),
  sourceLabel: z.string().trim().max(60, "Keep the source label under 60 characters.").default(""),
  active: z.boolean().default(true),
});

function assertDeveloper(user: SessionUser) {
  if (!canManageKnowledge(user)) throw new AppError("Only the developer account can change the ready questions.", "FORBIDDEN");
}

function parse(raw: unknown) {
  const r = schema.safeParse(raw);
  if (!r.success) {
    const fieldErrors: Record<string, string> = {};
    for (const i of r.error.issues) fieldErrors[String(i.path[0])] ??= i.message;
    throw new AppError("Check the marked fields.", "VALIDATION", fieldErrors);
  }
  return r.data;
}

export async function listPromptTemplates(db: Db, user: SessionUser, opts: { all?: boolean } = {}) {
  const all = opts.all && canManageKnowledge(user);
  const rows = await db.promptTemplate.findMany({ where: all ? {} : { active: true }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] });
  return rows.map((t) => ({ id: t.id, title: t.title, question: t.question, sourceLabel: t.sourceLabel, active: t.active, sortOrder: t.sortOrder }));
}
export type PromptTemplateView = Awaited<ReturnType<typeof listPromptTemplates>>[number];

export async function savePromptTemplate(db: Db, user: SessionUser, id: string | null, raw: unknown) {
  assertDeveloper(user);
  const v = parse(raw);
  return db.$transaction(async (tx) => {
    if (id) {
      const old = await tx.promptTemplate.findUnique({ where: { id } });
      if (!old) throw notFoundError("template");
      await tx.promptTemplate.update({ where: { id }, data: { ...v, updatedAt: now() } });
      await recordAudit(tx, { caseId: null, actorId: user.id, action: "prompt.updated", objectType: "PromptTemplate", objectId: id, summary: `Edited the ready question “${v.title}”${old.active !== v.active ? (v.active ? " and showed it" : " and hid it") : ""}` });
      return { id };
    }
    const last = await tx.promptTemplate.findFirst({ orderBy: { sortOrder: "desc" } });
    const t = await tx.promptTemplate.create({ data: { ...v, sortOrder: (last?.sortOrder ?? -1) + 1, createdById: user.id, createdAt: now(), updatedAt: now() } });
    await recordAudit(tx, { caseId: null, actorId: user.id, action: "prompt.created", objectType: "PromptTemplate", objectId: t.id, summary: `Added the ready question “${v.title}”` });
    return { id: t.id };
  });
}

export async function movePromptTemplate(db: Db, user: SessionUser, id: string, direction: "up" | "down") {
  assertDeveloper(user);
  await db.$transaction(async (tx) => {
    const rows = await tx.promptTemplate.findMany({ orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] });
    const i = rows.findIndex((r) => r.id === id);
    if (i < 0) throw notFoundError("template");
    const j = direction === "up" ? i - 1 : i + 1;
    if (j < 0 || j >= rows.length) return;
    [rows[i], rows[j]] = [rows[j]!, rows[i]!];
    for (const [k, r] of rows.entries()) if (r.sortOrder !== k) await tx.promptTemplate.update({ where: { id: r.id }, data: { sortOrder: k } });
    await recordAudit(tx, { caseId: null, actorId: user.id, action: "prompt.reordered", objectType: "PromptTemplate", objectId: id, summary: `Moved “${rows[j]!.title}” ${direction}` });
  });
}

export async function deletePromptTemplate(db: Db, user: SessionUser, id: string) {
  assertDeveloper(user);
  await db.$transaction(async (tx) => {
    const t = await tx.promptTemplate.findUnique({ where: { id } });
    if (!t) throw notFoundError("template");
    await tx.promptTemplate.delete({ where: { id } });
    await recordAudit(tx, { caseId: null, actorId: user.id, action: "prompt.deleted", objectType: "PromptTemplate", objectId: id, summary: `Deleted the ready question “${t.title}”` });
  });
}
