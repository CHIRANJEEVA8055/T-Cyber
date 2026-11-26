import { getCurrentUser } from "@/server/auth/current-user";
import { getDb } from "@/server/db";
import { AppError } from "@/server/errors";
import { exportThread, exportThreadDocx } from "@/server/services/chats";

const HEADERS = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const disposition = (name: string) => `attachment; filename="${name.replace(/"/g, "")}"; filename*=UTF-8''${encodeURIComponent(name)}`;

/**
 * A conversation as a Word document (format=docx, the default) or plain text (format=txt), with each answer's
 * sources; message=<id> exports one answer with its question. Only the conversation's owner can export it.
 */
export async function GET(request: Request, { params }: { params: Promise<{ threadId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return new Response("Sign in to export a conversation.", { status: 401 });
  const { threadId } = await params;
  const url = new URL(request.url);
  const format = url.searchParams.get("format") === "txt" ? "txt" : "docx";
  const messageId = url.searchParams.get("message") ?? undefined;
  try {
    if (format === "txt") {
      const f = await exportThread(getDb(), user, threadId);
      return new Response(f.text, { headers: { ...HEADERS, "Content-Type": "text/plain; charset=utf-8", "Content-Disposition": disposition(f.fileName) } });
    }
    const f = await exportThreadDocx(getDb(), user, threadId, { messageId });
    return new Response(new Uint8Array(f.buffer), { headers: { ...HEADERS, "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "Content-Disposition": disposition(f.fileName) } });
  } catch (err) {
    if (err instanceof AppError && err.code === "NOT_FOUND") return new Response("This conversation does not exist or is not yours.", { status: 404 });
    console.error("[t-cyber] conversation export failed", err);
    return new Response("The conversation could not be exported. Try again.", { status: 500 });
  }
}
