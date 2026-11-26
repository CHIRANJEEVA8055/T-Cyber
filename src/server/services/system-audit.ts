import type { Prisma } from "@/generated/prisma/client";
import { canViewSystemAudit } from "@/domain/permissions";
import { formatDateTimeIST } from "@/domain/time";
import type { Db } from "../db";
import type { SessionUser } from "../auth/session";
import { AppError } from "../errors";

/**
 * The developer's audit view: knowledge-base and ready-question changes, use of the procedure assistant, and
 * sign-ins. Events tied to a case show only which case and what kind of event, never the case's contents.
 */

export const AUDIT_KINDS = { ALL: "Everything", KNOWLEDGE: "Knowledge base", PROMPT: "Ready questions", ASSISTANT: "Assistant use", AUTH: "Sign-ins" } as const;
export type AuditKind = keyof typeof AUDIT_KINDS;

const PREFIX: Record<Exclude<AuditKind, "ALL">, string> = { KNOWLEDGE: "knowledge.", PROMPT: "prompt.", ASSISTANT: "assistant.", AUTH: "auth." };

export async function listSystemAudit(db: Db, user: SessionUser, opts: { kind?: string; q?: string; page?: number } = {}) {
  if (!canViewSystemAudit(user)) throw new AppError("Only the developer account can open the system audit log.", "FORBIDDEN");
  const kind = (Object.keys(AUDIT_KINDS) as AuditKind[]).includes(opts.kind as AuditKind) ? (opts.kind as AuditKind) : "ALL";
  const prefixes = kind === "ALL" ? Object.values(PREFIX) : [PREFIX[kind]];
  const where: Prisma.AuditEventWhereInput = { OR: prefixes.map((p) => ({ action: { startsWith: p } })) };
  const page = Math.max(1, Math.floor(opts.page ?? 1));
  const size = 50;
  const q = opts.q?.trim();
  // A search covers what the developer can see: the summary of events not tied to a case, and the action name.
  const search: Prisma.AuditEventWhereInput | null = q ? { OR: [{ AND: [{ caseId: null }, { summary: { contains: q } }] }, { action: { contains: q } }] } : null;
  const full: Prisma.AuditEventWhereInput = search ? { AND: [where, search] } : where;
  const [rows, total] = await Promise.all([db.auditEvent.findMany({ where: full, orderBy: { at: "desc" }, skip: (page - 1) * size, take: size, include: { case: { select: { firNumber: true, firYear: true } } } }), db.auditEvent.count({ where: full })]);
  const actors = await db.user.findMany({ where: { id: { in: rows.map((r) => r.actorId).filter((x): x is string => !!x) } }, select: { id: true, displayName: true, rank: true } });
  return {
    kind,
    q: q ?? "",
    page,
    pages: Math.max(1, Math.ceil(total / size)),
    total,
    rows: rows.map((r) => {
      const a = actors.find((x) => x.id === r.actorId);
      const fir = r.case ? `FIR ${r.case.firNumber}/${r.case.firYear}` : null;
      return {
        id: r.id,
        at: r.at.toISOString(),
        when: formatDateTimeIST(r.at),
        action: r.action,
        kind: (Object.entries(PREFIX).find(([, p]) => r.action.startsWith(p))?.[0] ?? "ALL") as AuditKind,
        who: a ? `${a.rank === "System developer" ? "" : `${a.rank} `}${a.displayName}`.trim() : r.actorId ? "An account removed by a demonstration reset" : "System",
        // Case events say only what happened and where; their wording can carry case details.
        summary: r.caseId ? `${r.action.replace(/^assistant\./, "Case assistant: ").replace(/_/g, " ")}${fir ? ` · ${fir}` : ""}` : r.summary,
        caseRef: fir,
      };
    }),
  };
}
export type SystemAuditView = Awaited<ReturnType<typeof listSystemAudit>>;
