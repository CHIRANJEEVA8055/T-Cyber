/**
 * Activity records are the append-only history of a case. Categories let officers filter by the part of the
 * investigation an event changed; access to records is kept apart from changes to them.
 */
export const ACTIVITY_CATEGORIES = {
  CASE: "Case and evidence",
  REQUESTS: "Requests and responses",
  FUNDS: "Funds",
  ACTIONS: "Next actions",
  INVESTIGATION: "People and identifiers",
  REPORTS: "Reports, reviews and corrections",
  ACCESS: "Access to records",
} as const;
export type ActivityCategory = keyof typeof ACTIVITY_CATEGORIES;

export function activityCategory(action: string): ActivityCategory {
  if (action === "evidence.accessed" || action === "report.exported" || action.startsWith("auth.") || action.startsWith("assistant.")) return "ACCESS";
  if (/^(case|evidence|extraction)\./.test(action)) return "CASE";
  if (/^(request|response)\./.test(action)) return "REQUESTS";
  if (action.startsWith("funds.")) return "FUNDS";
  if (action.startsWith("task.")) return "ACTIONS";
  if (/^(entity|relationship|location)\./.test(action)) return "INVESTIGATION";
  return "REPORTS";
}

/**
 * A case diary records the steps officers took. Automatic recommendations (no officer), who opened which
 * record, and report or review housekeeping are left out; officers' corrections are kept.
 */
export function isDiaryEvent(e: { action: string; actorId: string | null }): boolean {
  if (!e.actorId) return false;
  if (e.action === "activity.correction_recorded") return true;
  const category = activityCategory(e.action);
  return category !== "ACCESS" && category !== "REPORTS";
}
