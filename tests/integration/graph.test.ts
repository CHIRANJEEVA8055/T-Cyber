import { describe, expect, it, beforeAll } from "vitest";
import { getDb } from "@/server/db";
import { seedDemo } from "@/server/seed";
import { getGraphData, markGraphReviewed } from "@/server/services/graph";
import type { SessionUser } from "@/server/auth/session";

const L = (r: number) => (BigInt(r) * 100n).toString();
const db = getDb();
let ids: Awaited<ReturnType<typeof seedDemo>>;

async function user(username: string): Promise<SessionUser> {
  const u = await db.user.findUniqueOrThrow({ where: { username }, include: { station: true } });
  return { id: u.id, username, displayName: u.displayName, rank: u.rank, role: u.role === "SUPERVISOR" ? "SUPERVISOR" : "OFFICER", stationId: u.stationId, stationCode: u.station.code, stationName: u.station.name };
}

beforeAll(async () => {
  ids = await seedDemo(db, { anchor: "2026-11-09" });
}, 120000);

describe("case graph read model", () => {
  const ref = async (seq: number) => (await db.request.findFirstOrThrow({ where: { caseId: ids.fir412Id, caseSeq: seq } })).reference;

  it("records which response revealed each later record and the lead it was requested about", async () => {
    const data = await getGraphData(db, await user("officer1"), ids.fir412Id);
    const a = data.nodes.find((n) => n.label === "Account A")!;
    const b = data.nodes.find((n) => n.label === "Account B")!;
    const mobile41 = data.nodes.find((n) => n.label === "+91-XXXXXXXX41")!;
    expect(mobile41.learnedFrom).toMatchObject({ kind: "RESPONSE", findingType: "RELATIONSHIP", requestReference: await ref(1), organisation: "Bank A", leadEntityIds: [a.id] });
    const p2 = data.nodes.find((n) => n.label === "P2")!;
    expect(p2.learnedFrom).toMatchObject({ kind: "RESPONSE", findingType: "KYC_RECORD", requestReference: await ref(5), leadEntityIds: [b.id] });
    const onward = data.moneyEdges.find((e) => e.source === a.id && e.target === b.id)!;
    expect(onward).toMatchObject({ status: "CONFIRMED_BY_BANK", amountMinor: L(70000), layer: 2 });
    expect(onward.learnedFrom).toMatchObject({ kind: "RESPONSE", requestReference: await ref(1) });
    expect(data.phases).toEqual([
      { phase: 0, title: "Intake", detail: "FIR and complainant documents" },
      { phase: 1, title: "Phase 1", detail: "Recorded by an officer" },
      { phase: 2, title: "Phase 2", detail: `Dating platform response to ${await ref(3)}` },
      { phase: 3, title: "Phase 3", detail: `Bank B response to ${await ref(5)}` },
      { phase: 4, title: "Phase 4", detail: `Bank A response to ${await ref(1)}` },
    ]);
  });

  it("keeps a KYC address date as a date, without inventing a time of day", async () => {
    const data = await getGraphData(db, await user("officer1"), ids.fir412Id);
    expect(data.locations.find((l) => l.description.includes("KYC"))).toMatchObject({ eventDateOnly: true, eventAtNote: "KYC / account-opening date" });
    expect(data.locations.find((l) => l.description.includes("cash withdrawn"))).toMatchObject({ eventDateOnly: false });
  });

  it("links intake records to the document they were extracted from", async () => {
    const data = await getGraphData(db, await user("officer1"), ids.fir412Id);
    const a = data.nodes.find((n) => n.label === "Account A")!;
    expect(a.learnedFrom).toMatchObject({ kind: "DOCUMENT" });
    expect(a.learnedFrom?.kind === "DOCUMENT" && a.learnedFrom.evidenceTitle).toBe("FIR 412/2026");
  });

  it("summarises holds per account: a hold on an empty account is ₹0, not unknown", async () => {
    const data = await getGraphData(db, await user("officer1"), ids.fir412Id);
    const hold = (label: string) => data.nodes.find((n) => n.label === label)!.hold;
    expect(hold("Account A")).toEqual({ heldMinor: "0", amountUnknown: false, requested: false });
    expect(hold("Account B")).toEqual({ heldMinor: L(50000), amountUnknown: false, requested: false });
    expect(hold("Account C")).toEqual({ heldMinor: L(30000), amountUnknown: false, requested: false });
  });

  it("marks only records learned after the officer's review as new", async () => {
    const officer = await user("officer1");
    await markGraphReviewed(db, officer, ids.fir412Id);
    await new Promise((res) => setTimeout(res, 5));
    const { addOfficerEntry } = await import("@/server/services/people");
    const added = await addOfficerEntry(db, officer, ids.fir412Id, { kind: "PHONE", value: "+91-XXXXXXXX55", whatItIs: "Number the bank's call centre gave by phone", belongsTo: "UNKNOWN" });
    const data = await getGraphData(db, officer, ids.fir412Id);
    expect(data.nodes.find((n) => n.id === added.id)?.isNew).toBe(true);
    expect(data.nodes.find((n) => n.label === "Account A")?.isNew).toBe(false);
  });

  it("does not reveal a case to an officer who is not assigned to it", async () => {
    await expect(getGraphData(db, await user("officer2"), ids.fir412Id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
