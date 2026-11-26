import { getCurrentUser } from "@/server/auth/current-user";
import { isSameOrigin } from "@/server/auth/origin";
import { toActionError } from "@/server/errors";
import { manualFirCopy } from "@/server/services/fir-open";

/**
 * A printable copy of an FIR being typed in by hand, made from the details in the form. Nothing is stored and no
 * case is opened; the same copy is kept with the case when it opens.
 */
export async function POST(request: Request) {
  if (!isSameOrigin(request)) return Response.json({ ok: false, error: "Request rejected: it did not come from this application." }, { status: 403 });
  const user = await getCurrentUser();
  if (!user) return Response.json({ ok: false, error: "Your session has ended. Sign in again; nothing was lost from the form." }, { status: 401 });
  try {
    const body = (await request.json().catch(() => null)) as unknown;
    const r = await manualFirCopy(user, (body ?? {}) as Parameters<typeof manualFirCopy>[1]);
    return new Response(new Uint8Array(r.buffer), {
      headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${r.fileName}"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
    });
  } catch (err) {
    return Response.json(toActionError(err), { status: 400 });
  }
}
