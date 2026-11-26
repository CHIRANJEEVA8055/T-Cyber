import { getCurrentUser } from "@/server/auth/current-user";
import { getDb } from "@/server/db";
import { AppError } from "@/server/errors";
import { downloadLetter } from "@/server/services/letters";

const HEADERS = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const disposition = (name: string) => `attachment; filename="${name.replace(/"/g, "")}"; filename*=UTF-8''${encodeURIComponent(name)}`;

/** A request as a printable letter: format=pdf (the default) or format=docx. Only someone who can open the case. */
export async function GET(request: Request, { params }: { params: Promise<{ requestId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return new Response("Sign in to download the letter.", { status: 401 });
  const { requestId } = await params;
  const format = new URL(request.url).searchParams.get("format") === "docx" ? "docx" : "pdf";
  try {
    const f = await downloadLetter(getDb(), user, requestId, format);
    return new Response(new Uint8Array(f.buffer), { headers: { ...HEADERS, "Content-Type": f.contentType, "Content-Disposition": disposition(f.fileName) } });
  } catch (err) {
    if (err instanceof AppError && (err.code === "NOT_FOUND" || err.code === "FORBIDDEN")) return new Response("This request does not exist or is not in a case you can open.", { status: 404 });
    console.error("[t-cyber] letter download failed", err);
    return new Response("The letter could not be prepared. Try again.", { status: 500 });
  }
}
