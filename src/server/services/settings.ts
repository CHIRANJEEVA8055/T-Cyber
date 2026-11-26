import path from "node:path";
import { z } from "zod";
import { canManageDirectory, canResetDemo } from "@/domain/permissions";
import { shortRank } from "@/lib/cn";
import type { Db } from "../db";
import type { SessionUser } from "../auth/session";
import { recordAudit } from "../audit";
import { now } from "../clock";
import { getAppConfig, getConfigStatus } from "../config";
import { AppError, conflictError, notFoundError } from "../errors";
import { SIMULATED_CHANNELS } from "../adapters/submission";
import { resetDemo } from "../seed";
import { placeholdersFor, unknownPlaceholders } from "./templates";

const FAILURE_SIMULATION_KEYS: string[] = Object.values(SIMULATED_CHANNELS).map((c) => c.settingKey);
export const APPROVAL_ROLE_LABELS: Record<string, string> = {
  SUPERVISOR: "A supervisor",
  INVESTIGATING_OFFICER: "Any other officer (not the one who prepared it)",
};

function requireSupervisor(user: SessionUser) {
  if (!canManageDirectory(user)) throw new AppError("Only a supervisor can change station settings.", "FORBIDDEN");
}

function fieldError(issues: z.core.$ZodIssue[]): AppError {
  const fieldErrors = Object.fromEntries(issues.map((i) => [String(i.path[0] ?? "form"), i.message]));
  return new AppError(issues[0]?.message ?? "Check the highlighted fields.", "VALIDATION", fieldErrors);
}

async function nameMap(db: Db) {
  const users = await db.user.findMany({ select: { id: true, displayName: true, rank: true } });
  return (id: string | null) => {
    const u = users.find((x) => x.id === id);
    return u ? `${shortRank(u.rank)} ${u.displayName}` : null;
  };
}

// ---------------------------------------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------------------------------------

export async function getSettingsOverview(db: Db, user: SessionUser) {
  const status = getConfigStatus();
  const cfg = getAppConfig();
  const [recipients, unverified, routes, templates, documents, history, name] = await Promise.all([
    db.recipient.count({ where: { active: true } }),
    db.recipient.count({ where: { active: true, verificationStatus: { not: "VERIFIED" } } }),
    db.routingRule.count({ where: { active: true } }),
    db.template.count({ where: { active: true } }),
    db.knowledgeDocument.count(),
    db.auditEvent.findMany({
      where: { caseId: null, OR: ["directory.", "routing.", "template.", "integration.", "config."].map((p) => ({ action: { startsWith: p } })) },
      orderBy: { at: "desc" },
      take: 12,
    }),
    nameMap(db),
  ]);
  return {
    canManage: canManageDirectory(user),
    config: { file: path.relative(process.cwd(), status.file) || status.file, ok: status.ok, error: status.error, lastValidChangeAt: status.lastValidChangeAt },
    station: cfg.station,
    mailbox: cfg.mailbox,
    requests: cfg.requests,
    counts: { recipients, unverified, routes, templates, documents },
    history: history.map((h) => ({ id: h.id, at: h.at.toISOString(), summary: h.summary, actor: name(h.actorId) ?? "Configuration file" })),
  };
}

// ---------------------------------------------------------------------------------------------------------
// Recipient directory
// ---------------------------------------------------------------------------------------------------------

export async function listDirectory(db: Db, _user: SessionUser) {
  const [rows, name] = await Promise.all([
    // The stand-in for a draft's not-yet-known addressee is not a directory entry anyone can edit or send to.
    db.recipient.findMany({ where: { organisationType: { notIn: ["UNADDRESSED", "MANUAL", "TYPED"] } }, include: { routes: { select: { id: true } } }, orderBy: [{ active: "desc" }, { organisationType: "asc" }, { organisation: "asc" }] }),
    nameMap(db),
  ]);
  return rows.map((r) => ({
    id: r.id,
    configKey: r.configKey,
    name: r.name,
    organisation: r.organisation,
    organisationType: r.organisationType,
    channel: r.channel,
    address: r.address,
    ifscPrefix: r.ifscPrefix,
    categories: JSON.parse(r.categoriesJson) as string[],
    verificationStatus: r.verificationStatus,
    verificationNote: r.verificationNote,
    verifiedAt: r.verifiedAt?.toISOString() ?? null,
    verifiedBy: name(r.verifiedById),
    notes: r.notes,
    active: r.active,
    routeCount: r.routes.length,
  }));
}

export type DirectoryEntryView = Awaited<ReturnType<typeof listDirectory>>[number];

const verificationSchema = z.object({
  verified: z.boolean(),
  note: z.string().trim().min(10, "Say how the address was checked, in at least 10 characters.").max(300, "Keep the note under 300 characters."),
});

