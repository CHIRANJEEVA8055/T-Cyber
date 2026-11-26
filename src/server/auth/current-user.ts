import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "../db";
import { ensureConfigApplied } from "../services/config-sync";
import { findSessionUser, SESSION_COOKIE, type SessionUser } from "./session";

/**
 * Resolves the signed-in officer for this request (memoised per request). It is the first data read of every
 * signed-in render, and layouts and pages render concurrently, so a pending configuration-file change is applied
 * here first: otherwise the first page after an edit could show the previous station or directory details.
 */
export const getCurrentUser = cache(async (): Promise<SessionUser | null> => {
  const store = await cookies();
  await ensureConfigApplied(getDb());
  return findSessionUser(store.get(SESSION_COOKIE)?.value);
});

/** For pages and layouts: redirects to the login page when there is no valid session. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

/** For station and case pages: the developer account has its own console and is sent there instead. */
export async function requireCaseWorker(): Promise<SessionUser> {
  const user = await requireUser();
  if (user.role === "DEVELOPER") redirect("/developer");
  return user;
}

/** For the developer console: anyone else is sent back to the station dashboard. */
export async function requireDeveloper(): Promise<SessionUser> {
  const user = await requireUser();
  if (user.role !== "DEVELOPER") redirect("/");
  return user;
}
