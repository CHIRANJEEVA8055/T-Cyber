import { describe, expect, it, beforeAll } from "vitest";
import { getDb } from "@/server/db";
import { seedDemo } from "@/server/seed";
import { approveRequest, submitRequest } from "@/server/services/requests";
import { listDirectory, listIntegrations, listRoutes, listTemplates, resetDemoData, setFailureSimulation, setRecipientVerification, updateRoute, updateTemplate } from "@/server/services/settings";
import { getWorkQueue } from "@/server/services/work-queue";
import { searchRecords } from "@/server/services/search";
import { getShellCounts } from "@/server/services/shell";
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

describe("work queue", () => {
  it("lists exactly what the navigation count says needs action", async () => {
    for (const name of ["officer1", "officer2", "supervisor"]) {
      const u = await user(name);
      const q = await getWorkQueue(db, u);
      expect(q.total).toBe((await getShellCounts(db, u)).workQueue);
    }
    expect((await getWorkQueue(db, await user("officer1"))).approvals).toEqual([]);
  });

  it("only includes cases the officer may see", async () => {
    const lavanya = await user("officer2");
    const q = await getWorkQueue(db, lavanya);
    expect(q.tasks.length).toBeGreaterThan(0);
    const hers = (await db.case.findMany({ where: { assignments: { some: { userId: lavanya.id } } } })).map((c) => `FIR ${c.firNumber}/${c.firYear}`);
    expect(q.tasks.every((t) => hers.includes(t.caseReference))).toBe(true);
    expect(q.tasks.some((t) => t.caseReference === "FIR 412/2026")).toBe(false);
  });
});

describe("search", () => {
  it("finds records, document text and requests across the officer's own cases only", async () => {
    const o1 = await searchRecords(db, await user("officer1"), "2093");
    expect(o1.records.map((r) => r.label)).toContain("Account B");
    expect(o1.evidence.length).toBeGreaterThan(0);
    expect(o1.evidence[0]!.href).toMatch(/\/evidence\/[^?]+\?(page|line|row)=\d+/);
    const o2 = await searchRecords(db, await user("officer2"), "2093");
    expect([...o2.cases, ...o2.records, ...o2.evidence, ...o2.requests]).toEqual([]);
  });

  it("finds a case by its FIR reference and a request by its reference", async () => {
    const r = await searchRecords(db, await user("officer1"), "FIR 405/2026");
    expect(r.cases.map((c) => c.reference)).toEqual(["FIR 405/2026"]);
    const q = await searchRecords(db, await user("officer1"), "R.REQ-412/2026-004");
    expect(q.requests.map((x) => x.reference)).toEqual(["R.REQ-412/2026-004"]);
  });

  it("asks for at least two characters", async () => {
    expect((await searchRecords(db, await user("officer1"), "a")).tooShort).toBe(true);
  });
});