/** Verification is an operational check held in the database; an address change in the file resets it. */
export async function setRecipientVerification(db: Db, user: SessionUser, recipientId: string, input: z.input<typeof verificationSchema>) {
  requireSupervisor(user);
  const parsed = verificationSchema.safeParse(input);
  if (!parsed.success) throw fieldError(parsed.error.issues);
  const { verified, note } = parsed.data;
  return db.$transaction(async (tx) => {
    const r = await tx.recipient.findUnique({ where: { id: recipientId } });
    if (!r) throw notFoundError("recipient");
    if (!r.active) throw new AppError("This recipient was removed from the configuration file and cannot be verified.", "PRECONDITION");
    const at = now();
    await tx.recipient.update({
      where: { id: r.id },
      data: verified ? { verificationStatus: "VERIFIED", verifiedById: user.id, verifiedAt: at, verificationNote: note } : { verificationStatus: "UNVERIFIED", verifiedById: null, verifiedAt: null, verificationNote: note },
    });
    await recordAudit(tx, {
      caseId: null,
      actorId: user.id,
      action: "directory.verification_changed",
      objectType: "Recipient",
      objectId: r.id,
      summary: `${r.name} marked as ${verified ? "verified" : "not verified"}: ${note}`,
      detail: { from: r.verificationStatus, to: verified ? "VERIFIED" : "UNVERIFIED", address: r.address },
    });
  });
}

// ---------------------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------------------

export async function listRoutes(db: Db, _user: SessionUser) {
  const rows = await db.routingRule.findMany({ include: { recipient: true, template: true }, orderBy: [{ subjectKind: "asc" }, { category: "asc" }, { name: "asc" }] });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    subjectKind: r.subjectKind,
    category: r.category,
    resolveBy: r.resolveBy,
    recipientLabel:
      r.resolveBy === "ACCOUNT_BANK"
        ? "The bank named on the account"
        : r.resolveBy === "LINKED_ACCOUNT_BANK"
          ? "The bank of the account it is linked to"
          : r.recipient
            ? r.recipient.name
            : "Not set",
    channel: r.recipient?.channel ?? null,
    templateName: r.template?.name ?? null,
    approvalRole: r.approvalRole,
    followUpDays: r.followUpDays,
    procedureNote: r.procedureNote,
    active: r.active,
    updatedAt: r.updatedAt.toISOString(),
  }));
}

export type RouteView = Awaited<ReturnType<typeof listRoutes>>[number];

const routeSchema = z.object({
  approvalRole: z.enum(["SUPERVISOR", "INVESTIGATING_OFFICER"], { message: "Choose who approves requests on this route." }),
  followUpDays: z.number({ message: "Enter a number of days." }).int("Enter a whole number of days.").min(1, "Enter at least 1 day.").max(60, "Enter at most 60 days."),
  procedureNote: z.string().trim().min(10, "Describe the procedure in at least 10 characters.").max(500, "Keep the note under 500 characters."),
  expectedUpdatedAt: z.string(),
});

/** Approval role and follow-up period are read when requests are approved and submitted, so changes take effect. */
export async function updateRoute(db: Db, user: SessionUser, routeId: string, input: { approvalRole: string; followUpDays: number; procedureNote: string; expectedUpdatedAt: string }) {
  requireSupervisor(user);
  const parsed = routeSchema.safeParse(input);
  if (!parsed.success) throw fieldError(parsed.error.issues);
  const { approvalRole, followUpDays, procedureNote, expectedUpdatedAt } = parsed.data;
  return db.$transaction(async (tx) => {
    const r = await tx.routingRule.findUnique({ where: { id: routeId } });
    if (!r) throw notFoundError("route");
    if (r.updatedAt.toISOString() !== expectedUpdatedAt) throw conflictError("This route was changed by someone else. Reload the page to see the current values.");
    await tx.routingRule.update({ where: { id: r.id }, data: { approvalRole, followUpDays, procedureNote } });
    const changes = [
      r.followUpDays !== followUpDays ? `follow-up ${r.followUpDays} → ${followUpDays} days` : null,
      r.approvalRole !== approvalRole ? `approval by ${APPROVAL_ROLE_LABELS[r.approvalRole]?.toLowerCase()} → ${APPROVAL_ROLE_LABELS[approvalRole]?.toLowerCase()}` : null,
      r.procedureNote !== procedureNote ? "procedure note edited" : null,
    ].filter(Boolean);
    await recordAudit(tx, {
      caseId: null,
      actorId: user.id,
      action: "routing.updated",
      objectType: "RoutingRule",
      objectId: r.id,
      summary: `Route “${r.name}” updated: ${changes.join("; ") || "no change"}`,
      detail: { before: { approvalRole: r.approvalRole, followUpDays: r.followUpDays, procedureNote: r.procedureNote }, after: { approvalRole, followUpDays, procedureNote } },
    });
  });
}

// ---------------------------------------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------------------------------------

export async function listTemplates(db: Db, _user: SessionUser) {
  const rows = await db.template.findMany({ include: { routes: { select: { name: true } } }, orderBy: { name: "asc" } });
  return rows.map((t) => ({
    id: t.id,
    name: t.name,
    category: t.category,
    subjectTemplate: t.subjectTemplate,
    bodyTemplate: t.bodyTemplate,
    version: t.version,
    active: t.active,
    updatedAt: t.updatedAt.toISOString(),
    routes: t.routes.map((r) => r.name),
    placeholders: placeholdersFor(t.category),
  }));
}

