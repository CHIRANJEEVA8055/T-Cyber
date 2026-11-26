import { z } from "zod";
import { ACTIVITY_CATEGORIES, activityCategory, type ActivityCategory } from "@/domain/activity";
import { formatDateTimeIST } from "@/domain/time";
import { shortRank } from "@/lib/cn";
import type { Db } from "../db";
import type { SessionUser } from "../auth/session";
import { loadCaseForUser } from "../auth/access";
import { recordAudit } from "../audit";
import { AppError, notFoundError } from "../errors";

export interface ActivityFilters {
  category?: ActivityCategory;
  /** OFFICERS: entries with a named officer; SYSTEM: automatic entries such as next-action recommendations. */
  who?: "OFFICERS" | "SYSTEM";
  q?: string;
  limit?: number;
  /** Opaque cursor from a previous page. */
  cursor?: string;
}

const DEFAULT_PAGE = 50;

/** Where an entry's subject can be opened, when it has a page of its own. */
export function activityHref(caseId: string, objectType: string, objectId: string | null, entityKind?: string): string | null {
  if (!objectId) return null;
  const base = `/cases/${caseId}`;
  switch (objectType) {
    case "Case":
      return base;
    case "Request":
      return `${base}/requests/${objectId}`;
    case "Response":
      return `${base}/responses/${objectId}`;
    case "EvidenceItem":
      return `${base}/evidence/${objectId}`;
    case "Task":
      return `${base}/actions?task=${objectId}`;
    case "Hold":
    case "Allocation":
      return `${base}/funds/holds`;
    case "Refund":
      return `${base}/funds/returns`;
    case "Transaction":
    case "VictimClaim":
      return `${base}/funds`;
    case "Entity":
      return entityKind === "PERSON" || entityKind === "ORGANISATION" ? `${base}/people` : `${base}/people`;
    case "Relationship":
    case "LocationObservation":
      return `${base}/people`;
    case "Report":
      return `${base}/activity/reports/${objectId}`;
    case "AuditEvent":
      return `${base}/activity`;
    default:
      return null;
  }
}

