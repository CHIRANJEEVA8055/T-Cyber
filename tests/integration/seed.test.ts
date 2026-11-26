import { describe, expect, it, beforeAll } from "vitest";
import { getDb } from "@/server/db";
import { seedDemo } from "@/server/seed";
import { getLedgerView } from "@/server/services/funds";
import type { SessionUser } from "@/server/auth/session";
import { istInputToUtc } from "@/domain/time";

const L = (r: number) => (BigInt(r) * 100n).toString();
const db = getDb();
let ids: Awaited<ReturnType<typeof seedDemo>>;

async function user(username: string): Promise<SessionUser> {
  const u = await db.user.findUniqueOrThrow({ where: { username }, include: { station: true } });
  return { id: u.id, username, displayName: u.displayName, rank: u.rank, role: u.role === "SUPERVISOR" ? "SUPERVISOR" : "OFFICER", stationId: u.stationId, stationCode: u.station.code, stationName: u.station.name };
}

const requests = () => db.request.findMany({ where: { caseId: ids.fir412Id }, include: { recipient: true, items: { orderBy: { sortOrder: "asc" } }, versions: true }, orderBy: [{ caseSeq: "asc" }] });

beforeAll(async () => {
  ids = await seedDemo(db, { anchor: "2026-11-09" });
}, 240000);

describe("demo seed: FIR 412/2026, the worked example", () => {
  it("holds ₹80,000 of the ₹1,00,000 lost, in Accounts B and C; nothing is returned yet", async () => {
    const view = await getLedgerView(db, await user("officer1"), ids.fir412Id);
    expect(view.position).toMatchObject({ totalLossMinor: L(100000), confirmedHeldMinor: L(80000), confirmedRefundsMinor: "0" });
    const holds = await db.hold.findMany({ where: { caseId: ids.fir412Id }, include: { account: true } });
    expect(Object.fromEntries(holds.map((h) => [h.account.label, h.confirmedAmountMinor?.toString()]))).toEqual({ "Account A": "0", "Account B": L(50000), "Account C": L(30000) });
  });

  it("records the onward transfers and the ₹20,000 cash withdrawal in the right layers", async () => {
    const txns = await db.transaction.findMany({ where: { caseId: ids.fir412Id }, include: { fromEntity: true, toEntity: true } });
    const by = (kind: string) => txns.filter((t) => t.kind === kind).map((t) => `${t.fromEntity.label}→${t.toEntity.label}:${Number(t.amountMinor) / 100}:L${t.layer}`).sort();
    expect(by("VICTIM_PAYMENT")).toEqual(["v1.synthetic@okbnkv→Account A:60000:L1", "v2.synthetic@okbnkv→Account A:40000:L1"]);
    expect(by("ONWARD_TRANSFER")).toEqual(["Account A→Account B:70000:L2", "Account A→Account C:30000:L2"]);
    expect(by("CASH_WITHDRAWAL")).toEqual(["Account B→Cash, ATM Kukatpally:20000:L3"]);
  });

  it("gives the case's requests references that name the FIR, with the Bank A reminder under H.REQ-412/2026-001", async () => {
    const rs = await requests();
    const numbered = rs.filter((r) => r.caseSeq !== null).map((r) => `${r.reference} ${r.recipient.configKey} ${r.category} ${r.status}`);
    expect(numbered).toEqual([
      "H.REQ-412/2026-001 bank-a HOLD PARTIAL_RESPONSE",
      "R.REQ-412/2026-002 unicross-zone INFORMATION SUBMITTED",
      "P.REQ-412/2026-003 dating-portal PRESERVATION COMPLETE_RESPONSE",
      "R.REQ-412/2026-004 npci-route INFORMATION SUBMITTED",
      "H.REQ-412/2026-005 bank-b HOLD COMPLETE_RESPONSE",
      "H.REQ-412/2026-006 bank-c HOLD COMPLETE_RESPONSE",
      "R.REQ-412/2026-007 bank-b INFORMATION DRAFT",
      "R.REQ-412/2026-008 unicross-zone INFORMATION DRAFT",
    ]);
    const reminder = rs.find((r) => r.caseSeq === null)!;
    expect(reminder).toMatchObject({ status: "DRAFT", reference: "H.REQ-412/2026-001-R1", parentRequestId: rs.find((r) => r.caseSeq === 1)!.id });
    expect(reminder.items.map((i) => i.itemType)).toEqual(["KYC"]);
  });

  it("has the assistant's drafts ready for the officer's approval, asking Bank B for the ATM details", async () => {
    const assistant = await db.user.findUniqueOrThrow({ where: { username: "assistant" } });
    const r07 = (await requests()).find((r) => r.caseSeq === 7)!;
    expect(r07.createdById).toBe(assistant.id);
    expect(r07.items.map((i) => i.itemType)).toEqual(["STATEMENT", "KYC", "LINKED_CONTACTS", "ATM_DETAILS"]);
    expect(r07.items.at(-1)!.label).toContain("₹20,000 withdrawal");
    expect(r07.versions[0]!.body).toContain("A hold was confirmed under reference BB/412/0908");
  });

  it("keeps the dating platform's preservation until 88 days from today", async () => {
    const r03 = (await requests()).find((r) => r.caseSeq === 3)!;
    expect(r03.preservedUntil?.toISOString()).toBe(istInputToUtc("2027-02-05T23:59")!.toISOString());
  });

  it("proposes the split decision, and the CCTV footage blocked on the ATM ID", async () => {
    const tasks = await db.task.findMany({ where: { caseId: ids.fir412Id } });
    const k = (prefix: string) => tasks.find((t) => t.dedupeKey.startsWith(prefix));
    expect(k("ALLOC:")).toMatchObject({ status: "OPEN", title: "Decide how the ₹80,000 is split between the two victims" });
    expect(k("CCTV:")).toMatchObject({ status: "BLOCKED" });
    expect(k("CCTV:")!.title).toBe("Get the ATM CCTV footage from 05 Nov, Kukatpally");
    expect(tasks.find((t) => t.title === "Check whether P1 is the person named in FIR 377")).toMatchObject({ status: "OPEN" });
    expect(tasks.find((t) => t.dedupeKey.startsWith("INFO:") && t.status === "DISMISSED")?.statusReason).toContain("Duplicate of H.REQ-412/2026-001");
  });

  it("no longer marks Accounts B and C as the officer's own entries once records confirmed them", async () => {
    const b = await db.entity.findFirstOrThrow({ where: { caseId: ids.fir412Id, label: "Account B" } });
    expect(b.officerEntry).toBe(false);
  });

  it("leaves Bank C's four-FIR hold table waiting for the officer to pick the request, and two messages unread", async () => {
    const r06 = (await requests()).find((r) => r.caseSeq === 6)!;
    const pending = await db.response.findFirstOrThrow({ where: { caseId: ids.fir412Id, matchStatus: "NEEDS_MATCH_REVIEW" } });
    expect(pending).toMatchObject({ requestId: r06.id, firCount: 4 });
    expect(pending.matchScore).toBeLessThan(70);
    expect(await db.inboxMessage.count({ where: { status: "UNREAD" } })).toBe(2);
  });

  it("registers the NCRP complaint against the FIR", async () => {
    expect(await db.complaint.findUniqueOrThrow({ where: { ackNumber: "33710260048816" } })).toMatchObject({ status: "REGISTERED", caseId: ids.fir412Id });
  });
});

