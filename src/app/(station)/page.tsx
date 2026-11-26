import type { Metadata } from "next";
import { cookies } from "next/headers";
import { requireCaseWorker } from "@/server/auth/current-user";
import { getDb } from "@/server/db";
import { getDashboard, rangeBounds, type DayRange } from "@/server/services/dashboard";
import { getRepliesInbox } from "@/server/services/station-feed";
import { Dashboard, type DashTab } from "@/features/station/components/dashboard";
import { homeLabels } from "@/features/station/labels";
import { LANG_COOKIE } from "@/lib/preferences";

export const metadata: Metadata = { title: "Station dashboard" };

const TABS: DashTab[] = ["mine", "station", "action", "closed", "trends"];

export default async function HomePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireCaseWorker();
  const db = getDb();
  const [sp, store] = await Promise.all([searchParams, cookies()]);
  // Date filters chosen on the page (kept in the address so a reload keeps them); none means the usual periods.
  const one = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : "");
  const range = (f: string, t: string): DayRange | null => (rangeBounds({ from: one(f), to: one(t) }) ? { from: one(f), to: one(t) } : null);
  const ranges = { kpi: range("kfrom", "kto"), trends: range("tfrom", "tto") };
  const [data, inbox] = await Promise.all([getDashboard(db, user, undefined, ranges), getRepliesInbox(db, user)]);
  const lang = store.get(LANG_COOKIE)?.value === "te" ? "te" : "en";
  const tab = TABS.includes(sp.tab as DashTab) ? (sp.tab as DashTab) : "mine";
  const L = homeLabels(lang, {
    name: data.viewer.name,
    partOfDay: data.viewer.partOfDay as "morning" | "afternoon" | "evening",
    actionCases: data.counts.actionCases,
    actions: data.counts.action,
    own: data.counts.own,
    other: data.counts.other,
    overnight: inbox.overnight,
    mine: data.counts.mine,
    lost6Cases: data.kpi.lost6.cases,
    from: data.kpi.lost6.from,
    to: data.kpi.lost6.to,
    firs: data.kpi.firs,
    heldAccounts: data.kpi.held.accounts,
  });
  return <Dashboard data={data} inbox={inbox} L={L} lang={lang} ranges={ranges} initialTab={tab} openReplies={sp.replies === "1"} openFir={{ open: sp.newFir === "1" || typeof sp.ack === "string", ack: typeof sp.ack === "string" ? sp.ack : null }} />;
}
