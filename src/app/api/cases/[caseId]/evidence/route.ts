import { getCurrentUser } from "@/server/auth/current-user";
import { isSameOrigin } from "@/server/auth/origin";
import { getDb } from "@/server/db";
import { AppError, toActionError } from "@/server/errors";
import { uploadEvidence, EVIDENCE_CATEGORIES } from "@/server/services/evidence";
import { istInputToUtc } from "@/domain/time";

/** Authorised upload of an original document to a case. The original is stored outside the web root and hashed. */
export async function POST(request: Request, { params }: { params: Promise<{ caseId: string }> }) {
  if (!isSameOrigin(request)) return Response.json({ ok: false, error: "Request rejected: it did not come from this application." }, { status: 403 });
  const user = await getCurrentUser();
  if (!user) return Response.json({ ok: false, error: "Your session has ended. Sign in again; nothing was uploaded." }, { status: 401 });
  const { caseId } = await params;
  try {
    const form = await request.formData();
    const file = form.get("file");
    const text = (k: string) => String(form.get(k) ?? "").trim();
    const fieldErrors: Record<string, string> = {};
    if (!(file instanceof File) || file.size === 0) fieldErrors.file = "Choose the original file to upload.";
    const category = text("category");
    if (!(EVIDENCE_CATEGORIES as readonly string[]).includes(category)) fieldErrors.category = "Choose what kind of document this is.";
    const receivedAt = istInputToUtc(text("receivedAt"));
    if (!receivedAt) fieldErrors.receivedAt = "Enter when the document was received (IST).";
    if (text("sourceDescription").length < 3) fieldErrors.sourceDescription = "Say where the document came from.";
    if (Object.keys(fieldErrors).length) throw new AppError("Some fields need attention.", "VALIDATION", fieldErrors);
    const f = file as File;
    const item = await uploadEvidence(
      getDb(),
      user,
      caseId,
      { fileName: f.name, buffer: Buffer.from(await f.arrayBuffer()), title: text("title") || f.name, category, sourceDescription: text("sourceDescription"), receivedAt: receivedAt! },
      { runExtraction: form.get("runExtraction") === "on" || form.get("runExtraction") === "true" },
    );
    return Response.json({ ok: true, data: { evidenceId: item.id, processingStatus: item.processingStatus } });
  } catch (err) {
    const failure = toActionError(err);
    return Response.json(failure, { status: failure.code === "NOT_FOUND" ? 404 : 400 });
  }
}
