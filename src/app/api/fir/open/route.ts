import { getCurrentUser } from "@/server/auth/current-user";
import { isSameOrigin } from "@/server/auth/origin";
import { getDb } from "@/server/db";
import { AppError, toActionError } from "@/server/errors";
import { openCaseFromFir } from "@/server/services/fir-open";

/** Opens a case from an FIR copy (re-read on the server). Returns the new case's id, or the reason it was refused. */
export async function POST(request: Request) {
  if (!isSameOrigin(request)) return Response.json({ ok: false, error: "Request rejected: it did not come from this application." }, { status: 403 });
  const user = await getCurrentUser();
  if (!user) return Response.json({ ok: false, error: "Your session has ended. Sign in again; nothing was created." }, { status: 401 });
  try {
    const form = await request.formData();
    const f = form.get("file");
    if (!(f instanceof File) || f.size === 0) throw new AppError("Choose the FIR copy first.", "VALIDATION");
    const ack = typeof form.get("ack") === "string" ? String(form.get("ack")) : null;
    const db = getDb();
    const { caseId } = await openCaseFromFir(db, user, { name: f.name, buffer: Buffer.from(await f.arrayBuffer()) }, { ack });
    return Response.json({ ok: true, data: { caseId } });
  } catch (err) {
    const failure = toActionError(err);
    // Point to the case that already has this FIR number, when that is why it was refused.
    const m = /FIR (\d+)\/(\d{4}) already exists/.exec(failure.error);
    if (m) {
      const existing = await getDb().case.findFirst({ where: { stationId: user.stationId, firNumber: Number(m[1]), firYear: Number(m[2]) }, include: { assignments: true } });
      const canOpen = existing && (existing.assignments.some((a) => a.userId === user.id) || user.role === "SUPERVISOR");
      return Response.json({ ...failure, existingCaseId: canOpen ? existing.id : null }, { status: 409 });
    }
    return Response.json(failure, { status: 400 });
  }
}
