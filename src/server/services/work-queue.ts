import { shortRank } from "@/lib/cn";
import type { Db } from "../db";
import type { SessionUser } from "../auth/session";
import { caseAccessWhere } from "../auth/access";
import { caseReference } from "./cases";
import { sortTasks } from "./overview";

/**
 * What needs this officer's action across their cases: open next actions assigned to them or to nobody, and,
 * for supervisors, requests awaiting approval. The navigation count is computed from exactly the same sets.
 */
export async function getWorkQueue(db: Db, user: SessionUser) {
  const access = caseAccessWhere(user);
  const [tasks, approvals, users] = await Promise.all([
    db.task.findMany({ where: { case: access, status: "OPEN", OR: [{ assigneeId: user.id }, { assigneeId: null }] }, include: { case: true } }),
    user.role === "SUPERVISOR"
      ? db.request.findMany({ where: { case: access, status: "AWAITING_APPROVAL" }, include: { case: true, recipient: true, versions: { orderBy: { versionNo: "desc" }, take: 1 } }, orderBy: { updatedAt: "asc" } })
      : Promise.resolve([]),
    db.user.findMany({ select: { id: true, displayName: true, rank: true } }),
  ]);
  const name = (id: string | null) => {
    const u = users.find((x) => x.id === id);
    return u ? `${shortRank(u.rank)} ${u.displayName}` : null;
  };
  return {
    total: tasks.length + approvals.length,
    tasks: sortTasks(tasks).map((t) => ({
      id: t.id,
      caseId: t.caseId,
      caseReference: caseReference(t.case),
      caseTitle: t.case.title,
      title: t.title,
      question: t.question,
      kind: t.kind,
      objective: t.objective,
      priority: t.priority,
      assignedToMe: t.assigneeId === user.id,
      createdAt: t.createdAt.toISOString(),
      href: `/cases/${t.caseId}/actions?task=${t.id}`,
    })),
    approvals: approvals.map((r) => ({
      id: r.id,
      caseId: r.caseId,
      caseReference: caseReference(r.case),
      reference: r.reference,
      recipient: r.recipient.organisation,
      subject: r.versions[0]?.subject ?? "",
      preparedBy: name(r.versions[0]?.createdById ?? null),
      href: `/cases/${r.caseId}/requests/${r.id}`,
    })),
  };
}

export type WorkQueue = Awaited<ReturnType<typeof getWorkQueue>>;
