import type { Prisma } from "@/generated/prisma/client";
import { canReadCase, canWorkCases, canWriteCase } from "@/domain/permissions";
import type { Db, Tx } from "../db";
import { AppError, notFoundError } from "../errors";
import type { SessionUser } from "./session";

/**
 * Server-side case authorisation. Every case-scoped read and mutation must pass through
 * one of these helpers. Unauthorised cases are reported as "not found" so their existence
 * is not disclosed.
 */
export function caseAccessWhere(user: SessionUser): Prisma.CaseWhereInput {
  // The developer reads no case at all: an impossible id keeps every case list empty.
  if (!canWorkCases(user)) return { id: { in: [] } };
  if (user.role === "SUPERVISOR") {
    return { OR: [{ stationId: user.stationId }, { assignments: { some: { userId: user.id } } }] };
  }
  return { assignments: { some: { userId: user.id } } };
}

export async function loadCaseForUser(db: Db | Tx, user: SessionUser, caseId: string, mode: "read" | "write" = "read") {
  const c = await db.case.findUnique({
    where: { id: caseId },
    include: { assignments: true, station: true },
  });
  if (!c) throw notFoundError("case");
  const info = { stationId: c.stationId, assignedUserIds: c.assignments.map((a) => a.userId) };
  const allowed = mode === "read" ? canReadCase(user, info) : canWriteCase(user, info);
  if (!allowed) throw notFoundError("case");
  return c;
}

export async function accessibleCaseIds(db: Db | Tx, user: SessionUser): Promise<string[]> {
  const rows = await db.case.findMany({ where: caseAccessWhere(user), select: { id: true } });
  return rows.map((r) => r.id);
}

/** Station work (dashboard, inbox, registers, search, new FIRs) is for officers and supervisors only. */
export function assertCaseWorker(user: SessionUser): void {
  if (!canWorkCases(user)) throw new AppError("This account keeps the knowledge base and cannot open station or case records.", "FORBIDDEN");
}
