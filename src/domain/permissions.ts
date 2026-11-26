/**
 * Role and assignment rules. These are evaluated on the server for every read and mutation;
 * the UI may use them only to decide what to show.
 */

export type Role = "OFFICER" | "SUPERVISOR" | "DEVELOPER";

export interface Actor {
  id: string;
  role: Role | string;
  stationId: string;
}

export interface CaseAccessInfo {
  stationId: string;
  assignedUserIds: readonly string[];
}

/** Officers and supervisors work cases. The developer keeps the knowledge base and never opens a case. */
export function canWorkCases(actor: Pick<Actor, "role">): boolean {
  return actor.role === "OFFICER" || actor.role === "SUPERVISOR";
}

export function canReadCase(actor: Actor, c: CaseAccessInfo): boolean {
  if (!canWorkCases(actor)) return false;
  if (c.assignedUserIds.includes(actor.id)) return true;
  return actor.role === "SUPERVISOR" && actor.stationId === c.stationId;
}

/** Assigned officers and station supervisors may record work on a case. */
export function canWriteCase(actor: Actor, c: CaseAccessInfo): boolean {
  return canReadCase(actor, c);
}

export function canManageDirectory(actor: Actor): boolean {
  return actor.role === "SUPERVISOR";
}

export function canResetDemo(actor: Actor): boolean {
  return actor.role === "SUPERVISOR";
}

/** Only the developer adds, edits, publishes and retires knowledge-base documents and prompt templates. */
export function canManageKnowledge(actor: Pick<Actor, "role">): boolean {
  return actor.role === "DEVELOPER";
}

/** The developer's audit view: knowledge-base changes, assistant use and sign-ins (never case contents). */
export function canViewSystemAudit(actor: Pick<Actor, "role">): boolean {
  return actor.role === "DEVELOPER";
}
