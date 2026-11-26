import { beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@/server/db";
import { seedDemo } from "@/server/seed";
import { istInputToUtc } from "@/domain/time";
import type { SessionUser } from "@/server/auth/session";
import { getPeopleView } from "@/server/services/people-view";
import { addOfficerEntry, updateIdentifierNotes, updatePersonDetails } from "@/server/services/people";

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

describe("people and identifiers", () => {
  it("names the parties by what the records say about them, keeping a name in the FIR apart from a bank's KYC", async () => {
    const v = await getPeopleView(db, await user("officer1"), fir412, at);
    // The people the investigation is about come first; the victims after them.
    expect(v.people.map((p) => [p.initials, p.label, p.sub, p.what])).toEqual([
      ["P1", "Person P1", "Named holder of Account A", "From the FIR only. Bank KYC not yet received."],
      ["P2", "Person P2", "KYC holder of Account B", "Reported by Bank B. Not shown to control it."],
      ["V1", "Victim 1", "Complainant", "Paid ₹60,000. Identity verified."],
      ["V2", "Victim 2", "Added 02 Nov", "Paid ₹40,000. Identity verified."],
    ]);
    expect(v.statements.map((s) => [s.title, s.pill.text])).toEqual([
      ["P1 is named as the holder of Account A", "Unverified"],
      ["P2 is the KYC holder of Account B", "Record"],
      ["Mobile +91-XXXXXXXX41 is registered to Account A", "Record"],
    ]);
  });

  it("lists each identifier with where it came from, what was asked about it, other cases and where it stands", async () => {
    const v = await getPeopleView(db, await user("officer1"), fir412, at);
    const row = (name: string) => v.rows.find((r) => r.name === name)!;
    expect(row("Mobile +91-XXXXXXXX87")).toMatchObject({ requests: "R.REQ-412/2026-002 sent 03 Nov", status: { text: "Waiting on UNICROSS" }, alsoIn: [{ ref: "FIR 377/2026", canOpen: false }] });
    expect(row("Account XXXXXXXXXXXX4471 · Bank A")).toMatchObject({ what: "Where both victims sent the money", requests: "H.REQ-412/2026-001 · 2 of 3 in", status: { text: "Restricted, empty" }, alsoIn: [{ ref: "FIR 355/2026" }] });
    expect(row("Account XXXXXXXXXXXX2093 · Bank B")).toMatchObject({ what: "Received ₹70,000 from Account A", requests: "H.REQ-412/2026-005 in · R.REQ-412/2026-007 drafted", status: { text: "₹50,000 held" } });
    expect(row("IP 203.0.113.42")).toMatchObject({ status: { text: "Incomplete" }, requestsSub: "Needs the port and exact time first" });
    expect(row("Mobile +91-XXXXXXXX41")).toMatchObject({ what: "Registered number for Account A", whatSub: "From Bank A’s reply · provider not yet known", status: { text: "New lead" } });
    // The victims' own numbers and UPI IDs come last and are never treated as leads.
    expect(v.rows.slice(-3).every((r) => r.status.text === "Victim’s own")).toBe(true);
    expect(v.counts).toEqual({ all: 12, phone: 3, account: 6, online: 3 });
  });

  it("says where anyone was seen, and what is still to establish", async () => {
    const v = await getPeopleView(db, await user("officer1"), fir412, at);
    expect(v.sightings.map((s) => [s.title, s.pill.text])).toEqual([
      ["ATM in Kukatpally, 05 Nov at 21:14", "4 days old"],
      ["P2’s address, Kukatpally", "Declared"],
    ]);
    expect(v.open).toEqual(["Who actually operated Account A and Account B", "Who was behind the “Anvi_K” profile", "Why Victim 2’s payment date differs between the FIR and the bank"]);
  });

  it("keeps an officer's entries and notes apart from the records, and logs them", async () => {
    const officer = await user("officer1");
    const e = await addOfficerEntry(db, officer, fir412, { kind: "WEBSITE", value: "trade-desk.example.invalid", whatItIs: "Website the victims were sent to", belongsTo: "SUSPECT" });
    const phone = (await getPeopleView(db, officer, fir412, at)).rows.find((r) => r.name === "Mobile +91-XXXXXXXX87")!;
    await updateIdentifierNotes(db, officer, phone.id, { nickname: "Caller", belongsTo: "SUSPECT" });
    const v = await getPeopleView(db, officer, fir412, at);
    expect(v.rows.find((r) => r.id === e.id)).toMatchObject({ source: "Your entry", status: { text: "Added by you", tone: "you" } });
    expect(v.rows.find((r) => r.id === phone.id)).toMatchObject({ nickname: "Caller", belongsTo: "SUSPECT", source: "From the FIR" });
    expect(await db.auditEvent.count({ where: { caseId: fir412, action: { in: ["entity.officer_entry_added", "entity.notes_updated"] } } })).toBeGreaterThanOrEqual(2);
    await expect(addOfficerEntry(db, officer, fir412, { kind: "WEBSITE", value: "trade-desk.example.invalid" })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("opens a person card with what the records say, what is linked, and the requests about it", async () => {
    const v = await getPeopleView(db, await user("officer1"), fir412, at);
    const p2 = v.people.find((p) => p.code === "P2")!;
    expect(p2.card.facts).toEqual(expect.arrayContaining([expect.objectContaining({ k: "KYC holder of", src: "From Bank B’s reply" }), expect.objectContaining({ k: "Declared address" })]));
    const acctB = v.rows.find((r) => r.name === "Account XXXXXXXXXXXX2093 · Bank B")!;
    expect(p2.card.linked).toContain(acctB.id);
    expect(v.statements.filter((s) => p2.card.statementIds.includes(s.id)).map((s) => s.title)).toEqual(["P2 is the KYC holder of Account B"]);
    const v1 = v.people.find((p) => p.code === "V1")!;
    expect(v1.card.facts).toEqual(expect.arrayContaining([expect.objectContaining({ k: "Paid", v: expect.stringMatching(/^₹60,000 in 1 payment/) })]));
    expect(v1.card.officer).toMatchObject({ name: null, belongsTo: "VICTIM" });
  });

  it("shows a name learned during the investigation as “Name (P1)”, kept beside the records and logged", async () => {
    const officer = await user("officer1");
    const before = await getPeopleView(db, officer, fir412, at);
    const p1 = before.people.find((p) => p.code === "P1")!;
    const r = await updatePersonDetails(db, officer, p1.id, { version: p1.card.version, name: "P. Kiran", relative: "P. Ramesh", notes: "Named by Victim 2 on a call, 08 Nov." });
    expect(r.changed).toEqual(["name", "relative", "notes"]);
    const after = await getPeopleView(db, officer, fir412, at);
    const now1 = after.people.find((p) => p.id === p1.id)!;
    expect(now1).toMatchObject({ code: "P1", name: "P. Kiran", label: "P. Kiran (P1)", nameFrom: "Entered by you" });
    expect(now1.card.officer).toMatchObject({ name: "P. Kiran", relative: "P. Ramesh", by: "you" });
    // The record's own label is untouched; the change is in the audit log with before and after.
    expect((await db.entity.findUniqueOrThrow({ where: { id: p1.id } })).label).toBe("P1");
    const audit = await db.auditEvent.findFirstOrThrow({ where: { caseId: fir412, action: "entity.person_details_updated", objectId: p1.id } });
    expect(JSON.parse(audit.detailJson ?? "{}")).toMatchObject({ before: { name: null }, after: { name: "P. Kiran", relative: "P. Ramesh" } });
    // A save from a card opened before that change is refused, not merged silently.
    await expect(updatePersonDetails(db, officer, p1.id, { version: p1.card.version, name: "Someone else" })).rejects.toMatchObject({ code: "CONFLICT" });
    // Saving nothing new changes nothing and logs nothing.
    const n = await db.auditEvent.count({ where: { action: "entity.person_details_updated", objectId: p1.id } });
    await updatePersonDetails(db, officer, p1.id, { version: now1.card.version, name: "P. Kiran" });
    expect(await db.auditEvent.count({ where: { action: "entity.person_details_updated", objectId: p1.id } })).toBe(n);
    // Too long, or not a person, or not this officer's case: refused.
    await expect(updatePersonDetails(db, officer, p1.id, { version: now1.card.version, name: "x".repeat(121) })).rejects.toMatchObject({ code: "VALIDATION", fieldErrors: { name: expect.any(String) } });
    await expect(updatePersonDetails(db, officer, after.rows[0]!.id, { version: now1.card.version, name: "x" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(updatePersonDetails(db, await user("officer2"), p1.id, { version: now1.card.version, name: "x" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("shows a victim's name from the record as “Name (V1)”, the complainant first", async () => {
    const officer = await user("officer1");
    const v = await getPeopleView(db, officer, fir412, at);
    const v2 = v.people.find((p) => p.code === "V2")!;
    await updatePersonDetails(db, officer, v2.id, { version: v2.card.version, name: "Ramesh" });
    const after = await getPeopleView(db, officer, fir412, at);
    expect(after.people.filter((p) => p.victim).map((p) => p.label)).toEqual(["Victim 1", "Ramesh (V2)"]);
  });

  it("is not open to an officer who is not on the case; the supervisor can read it", async () => {
    await expect(getPeopleView(db, await user("officer2"), fir412, at)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const v = await getPeopleView(db, await user("supervisor"), fir412, at);
    expect(v.rows.length).toBeGreaterThan(0);
  });
});
