import { getCurrentUser } from "@/server/auth/current-user";
import { getDb } from "@/server/db";
import { AppError } from "@/server/errors";
import { readKnowledgeOriginal } from "@/server/services/knowledge-admin";

/** The uploaded original of a knowledge-base document, for the developer to check the sections against. */
export async function GET(_request: Request, { params }: { params: Promise<{ docId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return new Response("Sign in first.", { status: 401 });
  const { docId } = await params;
  try {
    const f = await readKnowledgeOriginal(getDb(), user, docId);
    return new Response(new Uint8Array(f.buffer), { headers: { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="${f.fileName.replace(/"/g, "")}"; filename*=UTF-8''${encodeURIComponent(f.fileName)}`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
  } catch (err) {
    if (err instanceof AppError) return new Response(err.message, { status: err.code === "FORBIDDEN" ? 403 : 404 });
    console.error("[t-cyber] knowledge original download failed", err);
    return new Response("The file could not be read. Try again.", { status: 500 });
  }
}
