import { getCurrentUser } from "@/server/auth/current-user";
import { isSameOrigin } from "@/server/auth/origin";
import { getDb } from "@/server/db";
import { AppError, toActionError } from "@/server/errors";
import { uploadKnowledgeDocument } from "@/server/services/knowledge-admin";

/** The developer uploads a document for the knowledge base; it is read, split into sections and kept as a draft. */
export async function POST(request: Request) {
  if (!isSameOrigin(request)) return Response.json({ ok: false, error: "Request rejected: it did not come from this application." }, { status: 403 });
  const user = await getCurrentUser();
  if (!user) return Response.json({ ok: false, error: "Your session has ended. Sign in again; nothing was uploaded." }, { status: 401 });
  try {
    const form = await request.formData();
    const f = form.get("file");
    if (!(f instanceof File) || f.size === 0) throw new AppError("Choose the document to upload.", "VALIDATION", { file: "Choose the document to upload." });
    const field = (k: string) => (typeof form.get(k) === "string" ? String(form.get(k)) : "");
    const meta = { title: field("title"), docNumber: field("docNumber"), issuingBody: field("issuingBody"), jurisdiction: field("jurisdiction"), version: field("version"), effectiveFrom: field("effectiveFrom"), category: field("category"), summary: field("summary"), reviewNote: field("reviewNote") };
    const r = await uploadKnowledgeDocument(getDb(), user, { fileName: f.name, buffer: Buffer.from(await f.arrayBuffer()), meta, replacesId: field("replacesId") || null });
    return Response.json({ ok: true, data: r });
  } catch (err) {
    const failure = toActionError(err);
    return Response.json(failure, { status: failure.code === "FORBIDDEN" ? 403 : 400 });
  }
}
