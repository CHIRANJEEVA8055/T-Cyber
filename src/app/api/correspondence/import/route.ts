import { getCurrentUser } from "@/server/auth/current-user";
import { isSameOrigin } from "@/server/auth/origin";
import { getDb } from "@/server/db";
import { AppError, toActionError } from "@/server/errors";
import { importResponse } from "@/server/services/responses";
import { istInputToUtc } from "@/domain/time";
import { MAX_UPLOAD_BYTES } from "@/server/storage";
import { getAppConfig } from "@/server/config";
import { describeImportedReply } from "@/server/services/import-summary";

/**
 * Manual import into the simulated mailbox (multipart/form-data). The message is filed under a case
 * the officer can access; matching to a request is automatic, officer-chosen, or queued for review.
 */
export async function POST(request: Request) {
  if (!isSameOrigin(request)) return Response.json({ ok: false, error: "Request rejected: it did not come from this application." }, { status: 403 });
  const user = await getCurrentUser();
  if (!user) return Response.json({ ok: false, error: "Your session has ended. Sign in again; nothing was imported." }, { status: 401 });
  try {
    const form = await request.formData();
    const text = (k: string) => String(form.get(k) ?? "").trim();
    const fieldErrors: Record<string, string> = {};
    const caseId = text("caseId");
    const fromAddress = text("fromAddress");
    const subject = text("subject");
    const bodyText = String(form.get("bodyText") ?? "");
    const receivedAt = istInputToUtc(text("receivedAt"));
    if (!caseId) fieldErrors.caseId = "Choose the case this message belongs to.";
    if (!/^[^\s@]+@[^\s@]+$/.test(fromAddress)) fieldErrors.fromAddress = "Enter the sender's address, for example nodal@bank.example.invalid.";
    if (subject.length < 3) fieldErrors.subject = "Enter the message subject.";
    if (bodyText.trim().length < 5) fieldErrors.bodyText = "Paste the message text.";
    if (!receivedAt) fieldErrors.receivedAt = "Enter when the message was received (IST).";
    else if (receivedAt.getTime() > Date.now() + 5 * 60_000) fieldErrors.receivedAt = "The received time cannot be in the future.";
    const files = form.getAll("attachments").filter((f): f is File => f instanceof File && f.size > 0);
    if (files.length > 5) fieldErrors.attachments = "Attach at most 5 files per message.";
    for (const f of files) if (f.size > MAX_UPLOAD_BYTES) fieldErrors.attachments = `${f.name} is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`;
    if (Object.keys(fieldErrors).length) throw new AppError("Some fields need attention.", "VALIDATION", fieldErrors);

    const attachments = await Promise.all(files.map(async (f) => ({ fileName: f.name, buffer: Buffer.from(await f.arrayBuffer()) })));
    const result = await importResponse(
      getDb(),
      { fromAddress, toAddress: text("toAddress") || getAppConfig().mailbox.fromAddress, subject, receivedAt: receivedAt!, bodyText, channel: "MANUAL_IMPORT", attachments },
      { actorId: user.id, actor: user, caseId, requestIdHint: text("requestId") || null },
    );
    // The import window shows what was read in, as the inbox import does.
    const summary = await describeImportedReply(getDb(), result.responseId);
    return Response.json({ ok: true, data: { ...result, caseId, summary } });
  } catch (err) {
    const failure = toActionError(err);
    return Response.json(failure, { status: failure.code === "FORBIDDEN" || failure.code === "NOT_FOUND" ? 404 : 400 });
  }
}
