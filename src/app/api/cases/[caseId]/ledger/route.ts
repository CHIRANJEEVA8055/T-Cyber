import { getCurrentUser } from "@/server/auth/current-user";
import { getDb } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { getRecoveryView } from "@/server/services/recovery-view";
import { formatDateTimeIST } from "@/domain/time";

const csv = (rows: (string | number | null | undefined)[][]) => rows.map((r) => r.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n") + "\r\n";

/** The recovery ledger as CSV: position, every movement with its record, and each victim. Access checked per request. */
export async function GET(_request: Request, { params }: { params: Promise<{ caseId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return new Response("Sign in to export the ledger.", { status: 401 });
  const { caseId } = await params;
  try {
    const db = getDb();
    const v = await getRecoveryView(db, user, caseId);
    const kase = await db.case.findUniqueOrThrow({ where: { id: caseId } });
    const ref = kase.firNumber ? `FIR ${kase.firNumber}/${kase.firYear}` : (kase.complaintRef ?? caseId);
    const body = csv([
      [`Recovery ledger · ${ref}${kase.isDemo ? " · SYNTHETIC DEMONSTRATION DATA" : ""}`],
      [`Exported ${formatDateTimeIST(new Date())} by ${user.displayName}`],
      [],
      ["Amount lost", "Held in accounts", "Taken out as cash", "Returned to victims"],
      [v.measures.lost.value, v.measures.held.value, v.measures.cash.value, v.measures.returned.value],
      [v.alsoTracked],
      [],
      ["When (IST)", "Movement", "Detail", "Amount", "Record"],
      ...v.rows.map((r) => [r.when, r.movement, r.sub, r.amount, r.record]),
      [],
      ["Victim", "Amount lost", "Returned", "Set aside", "Still lost"],
      ...v.victims.map((x) => [x.name, x.lost, x.credited, x.allocated, x.remaining]),
    ]);
    await db.$transaction((tx) => recordAudit(tx, { caseId, actorId: user.id, action: "ledger.exported", objectType: "Case", objectId: caseId, summary: "Recovery ledger exported as CSV" }));
    return new Response(body, {
      headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${ref.replace(/[^\w]+/g, "_")}_ledger.csv"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
    });
  } catch (err) {
    if (err instanceof AppError && err.code === "NOT_FOUND") return new Response("This case does not exist or you do not have access to it.", { status: 404 });
    console.error("[t-cyber] ledger export failed", err);
    return new Response("The ledger could not be exported. Nothing was changed; try again.", { status: 500 });
  }
}
