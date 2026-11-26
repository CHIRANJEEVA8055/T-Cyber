import { connection } from "next/server";
import { requireCaseWorker } from "@/server/auth/current-user";

/** Case windows are per request and per officer; access to each case is checked again in its own layout. */
export default async function CaseGroupLayout({ children }: { children: React.ReactNode }) {
  // better-sqlite3 is synchronous, so without this the build would query while prerendering.
  await connection();
  await requireCaseWorker();
  return children;
}
