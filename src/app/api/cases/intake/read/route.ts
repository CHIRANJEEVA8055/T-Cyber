import { getCurrentUser } from "@/server/auth/current-user";
import { isSameOrigin } from "@/server/auth/origin";
import { AppError, toActionError } from "@/server/errors";
import { validateUpload } from "@/server/storage";
import { parseDocument } from "@/server/documents/parse";
import { extractFromLines, type SourceLine } from "@/domain/extraction";
import { proposeCaseFromFir } from "@/domain/extraction/fir-intake";

/**
 * Reads an FIR copy to fill the New FIR form. Works in memory: nothing is stored and no case is
 * created. The officer creates the case afterwards, and the same file is then kept as evidence.
 */
export async function POST(request: Request) {
  if (!isSameOrigin(request)) return Response.json({ ok: false, error: "Request rejected: it did not come from this application." }, { status: 403 });
  const user = await getCurrentUser();
  if (!user) return Response.json({ ok: false, error: "Your session has ended. Sign in again; nothing was read." }, { status: 401 });
  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) throw new AppError("Choose the FIR copy to read.", "VALIDATION", { file: "Choose the FIR copy (PDF or text file)." });
    const buffer = Buffer.from(await file.arrayBuffer());
    const { mimeType } = validateUpload(file.name, buffer);
    if (mimeType !== "application/pdf" && mimeType !== "text/plain") {
      throw new AppError("Only PDF and text copies of an FIR can be read. Enter the details by hand; the file can still be attached.", "VALIDATION", { file: "Choose a PDF or text copy to read." });
    }
    const parsed = await parseDocument(buffer, mimeType);
    if (parsed.status !== "TEXT_EXTRACTED") {
      return Response.json({ ok: true, data: { readable: false, note: parsed.note ?? "No text could be read from this copy.", pageCount: parsed.pageCount, proposal: null } });
    }
    const lines: SourceLine[] = parsed.segments.map((s) => ({ page: s.page, line: s.line, row: s.row, text: s.text }));
    const proposal = proposeCaseFromFir(lines, extractFromLines(lines));
    return Response.json({ ok: true, data: { readable: true, note: null, pageCount: parsed.pageCount, proposal } });
  } catch (err) {
    const failure = toActionError(err);
    return Response.json(failure, { status: 400 });
  }
}
