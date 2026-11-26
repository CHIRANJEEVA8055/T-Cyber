import { getCurrentUser } from "@/server/auth/current-user";
import { getDb } from "@/server/db";
import { AppError } from "@/server/errors";
import { getEvidenceForDownload } from "@/server/services/evidence";
import { readStoredFile } from "@/server/storage";
import { recordAudit } from "@/server/audit";

const INLINE = ["application/pdf", "text/plain", "text/csv", "message/rfc822", "image/png", "image/jpeg"];

/** Authorised retrieval of stored originals. Access is checked against the case on every request. */
export async function GET(request: Request, { params }: { params: Promise<{ evidenceId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return new Response("Sign in to view evidence.", { status: 401 });
  const { evidenceId } = await params;
  try {
    const db = getDb();
    const ev = await getEvidenceForDownload(db, user, evidenceId);
    const buffer = readStoredFile(ev.storageKey);
    const download = new URL(request.url).searchParams.get("download") === "1";
    const inline = !download && INLINE.includes(ev.mimeType);
    // Text formats are shown as plain text; nothing from a stored file can run in this origin.
    const contentType = ev.mimeType === "message/rfc822" || ev.mimeType === "text/csv" ? "text/plain; charset=utf-8" : ev.mimeType === "text/plain" ? "text/plain; charset=utf-8" : ev.mimeType;
    const safeName = ev.fileName.replace(/[^\w.\- ()]/g, "_");
    await db.$transaction((tx) => recordAudit(tx, { caseId: ev.caseId, actorId: user.id, action: "evidence.accessed", objectType: "EvidenceItem", objectId: ev.id, summary: `${download ? "Downloaded" : "Viewed"} original: ${ev.title}` }));
    return new Response(new Uint8Array(buffer), {
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(buffer.length),
        "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${safeName}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        ...(ev.mimeType === "application/pdf" ? {} : { "Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'" }),
      },
    });
  } catch (err) {
    if (err instanceof AppError && err.code === "NOT_FOUND") return new Response("This evidence item does not exist or you do not have access to it.", { status: 404 });
    console.error("[t-cyber] evidence download failed", err);
    return new Response("The file could not be read. Nothing was changed.", { status: 500 });
  }
}
