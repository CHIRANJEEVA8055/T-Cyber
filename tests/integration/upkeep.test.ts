import { beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@/server/db";
import { seedDemo } from "@/server/seed";
import { istInputToUtc } from "@/domain/time";
import { upkeepOpenCases } from "@/server/services/upkeep";

const db = getDb();
// Three weeks after the demo's day: follow-up dates of requests sent then have passed with no full reply.
const later = istInputToUtc("2026-11-30T10:00")!;

beforeAll(async () => {
  await seedDemo(db, { anchor: "2026-11-09" });
}, 240000);

describe("case upkeep: what comes due with time alone", () => {
  it("lists what it would draft, and writes nothing, in a dry run", async () => {
    const before = await db.request.count();
    const r = await upkeepOpenCases(db, { at: later, dryRun: true });
    expect(r.drafted.length).toBeGreaterThan(0);
    expect(await db.request.count()).toBe(before);
  });

  it("drafts each due reminder as the assistant, for the officer to check and send, and never sends", async () => {
    const r = await upkeepOpenCases(db, { at: later });
    expect(r.failed).toBe(0);
    expect(r.drafted.length).toBeGreaterThan(0);
    for (const d of r.drafted) expect(d.reference).toMatch(/^[PRHU]\.REQ-\d+\/2026-\d{3}-R\d+$/);
    const reminders = await db.request.findMany({ where: { reference: { in: r.drafted.map((d) => d.reference) } }, include: { submissions: true } });
    expect(reminders).toHaveLength(r.drafted.length);
    for (const x of reminders) {
      expect(x.status).toBe("DRAFT");
      expect(x.parentRequestId).not.toBeNull();
      expect(x.submissions).toHaveLength(0);
    }
    // Each is in its case's Next actions as a drafted follow-up, and the case's audit log says why.
    const t = await db.task.findFirst({ where: { requestId: reminders[0]!.id, dedupeKey: { startsWith: "FOLLOWUP:" } } });
    expect(t).not.toBeNull();
    const audit = await db.auditEvent.findFirst({ where: { caseId: reminders[0]!.caseId, action: "request.auto_drafted" }, orderBy: { at: "desc" } });
    expect(audit?.summary).toMatch(/follow-up date passed.*nothing was sent/);
  });

  it("changes nothing when run again", async () => {
    const before = await db.request.count();
    const r = await upkeepOpenCases(db, { at: later });
    expect(r.drafted).toEqual([]);
    expect(await db.request.count()).toBe(before);
  });
});
