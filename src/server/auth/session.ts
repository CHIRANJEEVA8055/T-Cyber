import crypto from "node:crypto";
import { getDb } from "../db";

export const SESSION_COOKIE = "tcyber_session";
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export interface SessionUser {
  id: string;
  username: string;
  displayName: string;
  rank: string;
  role: "OFFICER" | "SUPERVISOR" | "DEVELOPER";
  stationId: string;
  stationCode: string;
  stationName: string;
}

const hashToken = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

/** Creates a session row keyed by the SHA-256 of a random token. Only the raw token goes in the cookie. */
export async function createSessionRecord(userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await getDb().session.create({ data: { id: hashToken(token), userId, expiresAt } });
  return { token, expiresAt };
}

export async function findSessionUser(token: string | undefined | null): Promise<SessionUser | null> {
  if (!token) return null;
  const db = getDb();
  const session = await db.session.findUnique({
    where: { id: hashToken(token) },
    include: { user: { include: { station: true } } },
  });
  if (!session || session.expiresAt.getTime() < Date.now() || !session.user.active) return null;
  const u = session.user;
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    rank: u.rank,
    role: u.role === "SUPERVISOR" ? "SUPERVISOR" : u.role === "DEVELOPER" ? "DEVELOPER" : "OFFICER",
    stationId: u.stationId,
    stationCode: u.station.code,
    stationName: u.station.name,
  };
}

export async function deleteSessionRecord(token: string | undefined | null): Promise<void> {
  if (!token) return;
  await getDb().session.deleteMany({ where: { id: hashToken(token) } });
}
