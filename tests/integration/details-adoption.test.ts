import { beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@/server/db";
import { seedDemo } from "@/server/seed";
import type { SessionUser } from "@/server/auth/session";
import { createCase } from "@/server/services/cases";
import { prepareDraftFromTask } from "@/server/services/drafting";
import { refreshRecommendations } from "@/server/services/tasks";

/**
 * An email address used to get a preservation request; it is now asked for its details. A preservation draft the
 * assistant wrote and that was never sent is taken over by the details request (same reference), not left behind.
 */
const db = getDb();
async function user(username: string): Promise<SessionUser> {
  const u = await db.user.findUniqueOrThrow({ where: { username }, include: { station: true } });
  return { id: u.id, username, displayName: u.displayName, rank: u.rank, role: u.role as SessionUser["role"], stationId: u.stationId, stationCode: u.station.code, stationName: u.station.name };
}
let caseId = "";
let me: SessionUser;
beforeAll(async () => {
  await seedDemo(db, { anchor: "2026-11-09" });
  me = await user("officer1");
  caseId = (
    await createCase(db, me, {
      referenceType: "FIR",
      firNumber: "1701",
      firYear: "2026",
      investigatingOfficerId: me.id,
      title: "Loan app fraud",
      incidentStart: "2026-11-01T10:00",
      reportedAt: "2026-11-05T10:00",
      parties: [{ name: "Test Complainant", role: "VICTIM", lossRupees: "10,000" }],
      identifiers: [{ kind: "EMAIL", value: "loans.desk@example.invalid", role: "Email used by the alleged fraudster" }],
    })
  ).id;
}, 240000);

describe("an earlier preservation draft for an email", () => {
  it("is rewritten as the details request, keeping its reference", async () => {
    const email = await db.entity.findFirstOrThrow({ where: { caseId, kind: "EMAIL" } });
    const details = await db.task.findFirstOrThrow({ where: { caseId, dedupeKey: `DETAILS:${email.id}` } });
    // The case as it stood before: a preservation proposal, drafted by the assistant, not sent.
    const old = await db.task.create({ data: { caseId, kind: "RECOMMENDATION", objective: "EVIDENCE", title: `Send a preservation request for ${email.label}`, question: "q", purpose: "p", relevance: "r", requestCategory: "PRESERVATION", subjectEntityIdsJson: JSON.stringify([email.id]), prerequisitesJson: "[]", expectedClarification: "c", priority: "NORMAL", priorityReason: "x", status: "OPEN", dedupeKey: `PRESERVE:${email.id}`, ruleId: "EVIDENCE_PRESERVATION", generatedBy: "RULE", scope: `Preserve available account records for ${email.value}.` } as never });
    // Not drafted yet (the case was made without the assistant drafting).
    expect(details.requestId).toBeNull();
    const pres = await prepareDraftFromTask(db, me, old.id, { asAssistant: true, withoutAddressee: true });
    expect(pres.category).toBe("PRESERVATION");
    await refreshRecommendations(db, me, caseId);
    expect((await db.task.findUniqueOrThrow({ where: { id: old.id } })).status).toBe("SUPERSEDED");
    const drafted = await prepareDraftFromTask(db, me, details.id, { asAssistant: true });
    expect(drafted.id).toBe(pres.id);
    const r = await db.request.findUniqueOrThrow({ where: { id: pres.id }, include: { items: true } });
    expect(r).toMatchObject({ category: "INFORMATION", reference: pres.reference, taskId: details.id });
    expect(r.items.map((i) => i.itemType)).toContain("IP_LOGS");
    expect((await db.task.findUniqueOrThrow({ where: { id: details.id } })).requestId).toBe(pres.id);
    expect(await db.auditEvent.count({ where: { objectId: pres.id, action: "request.rewritten_as_details" } })).toBe(1);
  });
});