function encodeCursor(at: Date, id: string) {
  return Buffer.from(`${at.toISOString()}|${id}`).toString("base64url");
}
function decodeCursor(cursor: string): { at: Date; id: string } | null {
  const [iso, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  const at = iso ? new Date(iso) : null;
  return at && !Number.isNaN(at.getTime()) && id ? { at, id } : null;
}

const PREFIXES: Record<ActivityCategory, (action: string) => boolean> = Object.fromEntries(
  (Object.keys(ACTIVITY_CATEGORIES) as ActivityCategory[]).map((c) => [c, (action: string) => activityCategory(action) === c]),
) as Record<ActivityCategory, (action: string) => boolean>;

/**
 * The append-only history of one case, newest first. Corrections are shown against the entry they correct;
 * nothing is ever edited or removed.
 */
export async function listActivity(db: Db, user: SessionUser, caseId: string, filters: ActivityFilters) {
  await loadCaseForUser(db, user, caseId, "read");
  const limit = Math.min(Math.max(filters.limit ?? DEFAULT_PAGE, 1), 200);
  const cursor = filters.cursor ? decodeCursor(filters.cursor) : null;
  const q = filters.q?.trim();

  // Category is derived from the action name, so it is applied after the query; the query narrows by actor,
  // text and cursor. Pages are filled until the limit is reached or the history ends.
  const events: Awaited<ReturnType<typeof db.auditEvent.findMany>> = [];
  let before = cursor;
  for (;;) {
    const batch = await db.auditEvent.findMany({
      where: {
        caseId,
        ...(filters.who === "SYSTEM" ? { actorId: null } : filters.who === "OFFICERS" ? { actorId: { not: null } } : {}),
        ...(q ? { summary: { contains: q } } : {}),
        ...(before ? { OR: [{ at: { lt: before.at } }, { at: before.at, id: { lt: before.id } }] } : {}),
      },
      orderBy: [{ at: "desc" }, { id: "desc" }],
      take: limit * 2,
    });
    for (const e of batch) {
      if (filters.category && !PREFIXES[filters.category](e.action)) continue;
      events.push(e);
      if (events.length > limit) break;
    }
    if (events.length > limit || batch.length < limit * 2) break;
    const last = batch.at(-1)!;
    before = { at: last.at, id: last.id };
  }
  const page = events.slice(0, limit);
  const hasMore = events.length > limit;

  const [users, corrections, corrected, entities] = await Promise.all([
    db.user.findMany({ select: { id: true, displayName: true, rank: true } }),
    db.auditEvent.findMany({ where: { caseId, correctsId: { in: page.map((e) => e.id) } }, orderBy: { at: "asc" } }),
    db.auditEvent.findMany({ where: { id: { in: page.map((e) => e.correctsId).filter((x): x is string => !!x) } } }),
    db.entity.findMany({ where: { caseId, id: { in: page.filter((e) => e.objectType === "Entity" && e.objectId).map((e) => e.objectId!) } }, select: { id: true, kind: true } }),
  ]);
  const nameOf = (id: string | null) => {
    const u = users.find((x) => x.id === id);
    return u ? `${shortRank(u.rank)} ${u.displayName}` : null;
  };

  return {
    events: page.map((e) => {
      const category = activityCategory(e.action);
      const original = e.correctsId ? corrected.find((c) => c.id === e.correctsId) : undefined;
      return {
        id: e.id,
        at: e.at.toISOString(),
        action: e.action,
        category,
        categoryLabel: ACTIVITY_CATEGORIES[category],
        summary: e.summary,
        actor: e.actorId ? { id: e.actorId, name: nameOf(e.actorId) ?? "Unknown user" } : null,
        objectType: e.objectType,
        href: activityHref(caseId, e.objectType, e.objectId, entities.find((x) => x.id === e.objectId)?.kind),
        corrects: original ? { id: original.id, at: original.at.toISOString(), summary: original.summary } : null,
        correctedBy: corrections.filter((c) => c.correctsId === e.id).map((c) => ({ id: c.id, at: c.at.toISOString(), summary: c.summary, actorName: nameOf(c.actorId) ?? "System" })),
      };
    }),
    nextCursor: hasMore ? encodeCursor(page.at(-1)!.at, page.at(-1)!.id) : null,
  };
}

export type ActivityPage = Awaited<ReturnType<typeof listActivity>>;
export type ActivityEntry = ActivityPage["events"][number];

const correctionSchema = z.object({
  text: z.string().trim().min(10, "Describe the correction in at least 10 characters.").max(1000, "Keep the correction under 1,000 characters."),
});

/**
 * Records a correction as a new entry that points at the original. The original entry is never changed;
 * both stay in the history.
 */
export async function recordCorrection(db: Db, user: SessionUser, caseId: string, eventId: string, input: { text: string }) {
  const parsed = correctionSchema.safeParse(input);
  if (!parsed.success) throw new AppError(parsed.error.issues[0]?.message ?? "Describe the correction.", "VALIDATION", { text: parsed.error.issues[0]?.message ?? "Describe the correction." });
  return db.$transaction(async (tx) => {
    await loadCaseForUser(tx, user, caseId, "write");
    const original = await tx.auditEvent.findUnique({ where: { id: eventId } });
    if (!original || original.caseId !== caseId) throw notFoundError("activity entry");
    return recordAudit(tx, {
      caseId,
      actorId: user.id,
      action: "activity.correction_recorded",
      objectType: "AuditEvent",
      objectId: original.id,
      correctsId: original.id,
      summary: `Correction to the entry of ${formatDateTimeIST(original.at)}: ${parsed.data.text}`,
      detail: { originalSummary: original.summary, text: parsed.data.text },
    });
  });
}
