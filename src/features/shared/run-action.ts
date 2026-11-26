import "server-only";
import { refresh } from "next/cache";
import { getCurrentUser } from "@/server/auth/current-user";
import { toActionError, type ActionResult } from "@/server/errors";
import type { SessionUser } from "@/server/auth/session";

/**
 * Wraps every server action: requires a valid session, converts errors to officer-facing messages
 * (never stack traces), and refreshes the client router so every view shows the updated records.
 */
export async function runAction<T>(fn: (user: SessionUser) => Promise<T>, opts: { refresh?: boolean } = {}): Promise<ActionResult<T>> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "Your session has ended. Sign in again to continue; nothing was changed.", code: "FORBIDDEN" };
  try {
    const data = await fn(user);
    if (opts.refresh !== false) refresh();
    return { ok: true, data };
  } catch (err) {
    return toActionError(err);
  }
}
