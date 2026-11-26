"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "@/server/db";
import { verifyPassword } from "@/server/auth/password";
import { createSessionRecord, deleteSessionRecord, SESSION_COOKIE } from "@/server/auth/session";
import { recordAudit } from "@/server/audit";

export interface LoginState {
  error?: string;
  fieldErrors?: { username?: string; password?: string };
  username?: string;
}

function safeNext(value: FormDataEntryValue | null): string {
  const next = typeof value === "string" ? value : "";
  return next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/login") ? next : "/cases";
}

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const username = String(formData.get("username") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const fieldErrors: LoginState["fieldErrors"] = {};
  if (!username) fieldErrors.username = "Enter your username.";
  if (!password) fieldErrors.password = "Enter your password.";
  if (fieldErrors.username || fieldErrors.password) return { fieldErrors, username };

  const db = getDb();
  const user = await db.user.findUnique({ where: { username } });
  const ok = !!user && user.active && verifyPassword(password, user.passwordHash);
  if (!ok || !user) {
    return { error: "The username and password do not match an active account. Check both and try again.", username };
  }
  const { token, expiresAt } = await createSessionRecord(user.id);
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.COOKIE_SECURE === "true",
    path: "/",
    expires: expiresAt,
  });
  await db.$transaction((tx) => recordAudit(tx, { caseId: null, actorId: user.id, action: "auth.signed_in", objectType: "User", objectId: user.id, summary: `${user.displayName} signed in` }));
  redirect(safeNext(formData.get("next")));
}

export async function logoutAction() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  await deleteSessionRecord(token);
  store.delete(SESSION_COOKIE);
  redirect("/login");
}