describe("settings", () => {
  it("lets a supervisor verify a recipient with a note and keeps officers to reading", async () => {
    const sup = await user("supervisor");
    const officer = await user("officer1");
    const target = (await listDirectory(db, officer)).find((r) => r.verificationStatus === "UNVERIFIED")!;
    await expect(setRecipientVerification(db, officer, target.id, { verified: true, note: "Checked against the provider's contact page." })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(setRecipientVerification(db, sup, target.id, { verified: true, note: "ok" })).rejects.toMatchObject({ code: "VALIDATION" });
    await setRecipientVerification(db, sup, target.id, { verified: true, note: "Checked against the provider's law-enforcement contact page." });
    expect((await listDirectory(db, officer)).find((r) => r.id === target.id)).toMatchObject({ verificationStatus: "VERIFIED", verifiedBy: "Inspector R. Devi" });
    expect((await db.auditEvent.findFirst({ where: { action: "directory.verification_changed", objectId: target.id } }))?.actorId).toBe(sup.id);
  });

  it("edits a template with known placeholders only, and versions it", async () => {
    const sup = await user("supervisor");
    const t = (await listTemplates(db, sup)).find((x) => x.category === "FOLLOW_UP")!;
    expect(t.placeholders).toContain("parentReference");
    await expect(updateTemplate(db, sup, t.id, { subjectTemplate: t.subjectTemplate, bodyTemplate: `${t.bodyTemplate}\n{{victimAadhaar}}`, expectedVersion: t.version })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(updateTemplate(db, await user("officer1"), t.id, { subjectTemplate: t.subjectTemplate, bodyTemplate: t.bodyTemplate, expectedVersion: t.version })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await updateTemplate(db, sup, t.id, { subjectTemplate: `Second reminder: ${t.subjectTemplate}`, bodyTemplate: t.bodyTemplate, expectedVersion: t.version });
    await expect(updateTemplate(db, sup, t.id, { subjectTemplate: t.subjectTemplate, bodyTemplate: t.bodyTemplate, expectedVersion: t.version })).rejects.toMatchObject({ code: "CONFLICT" });
    const after = (await listTemplates(db, sup)).find((x) => x.id === t.id)!;
    expect(after.version).toBe(t.version + 1);
    expect(after.subjectTemplate.startsWith("Second reminder:")).toBe(true);
  });

  it("route, verification and failure-simulation settings all take effect on a real submission", async () => {
    const sup = await user("supervisor");
    const officer = await user("officer1");
    const draft = await db.request.findFirstOrThrow({ where: { caseId: ids.fir412Id, caseSeq: 7 } });
    const { requestApproval } = await import("@/server/services/requests");
    await requestApproval(db, officer, draft.id, draft.version);
    const req = await db.request.findUniqueOrThrow({ where: { id: draft.id } });
    const route = (await listRoutes(db, sup)).find((r) => r.id === req.routeId)!;
    await expect(updateRoute(db, sup, route.id, { approvalRole: route.approvalRole, followUpDays: 0, procedureNote: route.procedureNote, expectedUpdatedAt: route.updatedAt })).rejects.toMatchObject({ code: "VALIDATION" });
    await updateRoute(db, sup, route.id, { approvalRole: route.approvalRole, followUpDays: 9, procedureNote: route.procedureNote, expectedUpdatedAt: route.updatedAt });
    await expect(updateRoute(db, sup, route.id, { approvalRole: route.approvalRole, followUpDays: 8, procedureNote: route.procedureNote, expectedUpdatedAt: route.updatedAt })).rejects.toMatchObject({ code: "CONFLICT" });

    // An unverified recipient blocks submission.
    await setRecipientVerification(db, sup, req.recipientId, { verified: false, note: "Contact address being re-confirmed with the bank." });
    const latest = () => db.request.findUniqueOrThrow({ where: { id: req.id } });
    await approveRequest(db, sup, req.id, (await latest()).version, "Approved for submission");
    await expect(submitRequest(db, officer, req.id, { expectedVersion: (await latest()).version, confirmed: true, idempotencyKey: "settings-1" })).rejects.toThrow(/verif/i);
    await setRecipientVerification(db, sup, req.recipientId, { verified: true, note: "Re-confirmed with the bank's nodal officer by phone." });

    // A requested failure fails exactly one attempt.
    await expect(setFailureSimulation(db, officer, "EMAIL_GATEWAY", true)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(setFailureSimulation(db, sup, "PROVIDER_PORTAL", true)).rejects.toMatchObject({ code: "VALIDATION" });
    await setFailureSimulation(db, sup, "EMAIL_GATEWAY", true);
    const failed = await submitRequest(db, officer, req.id, { expectedVersion: (await latest()).version, confirmed: true, idempotencyKey: "settings-2" });
    expect(failed.outcome).toBe("FAILED");
    expect((await listIntegrations(db, sup)).find((i) => i.key === "EMAIL_GATEWAY")?.failNextSubmission).toBe(false);
    const ok = await submitRequest(db, officer, req.id, { expectedVersion: (await latest()).version, confirmed: true, idempotencyKey: "settings-3" });
    expect(ok.outcome).toBe("SUCCEEDED");

    // The edited follow-up period is used.
    const sent = await latest();
    expect(sent.status).toBe("SUBMITTED");
    expect((sent.followUpAt!.getTime() - sent.submittedAt!.getTime()) / 86_400_000).toBe(9);
  });

  it("resets the demonstration only for a supervisor who types RESET", async () => {
    const sup = await user("supervisor");
    await expect(resetDemoData(db, await user("officer1"), { confirmation: "RESET" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(resetDemoData(db, sup, { confirmation: "reset" })).rejects.toMatchObject({ code: "VALIDATION" });
    await resetDemoData(db, sup, { confirmation: "RESET" });
    expect(await db.case.count({ where: { referenceType: "FIR" } })).toBe(52);
    expect(await db.request.count({ where: { status: "DRAFT", case: { firNumber: 412 } } })).toBeGreaterThanOrEqual(3);
  }, 120000);
});
