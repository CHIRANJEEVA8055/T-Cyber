import { getCurrentUser } from "@/server/auth/current-user";
import { isSameOrigin } from "@/server/auth/origin";
import { AppError, toActionError } from "@/server/errors";
import { readFirCopy } from "@/server/services/fir-reading";

/**
 * Reads an FIR copy for the New FIR window and streams each step as it finishes (NDJSON), then the result.
 * Works in memory: nothing is stored and no case is created until the officer opens it.
 */
export async function POST(request: Request) {
  if (!isSameOrigin(request)) return Response.json({ ok: false, error: "Request rejected: it did not come from this application." }, { status: 403 });
  const user = await getCurrentUser();
  if (!user) return Response.json({ ok: false, error: "Your session has ended. Sign in again; nothing was read." }, { status: 401 });
  let file: File;
  try {
    const form = await request.formData();
    const f = form.get("file");
    if (!(f instanceof File) || f.size === 0) throw new AppError("Choose the FIR copy to read.", "VALIDATION");
    file = f;
  } catch (err) {
    return Response.json(toActionError(err), { status: 400 });
  }
  const buffer = Buffer.from(await file.arrayBuffer());
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`));
      try {
        const result = await readFirCopy({ name: file.name, buffer }, (e) => send({ type: "step", ...e }));
        send({ type: "result", data: result });
      } catch (err) {
        send({ type: "error", ...toActionError(err) });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" } });
}