describe("demo seed: the station", () => {
  it("has 38 open FIR cases (12 of them SI Krishna's), 14 closed this year, and 4 complaints awaiting an FIR", async () => {
    const krishna = await db.user.findUniqueOrThrow({ where: { username: "officer1" } });
    expect(await db.case.count({ where: { referenceType: "FIR", status: "OPEN" } })).toBe(38);
    expect(await db.case.count({ where: { referenceType: "FIR", status: "OPEN", assignments: { some: { userId: krishna.id } } } })).toBe(12);
    expect(await db.case.count({ where: { referenceType: "FIR", status: "CLOSED" } })).toBe(14);
    expect(await db.complaint.count({ where: { status: "AWAITING_FIR" } })).toBe(4);
  });

  it("has FIR 398/2026's hold lapsing in two days after Bank D refused to extend it", async () => {
    const kase = await db.case.findFirstOrThrow({ where: { firNumber: 398 } });
    const hold = await db.hold.findFirstOrThrow({ where: { caseId: kase.id } });
    expect(hold.confirmedAmountMinor?.toString()).toBe(L(180000));
    expect(hold.expiresAt?.toISOString()).toBe(istInputToUtc("2026-11-11T23:59")!.toISOString());
  });

  it("records six months of complaints whose losses add up to the station's monthly totals", async () => {
    const oct = await db.complaint.aggregate({ where: { receivedAt: { gte: istInputToUtc("2026-10-01T00:00")!, lt: istInputToUtc("2026-11-01T00:00")! } }, _sum: { lossAmountMinor: true } });
    expect(Number(oct._sum.lossAmountMinor) / 100).toBeGreaterThanOrEqual(2460000);
  });
});
