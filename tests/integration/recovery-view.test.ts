import { beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@/server/db";
import { seedDemo } from "@/server/seed";
import { istInputToUtc } from "@/domain/time";
import type { SessionUser } from "@/server/auth/session";
import { getRecoveryView } from "@/server/services/recovery-view";
import { recordSplitDecision } from "@/server/services/allocation-decision";
import { confirmAllocation } from "@/server/services/funds";
import { logContact } from "@/server/services/contacts";

const db = getDb();
const at = istInputToUtc("2026-11-09T11:30")!;
let fir412 = "";

async function user(username: string): Promise<SessionUser> {
  const u = await db.user.findUniqueOrThrow({ where: { username }, include: { station: true } });
  return { id: u.id, username, displayName: u.displayName, rank: u.rank, role: u.role === "SUPERVISOR" ? "SUPERVISOR" : "OFFICER", stationId: u.stationId, stationCode: u.station.code, stationName: u.station.name };
}

beforeAll(async () => {
  fir412 = (await seedDemo(db, { anchor: "2026-11-09" })).fir412Id;
}, 240000);

describe("recovery ledger", () => {
  it("shows the position from bank records only", async () => {
    const v = await getRecoveryView(db, await user("officer1"), fir412, at);
    expect(v.measures).toMatchObject({ lost: { value: "₹1,00,000", sub: "by two victims" }, held: { value: "₹80,000", sub: "B ₹50,000 · C ₹30,000" }, cash: { value: "₹20,000", sub: "from B, being traced" }, returned: { value: "₹0", sub: "nothing yet" } });
    expect(v.alsoTracked).toBe("Also tracked: hold requested ₹1,00,000 · allocated to victims ₹0 · refund authorised ₹0 · all movements ₹2,20,000");
    expect(v.reconciliation).toBeNull();
  });

  it("lists every movement with the record it comes from, and names a disputed date", async () => {
    const v = await getRecoveryView(db, await user("officer1"), fir412, at);
    expect(v.rows.map((r) => [r.movement, r.amount, r.record])).toEqual([
      ["Victim 1 paid Account A", "₹60,000", "Bank A row 12"],
      ["Victim 2 paid Account A", "₹40,000", "FIR"],
      ["Account A → Account B, Bank B", "₹70,000", "Bank A row 18"],
      ["Account A → Account C, Bank C", "₹30,000", "Bank A row 19"],
      ["Cash withdrawn from Account B", "₹20,000", "Bank B reply"],
      ["Hold confirmed on Account B", "₹50,000", "Bank B"],
      ["Hold confirmed on Account C", "₹30,000", "Bank C"],
    ]);
    expect(v.rows[1]!.sub).toBe("UPI · 2 digits unreadable · Bank A dates it 03 Nov");
    expect(v.rows[4]!.sub).toBe("ATM · ATM ID not yet asked for");
  });

  it("says what each account did, and only calls sent requests 'asked for'", async () => {
    const v = await getRecoveryView(db, await user("officer1"), fir412, at);
    expect(v.accounts.map((a) => [a.name, a.sentence, a.pill.text])).toEqual([
      ["Account A XXXXXXXXXXXX4471", "Received both payments and sent everything on within 38 hours. Now restricted and empty. KYC still awaited.", "Empty"],
      ["Account B XXXXXXXXXXXX2093", "Got ₹70,000. ₹20,000 went out as cash before the hold. Statement, KYC and ATM ID drafted, not sent yet.", "Holds ₹50,000"],
      ["Account C XXXXXXXXXXXX7715", "Got ₹30,000. Nothing moved out. Fully held.", "Holds ₹30,000"],
    ]);
  });

  it("sets money aside for victims only from a recorded split, and lowers the loss only on a confirmed credit", async () => {
    const officer = await user("officer1");
    await recordSplitDecision(db, officer, fir412, { method: "FIRST_IN_FIRST_OUT", note: "Bank A's timestamps trace each transfer to its payment." });
    let v = await getRecoveryView(db, officer, fir412, at);
    expect(v.victims.map((x) => [x.name, x.allocated, x.credited, x.remaining])).toEqual([
      ["Victim 1", "₹40,000", "₹0", "₹60,000"],
      ["Victim 2", "₹40,000", "₹0", "₹40,000"],
    ]);
    expect(v.proposed.every((p) => p.status === "PROPOSED" && !p.canConfirm)).toBe(true);
    expect(v.refundPreview).toMatchObject({ victim: "Victim 1" });
    const sup = await user("supervisor");
    const supView = await getRecoveryView(db, sup, fir412, at);
    expect(supView.proposed.every((p) => p.canConfirm)).toBe(true);
    await confirmAllocation(db, sup, supView.proposed[0]!.id, { acknowledgeOverAllocation: false });
    v = await getRecoveryView(db, officer, fir412, at);
    expect(v.proposed.filter((p) => p.status === "CONFIRMED")).toHaveLength(1);
  });

  it("keeps the call log, newest first, with what each victim is waiting for", async () => {
    const officer = await user("officer1");
    const v0 = await getRecoveryView(db, officer, fir412, at);
    const v2 = v0.victimOptions.find((x) => x.name === "Victim 2")!;
    await logContact(db, officer, fir412, { victimEntityId: v2.id, channel: "CALL", summary: "Told that Bank C has confirmed ₹30,000 held", followUp: null, nextDueAt: null });
    const v = await getRecoveryView(db, officer, fir412, at);
    expect(v.calls[0]).toMatchObject({ who: "Victim 2", mine: true });
    expect(v.calls[0]!.text).toContain("told that Bank C has confirmed ₹30,000 held");
    expect(v.calls.find((c) => c.who === "Victim 1")!.pill).toEqual({ text: "Next call 12 Nov 2026", tone: "neutral" });
  });
});
