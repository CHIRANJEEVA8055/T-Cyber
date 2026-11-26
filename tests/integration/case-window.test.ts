import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@/server/db";
import { seedDemo } from "@/server/seed";
import { setClock } from "@/server/clock";
import { istInputToUtc } from "@/domain/time";
import type { SessionUser } from "@/server/auth/session";
import { getNextActions } from "@/server/services/next-actions";
import { getCaseHome, getCaseWindow, markOverviewSeen } from "@/server/services/case-home";
import { approveAndSend, rescopeDraft } from "@/server/services/requests";
import { previewSplit, recordSplitDecision } from "@/server/services/allocation-decision";
import { buildCaseFile } from "@/server/services/case-file";
import { readZip } from "@/server/documents/zip";

const db = getDb();
const at = istInputToUtc("2026-11-09T11:30")!;
let fir412 = "";

async function user(username: string): Promise<SessionUser> {
  const u = await db.user.findUniqueOrThrow({ where: { username }, include: { station: true } });
  return { id: u.id, username, displayName: u.displayName, rank: u.rank, role: u.role === "SUPERVISOR" ? "SUPERVISOR" : "OFFICER", stationId: u.stationId, stationCode: u.station.code, stationName: u.station.name };
}

beforeAll(async () => {
  fir412 = (await seedDemo(db, { anchor: "2026-11-09" })).fir412Id;
  setClock(at);
}, 240000);
afterAll(() => setClock(null));

describe("case window and overview", () => {
  it("frames the case: reference, day, open actions and who is looking", async () => {
    const w = await getCaseWindow(db, await user("officer1"), fir412, at);
    expect(w).toMatchObject({ ref: "FIR 412/2026", title: "Investment-app fraud", stationName: "PS Madhapur", day: 7, actionCount: 6, viewer: { name: "SI Krishna", initials: "SK", role: "Investigating officer" } });
  });

  it("says where the case stands, from its records", async () => {
    const o = await getCaseHome(db, await user("officer1"), fir412, at);
    expect(o.header).toMatchObject({ sub: "₹1,00,000 lost · day 7", phase: { text: "Phase 2 · first bank reply in" }, progress: "4 of 6 requests answered · last change 08 Nov, 14:20" });
    expect(o.money).toMatchObject({ held: "₹80,000", of: "of ₹1,00,000 is held in two accounts", bar: { held: 80, traced: 20, returned: 0 } });
    expect(o.money.sentence).toBe("₹20,000 was withdrawn as cash on 05 Nov and is being traced. Nothing has been returned to the victims yet.");
    expect(o.identity).toMatchObject({ headline: "No one identified yet", leads: 3, sightings: 1, sightingAge: 4, contradictions: 1 });
    expect(o.identity.sentence).toBe("Two accounts have named holders, but nothing yet shows who controlled them. The strongest lead is the ATM withdrawal in Kukatpally.");
    // Only the sections the FIR records, explained; nothing proposed beside them.
    expect(o.facts.find((f) => f.label === "Sections")).toMatchObject({ value: "318(4) BNS · 66D IT Act", sub: "Cheating · cheating by personation online" });
  });

  it("lists what changed since the officer last looked, then nothing once marked as seen", async () => {
    const officer = await user("officer1");
    const o = await getCaseHome(db, officer, fir412, at);
    expect(o.changes.items.map((c) => c.text)).toEqual([
      "Bank A’s statement shows the money moved on to Account B (₹70,000) and Account C (₹30,000). It also gave a new mobile number, +91-XXXXXXXX41. The KYC you asked for was not included.",
      "Bank B and Bank C confirmed holds: ₹50,000 and ₹30,000. ₹20,000 had already been taken out of Account B in cash.",
      "The dating platform preserved the “Anvi_K” profile records until 05 Feb 2027. The request to disclose them is not written yet.",
    ]);
    // Another officer's marker is separate.
    const devi = await user("supervisor");
    expect((await getCaseHome(db, devi, fir412, at)).changes.items.length).toBeGreaterThan(0);
    await markOverviewSeen(db, officer, fir412);
    expect((await getCaseHome(db, officer, fir412, at)).changes.items).toEqual([]);
    expect((await getCaseHome(db, devi, fir412, at)).changes.items.length).toBeGreaterThan(0);
  });

  it("names what the case waits on, including replies already sitting in the mailbox", async () => {
    const o = await getCaseHome(db, await user("officer1"), fir412, at);
    expect(o.waiting.map((w) => [w.text, w.pill.text])).toEqual([
      ["UNICROSS · CDR for +91-XXXXXXXX87", "Reply in the inbox"],
      ["NPCI · UPI trace", "Acknowledged · in the inbox"],
      ["Bank A · the missing KYC", "Remind"],
      ["Victim 2 · a clearer UPI receipt", "Ask"],
    ]);
    expect(o.questions.map((q) => q.text)).toEqual([
      "Whose money is the ₹50,000 in Account B? Both victims paid into Account A first.",
      "Bank A dates Victim 2’s ₹40,000 payment 03 Nov; the FIR says 02 Nov.",
      "Two characters of Victim 2’s UPI reference are unreadable.",
    ]);
  });
});

