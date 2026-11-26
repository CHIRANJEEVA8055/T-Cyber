import { getCurrentUser } from "@/server/auth/current-user";
import { getDb } from "@/server/db";
import { AppError } from "@/server/errors";
import { requestEml } from "@/server/services/forwarding";

/**
 * The approved request as a ready-to-send email (.eml) addressed to the nodal officer, with its attachments: the IO
 * opens it in their mail program and sends it from their own mailbox (Outlook opens it as an unsent draft).
 */
export async function GET(_request: Request, { params }: { params: Promise<{ requestId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return new Response("Sign in to download the email.", { status: 401 });
  const { requestId } = await params;
  try {
    const f = await requestEml(getDb(), user, requestId);
    return new Response(new Uint8Array(f.buffer), { headers: { "Content-Type": "message/rfc822", "Content-Disposition": `attachment; filename="${f.fileName}"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
  } catch (err) {
    if (err instanceof AppError && (err.code === "NOT_FOUND" || err.code === "FORBIDDEN")) return new Response("This request does not exist or is not in a case you can open.", { status: 404 });
    if (err instanceof AppError && err.code === "PRECONDITION") return new Response(err.message, { status: 409 });
    console.error("[t-cyber] eml download failed", err);
    return new Response("The email could not be prepared. Try again.", { status: 500 });
  }
}
