import { describe, expect, it, beforeAll } from "vitest";
import { getDb } from "@/server/db";
import { seedDemo } from "@/server/seed";
import { listActivity, recordCorrection } from "@/server/services/activity";
import { createReport, exportReportPdf, getHandover, getReport, markReportReviewed, saveReportEdit } from "@/server/services/reports";
import type { SessionUser } from "@/server/auth/session";

const db = getDb();
let ids: Awaited<ReturnType<typeof seedDemo>>;

async function user(username: string): Promise<SessionUser> {
  const u = await db.user.findUniqueOrThrow({ where: { username }, include: { station: true } });
  return { id: u.id, username, displayName: u.displayName, rank: u.rank, role: u.role === "SUPERVISOR" ? "SUPERVISOR" : "OFFICER", stationId: u.stationId, stationCode: u.station.code, stationName: u.station.name };
}

beforeAll(async () => {
  ids = await seedDemo(db, { anchor: "2026-11-09" });
}, 120000);

describe("activity log", () => {
  it("lists a case's history newest first and filters by category and by who acted", async () => {
    const officer = await user("officer1");
    const all = await listActivity(db, officer, ids.fir412Id, {});
    expect(all.events.length).toBeGreaterThan(10);
    const times = all.events.map((e) => e.at);
    expect([...times].sort().reverse()).toEqual(times);

    const funds = await listActivity(db, officer, ids.fir412Id, { category: "FUNDS" });
    expect(funds.events.length).toBeGreaterThan(0);
    expect(funds.events.every((e) => e.action.startsWith("funds."))).toBe(true);

    const system = await listActivity(db, officer, ids.fir412Id, { who: "SYSTEM" });
    expect(system.events.length).toBeGreaterThan(0);
    expect(system.events.every((e) => e.actor === null)).toBe(true);
  });

  it("pages through the history without repeating entries", async () => {
    const officer = await user("officer1");
    const first = await listActivity(db, officer, ids.fir412Id, { limit: 5 });
    expect(first.events).toHaveLength(5);
    expect(first.nextCursor).not.toBeNull();
    const second = await listActivity(db, officer, ids.fir412Id, { limit: 5, cursor: first.nextCursor! });
    expect(second.events).toHaveLength(5);
    expect(second.events.some((e) => first.events.some((f) => f.id === e.id))).toBe(false);
  });

  it("records a correction as a new entry linked to the original, which stays unchanged", async () => {
    const officer = await user("officer1");
    const original = (await listActivity(db, officer, ids.fir412Id, { category: "REQUESTS" })).events.at(-1)!;
    const correction = await recordCorrection(db, officer, ids.fir412Id, original.id, { text: "The call to the bank was made at 15:10 IST, not 14:10 IST." });
    const after = await listActivity(db, officer, ids.fir412Id, { limit: 200 });
    const again = after.events.find((e) => e.id === original.id)!;
    expect(again.summary).toBe(original.summary);
    expect(again.correctedBy.map((c) => c.id)).toEqual([correction.id]);
    const entry = after.events.find((e) => e.id === correction.id)!;
    expect(entry).toMatchObject({ action: "activity.correction_recorded", corrects: { id: original.id } });
    expect(entry.summary).toContain("15:10 IST");
  });

  it("asks for a meaningful correction and only within the same case", async () => {
    const officer = await user("officer1");
    const event = (await listActivity(db, officer, ids.fir412Id, {})).events[0]!;
    await expect(recordCorrection(db, officer, ids.fir412Id, event.id, { text: "typo" })).rejects.toMatchObject({ code: "VALIDATION" });
    const other = await db.case.findFirstOrThrow({ where: { firNumber: 405 } });
    await expect(recordCorrection(db, officer, other.id, event.id, { text: "This belongs to another case entirely." })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("does not show a case's history to an officer who is not assigned to it", async () => {
    await expect(listActivity(db, await user("officer2"), ids.fir412Id, {})).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("reports", () => {
  it("drafts a case summary whose figures match the ledger, with links to sources", async () => {
    const officer = await user("officer1");
    const { reportId } = await createReport(db, officer, ids.fir412Id, "CASE_SUMMARY");
    const r = await getReport(db, officer, reportId);
    expect(r.report).toMatchObject({ kind: "CASE_SUMMARY", status: "DRAFT", latestVersion: 1 });
    expect(r.version).toMatchObject({ versionNo: 1, generated: true });
    expect(r.version.body).toContain("₹1,00,000");
    expect(r.version.body).toContain("₹80,000");
    expect(r.version.body).toContain("₹20,000");
    expect(r.version.body).not.toMatch(/section \d+|u\/s/i);
    expect(r.version.sources.length).toBeGreaterThan(0);
    for (const s of r.version.sources) expect(r.version.body).toContain(`[${s.ref}]`);
  });

  it("drafts a case diary from officers' steps only, grouped by day", async () => {
    const officer = await user("officer1");
    const { reportId } = await createReport(db, officer, ids.fir412Id, "CASE_DIARY");
    const { version } = await getReport(db, officer, reportId);
    expect(version.body).toMatch(/^## \d{2} [A-Z][a-z]{2} \d{4}$/m);
    expect(version.body).toContain("submitted");
    const recommended = (await db.auditEvent.findFirstOrThrow({ where: { caseId: ids.fir412Id, action: "task.recommended" } })).summary;
    expect(version.body).not.toContain(recommended);
  });

  it("hands over unresolved leads, pending requests and responses waiting for review", async () => {
    const officer = await user("officer1");
    const h = await getHandover(db, officer, ids.fir412Id);
    expect(h.leads.length).toBeGreaterThan(0);
    expect(h.pendingRequests.map((r) => r.status)).toEqual(expect.arrayContaining(["DRAFT", "SUBMITTED"]));
    expect(h.responsesToReview.length).toBeGreaterThanOrEqual(1);
    const { reportId } = await createReport(db, officer, ids.fir412Id, "HANDOVER");
    const { version } = await getReport(db, officer, reportId);
    for (const r of h.pendingRequests) expect(version.body).toContain(r.reference);
  });

  it("keeps every version; review applies to one exact version and an edit starts a new draft", async () => {
    const officer = await user("officer1");
    const { reportId } = await createReport(db, officer, ids.fir412Id, "CASE_SUMMARY");
    const v1 = (await getReport(db, officer, reportId)).version;

    await saveReportEdit(db, officer, reportId, { body: `${v1.body}\n\nOfficer note: statement of Account A requested again.`, changeNote: "Added a note on the repeat request", expectedVersion: 1 });
    await expect(saveReportEdit(db, officer, reportId, { body: "stale", changeNote: "Late edit", expectedVersion: 1 })).rejects.toMatchObject({ code: "CONFLICT" });
    let r = await getReport(db, officer, reportId);
    expect(r.report).toMatchObject({ latestVersion: 2, status: "DRAFT" });
    expect(r.version).toMatchObject({ versionNo: 2, generated: false, changeNote: "Added a note on the repeat request" });
    expect((await getReport(db, officer, reportId, 1)).version.body).toBe(v1.body);

    await expect(markReportReviewed(db, officer, reportId, { versionNo: 1 })).rejects.toMatchObject({ code: "PRECONDITION" });
    await markReportReviewed(db, officer, reportId, { versionNo: 2 });
    r = await getReport(db, officer, reportId);
    expect(r.report.status).toBe("REVIEWED");
    expect(r.version.reviewedAt).not.toBeNull();

    await saveReportEdit(db, officer, reportId, { body: "Shorter summary for the supervisor.", changeNote: "Shortened", expectedVersion: 2 });
    r = await getReport(db, officer, reportId);
    expect(r.report).toMatchObject({ latestVersion: 3, status: "DRAFT" });
    expect((await getReport(db, officer, reportId, 2)).version.reviewedAt).not.toBeNull();
  });

  it("refuses to change a saved version in the database", async () => {
    const officer = await user("officer1");
    const { reportId } = await createReport(db, officer, ids.fir412Id, "HANDOVER");
    const before = await db.reportVersion.findFirstOrThrow({ where: { reportId } });
    // The SQLite trigger aborts the write (Prisma reports trigger aborts as a generic constraint error).
    await expect(db.reportVersion.updateMany({ where: { reportId }, data: { body: "rewritten" } })).rejects.toThrow();
    await expect(db.reportVersion.deleteMany({ where: { reportId } })).rejects.toThrow();
    expect((await db.reportVersion.findFirstOrThrow({ where: { reportId } })).body).toBe(before.body);
  });

  it("exports a version as a PDF and records who exported it", async () => {
    const officer = await user("officer1");
    const { reportId } = await createReport(db, officer, ids.fir412Id, "CASE_SUMMARY");
    const file = await exportReportPdf(db, officer, reportId, 1);
    expect(file.bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(file.filename).toMatch(/\.pdf$/);
    const audit = await db.auditEvent.findFirst({ where: { caseId: ids.fir412Id, action: "report.exported", objectId: reportId } });
    expect(audit?.actorId).toBe(officer.id);
  });

  it("keeps reports inside the case's access boundary", async () => {
    const officer = await user("officer1");
    const { reportId } = await createReport(db, officer, ids.fir412Id, "CASE_SUMMARY");
    const outsider = await user("officer2");
    await expect(getReport(db, outsider, reportId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(exportReportPdf(db, outsider, reportId, 1)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(createReport(db, outsider, ids.fir412Id, "HANDOVER")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
