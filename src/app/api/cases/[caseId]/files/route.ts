import { getCurrentUser } from "@/server/auth/current-user";
import { isSameOrigin } from "@/server/auth/origin";
import { getDb } from "@/server/db";
import { AppError, toActionError } from "@/server/errors";
import { readCaseFile } from "@/server/services/case-files";

/**
 * "Add files" in the case window: one file per request (so each shows its own progress and a failure stops only that
 * file). It is kept with the case's evidence and read against the case; nothing is added until the officer chooses.
 */
export async function POST(request: Request, { params }: { params: Promise<{ caseId: string }> }) {
  if (!isSameOrigin(request)) return Response.json({ ok: false, error: "Request rejected: it did not come from this application." }, { status: 403 });
  const user = await getCurrentUser();
  if (!user) return Response.json({ ok: false, error: "Your session has ended. Sign in again; nothing was added." }, { status: 401 });
  const { caseId } = await params;
  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) throw new AppError("Choose a file that is not empty.", "VALIDATION", { file: "Choose a file." });
    const source = String(form.get("source") ?? "");
    const r = await readCaseFile(getDb(), user, caseId, { fileName: file.name, buffer: Buffer.from(await file.arrayBuffer()) }, { source });
    return Response.json({ ok: true, data: r });
  } catch (err) {
    const failure = toActionError(err);
    return Response.json(failure, { status: failure.code === "NOT_FOUND" ? 404 : failure.code === "FORBIDDEN" ? 403 : 400 });
  }
}
