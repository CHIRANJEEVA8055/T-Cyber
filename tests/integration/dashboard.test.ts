import { describe, expect, it, beforeAll } from "vitest";
import { getDb } from "@/server/db";
import { seedDemo } from "@/server/seed";
import { helloActions } from "@/features/station/labels";
import { getDashboard } from "@/server/services/dashboard";
import { getRepliesInbox, getNotifications, markNotificationsRead } from "@/server/services/station-feed";
import type { SessionUser } from "@/server/auth/session";
import { istInputToUtc } from "@/domain/time";

const db = getDb();
const at = istInputToUtc("2026-11-09T11:30")!;

async function user(username: string): Promise<SessionUser> {
  const u = await db.user.findUniqueOrThrow({ where: { username }, include: { station: true } });
  return { id: u.id, username, displayName: u.displayName, rank: u.rank, role: u.role === "SUPERVISOR" ? "SUPERVISOR" : "OFFICER", stationId: u.stationId, stationCode: u.station.code, stationName: u.station.name };
}

beforeAll(async () => {
  await seedDemo(db, { anchor: "2026-11-09" });
}, 240000);

describe("station dashboard", () => {
  it("counts SI Krishna's cases, the station's and the closed ones", async () => {
    const d = await getDashboard(db, await user("officer1"), at);
    expect(d.counts).toMatchObject({ mine: 12, station: 38, closed: 14 });
    expect(d.counts).not.toHaveProperty("awaiting");
    expect(d.viewer).toMatchObject({ name: "SI Krishna", partOfDay: "morning" });
  });

  it("shows where FIR 412/2026 stands from its records", async () => {
    const d = await getDashboard(db, await user("officer1"), at);
    const r = d.rows.find((x) => x.fir === "412/2026")!;
    expect(r).toMatchObject({ complainant: "Victim 1", extraVictims: 1, officer: "You", mine: true, canOpen: true, lostMinor: "10000000", heldMinor: "8000000", status: "action", type: "INVESTMENT" });
    expect(r.pill).toEqual({ text: "2 approvals waiting", tone: "wait" });
    expect(d.rows.find((x) => x.fir === "398/2026")!.pill).toEqual({ text: "Hold expires in 2 days", tone: "gap" });
    expect(d.rows.find((x) => x.fir === "370/2026")!.pill).toEqual({ text: "Restoration filed", tone: "ok" });
    expect(d.rows.find((x) => x.fir === "355/2026")!.pill).toEqual({ text: "₹1,20,000 returned", tone: "ok" });
    expect(d.rows.find((x) => x.fir === "391/2026")!.pill).toEqual({ text: "Waiting on 2 replies", tone: "neutral" });
  });

  it("lists what needs SI Krishna today, only from cases he can open", async () => {
    const d = await getDashboard(db, await user("officer1"), at);
    const by = (fir: string) => d.actions.filter((a) => a.fir === fir).map((a) => a.what);
    expect(by("412/2026")).toEqual(["Check and approve 2 requests", "Say which request a reply from Bank C answers", "Ask Bank A again for the KYC", "Decide how the ₹80,000 is split between the two victims"]);
    expect(d.actions.find((a) => a.what === "Check and approve 2 requests")!.why).toBe("R.REQ-412/2026-007 Bank B statement, R.REQ-412/2026-008 UNICROSS CDR. They are written and waiting for you. CCTV can only start after this.");
    expect(by("405/2026")).toEqual(["Decide how to return the ₹60,000 that is frozen"]);
    expect(by("391/2026")).toEqual(["Call the complainant back"]);
    expect(by("398/2026")).toEqual([]);
    expect(d.kpi.needAction).toBe(d.actions.length);
  });

  it("gives a supervisor their own cases' actions, and on other cases only what needs a supervisor", async () => {
    const d = await getDashboard(db, await user("supervisor"), at);
    expect(d.actions.filter((a) => a.fir === "412/2026")).toEqual([]);
    expect(d.actions.filter((a) => a.fir === "362/2026").map((a) => a.what)).toEqual(["Read and confirm the reply from Payment app", "NPCI has not answered R.REQ-362/2026-001 for 20 days"]);
    expect(d.actions.find((a) => a.fir === "377/2026" && a.what.startsWith("Confirm how"))).toMatchObject({ why: expect.stringContaining("proposed") });
    // "Your cases" are those in My cases; the actions on other officers' cases are counted apart, and the parts add up.
    const mine = new Set(d.rows.filter((r) => r.mine).map((r) => r.id));
    expect(d.counts.own).toEqual({ actions: d.actions.filter((a) => mine.has(a.caseId)).length, cases: new Set(d.actions.filter((a) => mine.has(a.caseId)).map((a) => a.caseId)).size });
    expect(d.counts.other.actions).toBeGreaterThan(0);
    expect(d.counts.own.actions + d.counts.other.actions).toBe(d.counts.action);
    expect(d.counts.own.cases).toBeLessThanOrEqual(d.counts.mine);
    expect(d.counts.own.cases + d.counts.other.cases).toBe(d.counts.actionCases);
    expect(helloActions({ actions: d.counts.action, mine: d.counts.mine, own: d.counts.own, other: d.counts.other })).toMatch(/^\d+ actions need you today: \d+ in (all )?\d+ of your( \d+)? cases, and \d+ in (another officer's case|\d+ other officers' cases)\.$/);
  });

  it("hides the complainant of a case the officer is not assigned to, and does not let him open it", async () => {
    const d = await getDashboard(db, await user("officer2"), at);
    const r = d.rows.find((x) => x.fir === "412/2026")!;
    expect(r).toMatchObject({ canOpen: false, complainant: null, officer: "SI Krishna" });
    expect(r.search).not.toContain("victim 1");
    expect(d.actions.some((a) => a.fir === "412/2026")).toBe(false);
  });

  it("counts the station's money from the records: held for victims, and lost over six months", async () => {
    const d = await getDashboard(db, await user("officer1"), at);
    const heldRows = await db.hold.aggregate({ where: { status: "CONFIRMED_HELD", confirmedAmountMinor: { gt: 0n }, case: { status: "OPEN" } }, _sum: { confirmedAmountMinor: true }, _count: true });
    expect(d.kpi.held.accounts).toBe(heldRows._count);
    expect(d.kpi.lost6).toMatchObject({ from: "June", to: "November" });
    // My FIRs: the officer's own FIRs (as in My cases), open and closed.
    const mineOpen = d.rows.filter((r) => r.mine).length;
    expect(d.kpi.firs.open).toBe(mineOpen);
    expect(d.kpi.firs.closed).toBe(d.closed.filter((r) => r.mine).length);
    // The trend lines share the periods: amount lost, put on hold (bank-confirmed holds), FIRs registered.
    expect(d.trends.months.poh.map((g) => g.label)).toEqual(d.trends.months.groups.map((g) => g.label));
    expect(d.trends.months.firs.map((g) => g.label)).toEqual(d.trends.months.groups.map((g) => g.label));
    const confirmed = await db.holdEvent.aggregate({ where: { type: "AMOUNT_CONFIRMED", amountMinor: { gt: 0n }, at: { gte: new Date("2026-06-01T00:00:00+05:30") } }, _sum: { amountMinor: true } });
    expect(d.trends.months.poh.reduce((s, g) => s + g.value, 0)).toBeGreaterThanOrEqual(Number((confirmed._sum.amountMinor ?? 0n) / 100n));
    expect(d.trends.months.firs.reduce((s, g) => s + g.value, 0)).toBe(d.trends.months.firTotal);
    for (const g of d.trends.months.firs) expect(g.rows).toHaveLength(g.value);
    // The drill lists sort dates and amounts by value, not as text.
    expect(d.trends.months.groups.flatMap((g) => g.rows).every((r) => typeof r.cs === "number" && typeof r.ds === "number")).toBe(true);
    const oct = d.trends.months.groups.find((g) => g.label === "October")!;
    expect(oct.value).toBeGreaterThanOrEqual(2460000);
  });

  it("drills into requests by status across the station's open cases", async () => {
    const d = await getDashboard(db, await user("officer1"), at);
    const groups = d.trends.requests.groups;
    expect(groups.map((g) => g.key)).toEqual(["rs_new", "rs_wait", "rs_rem", "rs_ans"]);
    expect(groups.reduce((s, g) => s + g.value, 0)).toBe(d.trends.requests.total);
    const r07 = groups[0]!.rows.find((r) => r.a === "R.REQ-412/2026-007" && r.sub === "FIR 412/2026")!;
    expect(r07).toMatchObject({ c: "Bank B · statement", href: expect.stringContaining("/requests") });
    const lavanyas = groups.flatMap((g) => g.rows).find((r) => r.sub === "FIR 398/2026")!;
    expect(lavanyas.href).toBeNull();
  });
});