describe("working the next actions", () => {
  it("narrows what a draft asks for without making the officer its author", async () => {
    const officer = await user("officer1");
    const n = await getNextActions(db, officer, fir412, at);
    const unicross = n.actions.find((a) => a.title.startsWith("Ask UNICROSS"))!.request!;
    const imei = unicross.items.find((i) => i.itemType === "IMEI")!;
    await rescopeDraft(db, officer, unicross.id, { expectedVersion: unicross.version, keepItemIds: unicross.items.filter((i) => i.id !== imei.id).map((i) => i.id) });
    const after = (await getNextActions(db, officer, fir412, at)).actions.find((a) => a.title.startsWith("Ask UNICROSS"))!.request!;
    expect(after.items.map((i) => i.itemType)).not.toContain("IMEI");
    expect(after.body).not.toContain(imei.label);
    expect(after).toMatchObject({ authoredByAssistant: true, mode: "APPROVE_AND_SEND" });
    await expect(rescopeDraft(db, officer, unicross.id, { expectedVersion: after.version, keepItemIds: [] })).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("approves and sends a draft through the simulated adapter; it stays listed as sent and the CCTV action still waits on it", async () => {
    const officer = await user("officer1");
    const bankB = (await getNextActions(db, officer, fir412, at)).actions[0]!;
    expect(bankB.request).toMatchObject({ reference: "R.REQ-412/2026-007", mode: "APPROVE_AND_SEND" });
    expect(bankB.request!.attachments.map((f) => f.fileName)).toEqual(["FIR_412_2026.pdf"]);
    expect(bankB.request!.body).toContain("Signed FIR copy attached.");
    const r = await approveAndSend(db, officer, bankB.request!.id, { expectedVersion: bankB.request!.version, idempotencyKey: "test:r07" });
    expect(r).toMatchObject({ outcome: "SUCCEEDED", reference: "R.REQ-412/2026-007" });
    const n = await getNextActions(db, officer, fir412, at);
    expect(n.actions[0]).toMatchObject({ rank: 1, kind: "SENT", status: { text: "Sent · awaiting reply" } });
    const cctv = n.actions.find((a) => a.kind === "BLOCKED")!;
    expect(cctv.status.text).toBe("Waits on 1");
    expect(cctv.chain.map((c) => [c.state, c.text])).toEqual([
      ["done", "Cash withdrawal recorded"],
      ["done", "R.REQ-412/2026-007 sent to Bank B, waiting for the reply"],
      ["now", "Bank B replies and the ATM ID is read from it"],
      ["todo", "The CCTV request is drafted to the operator"],
    ]);
    expect(cctv.note).toBe("Footage is usually kept 30 to 90 days. The withdrawal was 4 days ago, so there is time.");
    expect(await db.auditEvent.count({ where: { caseId: fir412, action: "request.submitted", objectId: bankB.request!.id } })).toBe(1);
  });

  it("shows what each way of splitting gives, and records the officer's choice with a reason", async () => {
    const officer = await user("officer1");
    const p = await previewSplit(db, officer, fir412);
    if (!p.needed) throw new Error("expected a split to be needed");
    expect(p.options.map((o) => o.title)).toEqual(["Split 60:40, as the victims paid in", "First in, first out", "Let the court decide"]);
    expect(p.options[0]!.detail).toContain("Victim 1 ₹48,000 · Victim 2 ₹32,000");
    expect(p.options[1]!.detail).toContain("Victim 1 ₹40,000 · Victim 2 ₹40,000");
    expect(p.options[1]!.detail).toContain("Victim 2’s payment time is disputed");
    await expect(recordSplitDecision(db, officer, fir412, { method: "PROPORTIONAL", note: "ok" })).rejects.toMatchObject({ code: "VALIDATION" });
    await recordSplitDecision(db, officer, fir412, { method: "PROPORTIONAL", note: "Both paid into Account A within minutes; the money is not separable." });
    const proposed = await db.allocation.findMany({ where: { caseId: fir412, status: "PROPOSED" }, include: { claim: { include: { victim: true } } } });
    const byVictim = new Map<string, bigint>();
    for (const a of proposed) byVictim.set(a.claim.victim.label, (byVictim.get(a.claim.victim.label) ?? 0n) + a.amountMinor);
    expect(Object.fromEntries(byVictim)).toEqual({ "Victim 1": 4800000n, "Victim 2": 3200000n });
    const n = await getNextActions(db, officer, fir412, at);
    expect(n.actions.find((a) => a.ruleId === "FUNDS_ALLOCATION_BASIS")).toMatchObject({ kind: "DECIDED", status: { text: "Decided" } });
    await expect(recordSplitDecision(db, officer, fir412, { method: "COURT", note: "Changed my mind about the route." })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("keeps an officer off another officer's case", async () => {
    await expect(previewSplit(db, await user("officer2"), fir412)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(buildCaseFile(db, await user("officer2"), fir412)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("the case file download", () => {
  it("zips every original with its recorded and recomputed hash, the ledger and the audit log, and logs the export", async () => {
    const f = await buildCaseFile(db, await user("officer1"), fir412);
    expect(f).toMatchObject({ fileName: "FIR_412-2026_case_file.zip", mismatches: 0, missing: 0 });
    const files = readZip(f.buffer);
    const names = files.map((x) => x.name);
    expect(names.slice(0, 6)).toEqual(["README.txt", "manifest.csv", "ledger.txt", "transactions.csv", "requests.csv", "audit-log.csv"]);
    expect(names.some((n) => /^originals\/\d{3}_FIR_412_2026\.pdf$/.test(n))).toBe(true);
    const manifest = files.find((x) => x.name === "manifest.csv")!.data.toString("utf8");
    expect(manifest.split("\r\n").filter((l) => l.endsWith('"NO"'))).toEqual([]);
    expect(files.find((x) => x.name === "README.txt")!.data.toString("utf8")).toContain("SYNTHETIC DEMONSTRATION DATA");
    expect(files.find((x) => x.name === "ledger.txt")!.data.toString("utf8")).toContain("Confirmed held:           ₹80,000");
    expect(await db.auditEvent.count({ where: { caseId: fir412, action: "case.exported" } })).toBe(1);
  });
});
