import { describe, expect, it, beforeAll } from "vitest";
import { getDb } from "@/server/db";
import { seedDemo } from "@/server/seed";
import { getNextActions } from "@/server/services/next-actions";
import type { SessionUser } from "@/server/auth/session";

const db = getDb();
let fir412 = "";

async function user(username: string): Promise<SessionUser> {
  const u = await db.user.findUniqueOrThrow({ where: { username }, include: { station: true } });
  return { id: u.id, username, displayName: u.displayName, rank: u.rank, role: u.role === "SUPERVISOR" ? "SUPERVISOR" : "OFFICER", stationId: u.stationId, stationCode: u.station.code, stationName: u.station.name };
}

beforeAll(async () => {
  fir412 = (await seedDemo(db, { anchor: "2026-11-09" })).fir412Id;
}, 240000);

describe("next actions for FIR 412/2026", () => {
  it("ranks the drafts that unblock others first, then what waits on them, then the decision", async () => {
    const n = await getNextActions(db, await user("officer1"), fir412);
    const top = n.actions.slice(0, 4).map((a) => [a.rank, a.title, a.status.text]);
    expect(top).toEqual([
      [1, "Ask Bank B for Account B’s statement, KYC and ATM details", "Ready to send"],
      [2, "Ask UNICROSS for the CDR and CAF of mobile +91-XXXXXXXX41", "Ready to send"],
      [3, "Get the ATM CCTV footage from 05 Nov, Kukatpally", "Waits on 1"],
      [4, "Decide how the ₹80,000 is split between the two victims", "Your decision"],
    ]);
    expect(n.actions[2]!.blockedBy).toEqual({ rank: 1, title: "Ask Bank B for Account B’s statement, KYC and ATM details" });
    expect(n.actions[2]!.prerequisites).toEqual([
      expect.objectContaining({ label: "Cash withdrawal recorded", met: true, basis: "05 Nov, 21:14 · ₹20,000 cash withdrawn from Account B" }),
      expect.objectContaining({ label: "ATM ID known", met: false, dependsOnRank: 1 }),
    ]);
    expect(n.actions[3]!.route).toBe("Recovery · your decision · SOP 2026, §7.3");
  });

  it("carries each draft so it can be approved and sent from the list, by the officer, because the assistant wrote it", async () => {
    const n = await getNextActions(db, await user("officer1"), fir412);
    const r = n.actions[0]!.request!;
    expect(r).toMatchObject({ reference: "R.REQ-412/2026-007", status: "DRAFT", authoredByAssistant: true, canApproveAndSend: true });
    expect(r.recipient).toMatchObject({ org: "Bank B", verified: true });
    expect(r.items.map((i) => i.itemType)).toEqual(expect.arrayContaining(["STATEMENT", "KYC", "ATM_DETAILS"]));
    expect(n.actions[1]!.route).toBe("Identity · UNICROSS, Zonal ACP Madhapur · reply comes back through DD");
  });

  it("puts the drafted reminder and the reopened lead after the decision, and the deferred actions last with their reasons", async () => {
    const n = await getNextActions(db, await user("officer1"), fir412);
    expect(n.actions.slice(4, 6).map((a) => [a.kind, a.title, a.status.text])).toEqual([
      ["REMINDER", "Send the reminder to Bank A for H.REQ-412/2026-001", "Reminder ready"],
      ["LEAD", "Check whether P1 is the person named in FIR 377", "Needs evidence"],
    ]);
    expect(n.actions[5]!.why).toMatch(/^Reopened by you\. A matching name alone is not enough/);
    const deferred = n.actions.filter((a) => a.deferred);
    expect(deferred).toHaveLength(3);
    expect(deferred.every((a) => a.rank > 6 && a.deferredNote && a.status.text === "Deferred")).toBe(true);
    expect(n.counts).toEqual({ all: 9, ready: 3, waiting: 3, deferred: 3, open: 6 });
  });

  it("lists the leads set aside, with why, including the one reopened and where it now ranks", async () => {
    const n = await getNextActions(db, await user("officer1"), fir412);
    expect(n.setAside.map((s) => [s.title, s.label])).toEqual([
      ["Request the statement and KYC for Account A", "Duplicate"],
      ["Check whether P1 is the person named in FIR 377", "Reopened"],
      ["Complainant’s own number +91-XXXXXXXX19", "Closed"],
    ]);
    expect(n.setAside[1]).toMatchObject({ reason: "A matching name alone is not enough", rankNow: 6 });
  });

  it("refuses an officer who is not on the case", async () => {
    await expect(getNextActions(db, await user("officer2"), fir412)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