describe("replies inbox and notifications", () => {
  it("groups replies by FIR: the Bank C reply to match, and unread mailbox messages ready to read in", async () => {
    const inbox = await getRepliesInbox(db, await user("officer1"), at);
    const g412 = inbox.groups.find((g) => g.fir === "412/2026")!;
    expect(g412.items.map((i) => [i.kind, i.needs.text])).toEqual(
      expect.arrayContaining([
        ["REPLY", "Pick the request"],
        ["UNREAD", "Read it in"],
      ]),
    );
    expect(g412.items.filter((i) => i.kind === "UNREAD")).toHaveLength(2);
    expect(inbox.groups.some((g) => g.fir === "398/2026")).toBe(false);
  });

  it("derives notifications for the officer's cases and remembers which were read", async () => {
    const krishna = await user("officer1");
    const n = await getNotifications(db, krishna, at);
    expect(n.items.map((x) => x.title)).toEqual(expect.arrayContaining(["A reply from Bank C covers 4 FIRs", "Profile “Anvi_K” is preserved"]));
    const key = n.items[0]!.key;
    await markNotificationsRead(db, krishna, [key, "not-mine"]);
    const after = await getNotifications(db, krishna, at);
    expect(after.unread).toBe(n.unread - 1);
    const lavanya = await getNotifications(db, await user("officer2"), at);
    expect(lavanya.items.map((x) => x.title)).toEqual(expect.arrayContaining(["Hold on Account XXXXXXXXXXXX3306 ends in 2 days"]));
  });
});
