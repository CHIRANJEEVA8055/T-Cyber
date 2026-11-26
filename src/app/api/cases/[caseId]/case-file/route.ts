import { getCurrentUser } from "@/server/auth/current-user";
import { getDb } from "@/server/db";
import { AppError } from "@/server/errors";
import { buildCaseFile } from "@/server/services/case-file";

/** Downloads the case file (originals with hashes, ledger, audit log) as one ZIP. Access is checked per request. */
export async function GET(_request: Request, { params }: { params: Promise<{ caseId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return new Response("Sign in to download the case file.", { status: 401 });
  const { caseId } = await params;
  try {
    const file = await buildCaseFile(getDb(), user, caseId);
    return new Response(new Uint8Array(file.buffer), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Length": String(file.buffer.length),
        "Content-Disposition": `attachment; filename="${file.fileName}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    if (err instanceof AppError && err.code === "NOT_FOUND") return new Response("This case does not exist or you do not have access to it.", { status: 404 });
    console.error("[t-cyber] case file export failed", err);
    return new Response("The case file could not be built. Nothing was changed; try again.", { status: 500 });
  }
}
