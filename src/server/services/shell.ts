import type { Db } from "../db";
import type { SessionUser } from "../auth/session";
import { caseAccessWhere } from "../auth/access";

/** Counts shown beside navigation destinations. Computed only over cases the officer may access. */
export async function getShellCounts(db: Db, user: SessionUser) {
  const access = caseAccessWhere(user);
  const [openTasks, approvals, responses, unmatched] = await Promise.all([
    db.task.count({ where: { case: access, status: "OPEN", OR: [{ assigneeId: user.id }, { assigneeId: null }] } }),
    user.role === "SUPERVISOR" ? db.request.count({ where: { case: access, status: "AWAITING_APPROVAL" } }) : Promise.resolve(0),
    db.response.count({ where: { case: access, reviewStatus: { in: ["UNREVIEWED", "IN_REVIEW"] }, matchStatus: "MATCHED" } }),
    db.response.count({ where: { case: access, matchStatus: { in: ["NEEDS_MATCH_REVIEW", "UNMATCHED"] } } }),
  ]);
  return { workQueue: openTasks + approvals, correspondence: responses + unmatched };
}
