import { getCurrentUser } from "@/server/auth/current-user";
import { isSameOrigin } from "@/server/auth/origin";
import { AppError, toActionError } from "@/server/errors";
import { canWorkCases } from "@/domain/permissions";
import { describeTrail, readTrailFile } from "@/server/services/ncrp-trail";

/** Reads an NCRP money-trail export and says what it shows. Nothing is stored. */
export async function POST(request: Request) {
  if (!isSameOrigin(request)) return Response.json({ ok: false, error: "Request rejected: it did not come from this application." }, { status: 403 });
  const user = await getCurrentUser();
  if (!user) return Response.json({ ok: false, error: "Your session has ended. Sign in again; nothing was read." }, { status: 401 });
  try {
    if (!canWorkCases(user)) throw new AppError("Only officers and supervisors can read case files.", "FORBIDDEN");
    const file = (await request.formData()).get("file");
    if (!(file instanceof File) || file.size === 0) throw new AppError("Choose the NCRP export file.", "VALIDATION", { file: "Choose the file." });
    return Response.json({ ok: true, data: describeTrail(readTrailFile(file.name, Buffer.from(await file.arrayBuffer()))) });
  } catch (err) {
    const failure = toActionError(err);
    return Response.json(failure, { status: failure.code === "FORBIDDEN" ? 403 : 400 });
  }
}
