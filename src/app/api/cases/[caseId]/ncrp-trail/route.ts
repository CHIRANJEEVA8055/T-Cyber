import { getCurrentUser } from "@/server/auth/current-user";
import { isSameOrigin } from "@/server/auth/origin";
import { getDb } from "@/server/db";
import { AppError, toActionError } from "@/server/errors";
import { importNcrpTrail } from "@/server/services/ncrp-trail";

/** Adds an NCRP money-trail export to a case the officer may work on: kept as evidence, its records added. */
export async function POST(request: Request, { params }: { params: Promise<{ caseId: string }> }) {
  if (!isSameOrigin(request)) return Response.json({ ok: false, error: "Request rejected: it did not come from this application." }, { status: 403 });
  const user = await getCurrentUser();
  if (!user) return Response.json({ ok: false, error: "Your session has ended. Sign in again; nothing was added." }, { status: 401 });
  const { caseId } = await params;
  try {
    const file = (await request.formData()).get("file");
    if (!(file instanceof File) || file.size === 0) throw new AppError("Choose the NCRP export file.", "VALIDATION", { file: "Choose the file." });
    const r = await importNcrpTrail(getDb(), user, caseId, { fileName: file.name, buffer: Buffer.from(await file.arrayBuffer()) });
    return Response.json({ ok: true, data: r });
  } catch (err) {
    const failure = toActionError(err);
    return Response.json(failure, { status: failure.code === "NOT_FOUND" ? 404 : failure.code === "FORBIDDEN" ? 403 : 400 });
  }
}
