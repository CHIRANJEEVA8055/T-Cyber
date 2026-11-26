import { connection } from "next/server";
import { cookies } from "next/headers";
import { requireUser } from "@/server/auth/current-user";
import { getDb } from "@/server/db";
import { getAppConfig } from "@/server/config";
import { StationShell } from "@/features/station/components/station-shell";
import { LANG_COOKIE, THEME_COOKIE } from "@/lib/preferences";
import { shortRank } from "@/lib/cn";

export default async function StationLayout({ children }: { children: React.ReactNode }) {
  // Per request: better-sqlite3 is synchronous, so without this the build would query while prerendering.
  await connection();
  const user = await requireUser();
  const db = getDb();
  const [store, openCases] = await Promise.all([
    cookies(),
    user.role === "DEVELOPER" ? 0 : db.case.count({ where: { stationId: user.stationId, referenceType: "FIR", status: "OPEN" } }),
  ]);
  const name = `${shortRank(user.rank)} ${user.displayName}`;
  const initials = (user.rank === "Sub-Inspector" ? "S" : user.rank.charAt(0)) + user.displayName.replace(/^[A-Z]\.\s*/, "").charAt(0);
  return (
    <StationShell
      user={{ name: user.role === "DEVELOPER" ? user.displayName : name, initials: user.role === "DEVELOPER" ? "DV" : initials.toUpperCase(), roleLabel: user.role === "SUPERVISOR" ? "Station supervisor" : user.role === "DEVELOPER" ? "Developer console" : "Investigating officer", isSupervisor: user.role === "SUPERVISOR", isDeveloper: user.role === "DEVELOPER" }}
      station={{ name: user.stationName, district: getAppConfig().station.district }}
      openCases={openCases}
      lang={store.get(LANG_COOKIE)?.value === "te" ? "te" : "en"}
      theme={store.get(THEME_COOKIE)?.value === "light" ? "light" : "dark"}
    >
      {children}
    </StationShell>
  );
}
