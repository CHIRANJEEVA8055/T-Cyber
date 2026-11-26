import { connection } from "next/server";
import { requireUser } from "@/server/auth/current-user";
import { getDb } from "@/server/db";
import { getShellCounts } from "@/server/services/shell";
import { AppShell } from "@/components/app/app-shell";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // Everything here is per request. better-sqlite3 is synchronous, so without this the build would run the
  // queries below while prerendering.
  await connection();
  // requireUser applies any change to config/t-cyber.config.json before reading the officer and station.
  const user = await requireUser();
  const counts = await getShellCounts(getDb(), user);
  return (
    <AppShell
      user={{ displayName: user.displayName, rank: user.rank, role: user.role, stationName: user.stationName }}
      counts={counts}
    >
      {children}
    </AppShell>
  );
}