export type TemplateView = Awaited<ReturnType<typeof listTemplates>>[number];

const templateSchema = z.object({
  subjectTemplate: z.string().trim().min(5, "Enter a subject of at least 5 characters.").max(200, "Keep the subject under 200 characters."),
  bodyTemplate: z.string().trim().min(20, "Enter a body of at least 20 characters.").max(10_000, "Keep the body under 10,000 characters."),
  expectedVersion: z.number().int().positive(),
});

/** Template edits apply to drafts prepared afterwards; existing drafts keep their text. */
export async function updateTemplate(db: Db, user: SessionUser, templateId: string, input: z.input<typeof templateSchema>) {
  requireSupervisor(user);
  const parsed = templateSchema.safeParse(input);
  if (!parsed.success) throw fieldError(parsed.error.issues);
  const { subjectTemplate, bodyTemplate, expectedVersion } = parsed.data;
  return db.$transaction(async (tx) => {
    const t = await tx.template.findUnique({ where: { id: templateId } });
    if (!t) throw notFoundError("template");
    const allowed = placeholdersFor(t.category);
    const unknownSubject = unknownPlaceholders(subjectTemplate, allowed);
    const unknownBody = unknownPlaceholders(bodyTemplate, allowed);
    if (unknownSubject.length || unknownBody.length) {
      const list = (keys: string[]) => keys.map((k) => `{{${k}}}`).join(", ");
      throw new AppError("The template uses placeholders that drafting cannot fill.", "VALIDATION", {
        ...(unknownSubject.length ? { subjectTemplate: `Not available for this template: ${list(unknownSubject)}.` } : {}),
        ...(unknownBody.length ? { bodyTemplate: `Not available for this template: ${list(unknownBody)}.` } : {}),
      });
    }
    const claimed = await tx.template.updateMany({ where: { id: t.id, version: expectedVersion }, data: { subjectTemplate, bodyTemplate, version: { increment: 1 } } });
    if (claimed.count !== 1) throw conflictError("This template was changed by someone else. Reload the page to see the current version.");
    await recordAudit(tx, {
      caseId: null,
      actorId: user.id,
      action: "template.updated",
      objectType: "Template",
      objectId: t.id,
      summary: `Template “${t.name}” updated to version ${t.version + 1}`,
      detail: { before: { subjectTemplate: t.subjectTemplate, bodyTemplate: t.bodyTemplate }, after: { subjectTemplate, bodyTemplate } },
    });
  });
}

// ---------------------------------------------------------------------------------------------------------
// Integrations
// ---------------------------------------------------------------------------------------------------------

export async function listIntegrations(db: Db, _user: SessionUser) {
  const [rows, name] = await Promise.all([db.integrationSetting.findMany({ orderBy: { key: "asc" } }), nameMap(db)]);
  return rows.map((r) => ({
    key: r.key,
    label: r.label,
    mode: r.mode,
    note: r.note,
    failNextSubmission: r.failNextSubmission,
    supportsFailureSimulation: FAILURE_SIMULATION_KEYS.includes(r.key),
    updatedAt: r.updatedAt.toISOString(),
    updatedBy: name(r.updatedById),
  }));
}

export type IntegrationView = Awaited<ReturnType<typeof listIntegrations>>[number];

/** Makes the next simulated submission on a route fail once, to rehearse the retry path. */
export async function setFailureSimulation(db: Db, user: SessionUser, key: string, enabled: boolean) {
  requireSupervisor(user);
  if (!FAILURE_SIMULATION_KEYS.includes(key)) throw new AppError("Failure simulation applies only to simulated submission routes.", "VALIDATION");
  return db.$transaction(async (tx) => {
    const s = await tx.integrationSetting.findUnique({ where: { key } });
    if (!s) throw notFoundError("integration");
    await tx.integrationSetting.update({ where: { key }, data: { failNextSubmission: enabled, updatedById: user.id } });
    await recordAudit(tx, {
      caseId: null,
      actorId: user.id,
      action: "integration.failure_simulation_set",
      objectType: "IntegrationSetting",
      objectId: key,
      summary: enabled ? `${s.label}: the next simulated submission will fail once` : `${s.label}: failure simulation cleared`,
    });
  });
}

// ---------------------------------------------------------------------------------------------------------
// Demonstration data
// ---------------------------------------------------------------------------------------------------------

/** Wipes everything and reseeds the synthetic demonstration. Everyone is signed out, including the supervisor. */
export async function resetDemoData(db: Db, user: SessionUser, input: { confirmation: string }) {
  if (!canResetDemo(user)) throw new AppError("Only a supervisor can reset the demonstration data.", "FORBIDDEN");
  if (input.confirmation !== "RESET") throw new AppError("Type RESET in capital letters to confirm.", "VALIDATION", { confirmation: "Type RESET in capital letters to confirm." });
  await resetDemo(db, user.id);
}
