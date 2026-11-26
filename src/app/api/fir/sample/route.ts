import { getCurrentUser } from "@/server/auth/current-user";
import { sampleFirPdf } from "@/server/seed/documents";
import { demoAnchor, makeTimeline } from "@/server/seed/timeline";

/** A synthetic FIR copy (FIR 421/2026) for trying the New FIR window. Clearly marked as synthetic inside. */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return new Response("Sign in first.", { status: 401 });
  const f = sampleFirPdf(makeTimeline(demoAnchor()));
  return new Response(new Uint8Array(f.buffer), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${f.fileName}"`, "Cache-Control": "no-store" } });
}
