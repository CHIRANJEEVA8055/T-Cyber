import { getCurrentUser } from "@/server/auth/current-user";
import { getDb } from "@/server/db";
import { AppError } from "@/server/errors";
import { exportReportPdf } from "@/server/services/reports";

/** Authorised PDF export of one report version. Access is checked on every request and each export is recorded. */
export async function GET(request: Request, { params }: { params: Promise<{ reportId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return new Response("Sign in to export reports.", { status: 401 });
  const { reportId } = await params;
  const versionNo = Number(new URL(request.url).searchParams.get("version"));
  if (!Number.isInteger(versionNo) || versionNo < 1) return new Response("Choose a report version to export.", { status: 400 });
  try {
    const file = await exportReportPdf(getDb(), user, reportId, versionNo);
    return new Response(new Uint8Array(file.bytes), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Length": String(file.bytes.length),
        "Content-Disposition": `attachment; filename="${file.filename.replace(/[^\w.\-]/g, "_")}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    if (err instanceof AppError && err.code === "NOT_FOUND") return new Response("This report does not exist or you do not have access to it.", { status: 404 });
    console.error("[t-cyber] report export failed", err);
    return new Response("The report could not be exported. Nothing was changed.", { status: 500 });
  }
}
