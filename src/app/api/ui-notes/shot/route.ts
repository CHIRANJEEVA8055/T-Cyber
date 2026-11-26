import fs from "node:fs";
import { getCurrentUser } from "@/server/auth/current-user";
import { shotPath, uiNotesEnabled } from "@/server/ui-notes";

/** The picture of a commented block (development only, signed-in users only). */
export async function GET(request: Request) {
  if (!uiNotesEnabled()) return new Response("Not found.", { status: 404 });
  if (!(await getCurrentUser())) return new Response("Sign in first.", { status: 401 });
  const id = new URL(request.url).searchParams.get("id") ?? "";
  try {
    const png = fs.readFileSync(/*turbopackIgnore: true*/ shotPath(id));
    return new Response(new Uint8Array(png), { headers: { "Content-Type": "image/png", "Cache-Control": "private, no-store" } });
  } catch {
    return new Response("Not found.", { status: 404 });
  }
}
