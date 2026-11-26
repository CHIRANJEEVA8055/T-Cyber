import { getCurrentUser } from "@/server/auth/current-user";
import { isSameOrigin } from "@/server/auth/origin";
import { getDb } from "@/server/db";
import { AppError, toActionError } from "@/server/errors";
import { uploadChatFile } from "@/server/services/procedure-assistant";

/** A file attached to a procedure question: read on this computer, kept private to the officer who attached it. */
export async function POST(request: Request) {
  if (!isSameOrigin(request)) return Response.json({ ok: false, error: "Request rejected: it did not come from this application." }, { status: 403 });
  const user = await getCurrentUser();
  if (!user) return Response.json({ ok: false, error: "Your session has ended. Sign in again; nothing was attached." }, { status: 401 });
  try {
    const form = await request.formData();
    const f = form.get("file");
    if (!(f instanceof File) || f.size === 0) throw new AppError("Choose a file to attach.", "VALIDATION");
    const attachment = await uploadChatFile(getDb(), user, { fileName: f.name, buffer: Buffer.from(await f.arrayBuffer()) });
    return Response.json({ ok: true, data: attachment });
  } catch (err) {
    return Response.json(toActionError(err), { status: 400 });
  }
}
