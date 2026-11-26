import { describe, expect, it } from "vitest";
import { buildWorld } from "../support/fixtures";
import { autoDraftRequests } from "@/server/services/auto-draft";
import { refreshRecommendations } from "@/server/services/tasks";
import { addManualTransaction, upsertClaim } from "@/server/services/funds";
import { now } from "@/server/clock";

/** A case where recording one victim payment makes the rules propose bank requests for the receiving account. */
async function world() {
  const w = await buildWorld();
  const db = w.db;
  await db.routingRule.deleteMany({});
  await db.routingRule.create({ data: { name: "Bank accounts: information", subjectKind: "BANK_ACCOUNT", category: "INFORMATION", resolveBy: "ACCOUNT_BANK", approvalRole: "SUPERVISOR", followUpDays: 7, procedureNote: "Department procedure (demo)" } });
  await db.routingRule.create({ data: { name: "Bank accounts: hold", subjectKind: "BANK_ACCOUNT", category: "HOLD", resolveBy: "ACCOUNT_BANK", approvalRole: "SUPERVISOR", followUpDays: 5, procedureNote: "Department procedure (demo)" } });
  const victimAcct = await db.entity.create({ data: { caseId: w.kase.id, kind: "BANK_ACCOUNT", label: "Victim account", value: "XXXXXXXX3390", normalizedValue: "XXXXXXXX3390", discoveredAt: new Date() } });
  const victim = await db.entity.create({ data: { caseId: w.kase.id, kind: "PERSON", label: "Victim", value: "Victim", normalizedValue: "person:auto", discoveredAt: new Date() } });
  const claim = await upsertClaim(db, w.officer, w.kase.id, { victimEntityId: victim.id, lossRupees: "10,00,000", basis: "Complaint" });
  const recordPayment = () => addManualTransaction(db, w.officer, w.kase.id, { fromEntityId: victimAcct.id, toEntityId: w.account.id, amountRupees: "10,00,000", occurredAt: "2026-10-03T11:42", channel: "IMPS", reference: "DEMOUTR0001", kind: "VICTIM_PAYMENT", claimId: claim.id, sourceNote: "FIR" });
  const openRequestTasks = () => db.task.findMany({ where: { caseId: w.kase.id, generatedBy: "RULE", requestCategory: { not: null }, status: "OPEN" } });
  return { ...w, recordPayment, openRequestTasks };
}

describe("autoDraftRequests", () => {
  it("drafts the requests that newly proposed next actions call for, and sends nothing", async () => {
    const w = await world();
    const since = now();
    await w.recordPayment();
    const proposed = await w.openRequestTasks();
    expect(proposed.length).toBeGreaterThan(0);

    const result = await autoDraftRequests(w.db, w.officer, w.kase.id, { since });

    expect(result.drafted.map((d) => d.taskId).sort()).toEqual(proposed.map((t) => t.id).sort());
    const requests = await w.db.request.findMany({ where: { caseId: w.kase.id } });
    expect(requests).toHaveLength(proposed.length);
    expect(requests.every((r) => r.status === "DRAFT")).toBe(true);
    expect(await w.db.submission.count()).toBe(0);
    for (const t of proposed) {
      expect(await w.db.task.findUniqueOrThrow({ where: { id: t.id } })).toMatchObject({ status: "DRAFT_PREPARED" });
    }
    const audit = await w.db.auditEvent.findFirstOrThrow({ where: { caseId: w.kase.id, action: "request.auto_drafted" } });
    expect(audit.actorId).toBe(w.officer.id);
    expect(audit.summary).toContain("nothing was sent");
  });

  it("leaves next actions proposed before the officer's action for the officer to draft", async () => {
    const w = await world();
    await w.recordPayment();
    await refreshRecommendations(w.db, w.officer, w.kase.id);
    const later = new Date(now().getTime() + 60_000);

    const result = await autoDraftRequests(w.db, w.officer, w.kase.id, { since: later });

    expect(result.drafted).toEqual([]);
    expect(await w.db.request.count({ where: { caseId: w.kase.id } })).toBe(0);
    expect(await w.db.auditEvent.count({ where: { caseId: w.kase.id, action: "request.auto_drafted" } })).toBe(0);
  });

  it("skips a proposal that has no route, keeps it open and says why", async () => {
    const w = await world();
    await w.db.routingRule.deleteMany({ where: { category: "HOLD" } });
    const since = now();
    await w.recordPayment();

    const result = await autoDraftRequests(w.db, w.officer, w.kase.id, { since });

    expect(result.skipped.length).toBeGreaterThan(0);
    expect(result.skipped[0]!.reason).toMatch(/No recipient is set up for hold requests about a bank account/);
    const skippedTask = await w.db.task.findUniqueOrThrow({ where: { id: result.skipped[0]!.taskId } });
    expect(skippedTask).toMatchObject({ status: "OPEN", requestId: null });
    expect(result.drafted.length).toBeGreaterThan(0);
  });

  it("does not draft twice when it runs again", async () => {
    const w = await world();
    const since = now();
    await w.recordPayment();
    const first = await autoDraftRequests(w.db, w.officer, w.kase.id, { since });
    const second = await autoDraftRequests(w.db, w.officer, w.kase.id, { since });
    expect(second.drafted).toEqual([]);
    expect(await w.db.request.count({ where: { caseId: w.kase.id } })).toBe(first.drafted.length);
  });
});

describe("drafts prepared by the assistant", () => {
  it("are authored by the station's assistant identity, so the investigating officer can approve them", async () => {
    const w = await world();
    const assistant = await w.db.user.create({ data: { username: `assistant-${w.station.id}`, displayName: "Assistant", rank: "System", role: "SYSTEM", stationId: w.station.id, passwordHash: "!", active: false } });
    await w.db.routingRule.updateMany({ data: { approvalRole: "INVESTIGATING_OFFICER" } });
    const since = now();
    await w.recordPayment();

    const result = await autoDraftRequests(w.db, w.officer, w.kase.id, { since });

    const first = await w.db.request.findUniqueOrThrow({ where: { id: result.drafted[0]!.requestId }, include: { versions: true } });
    expect(first.createdById).toBe(assistant.id);
    expect(first.versions[0]!.createdById).toBe(assistant.id);
    const { requestApproval, approveRequest } = await import("@/server/services/requests");
    const pending = await requestApproval(w.db, w.officer, first.id, first.version);
    const approved = await approveRequest(w.db, w.officer, first.id, pending.version, "Checked against the case.");
    expect(approved.status).toBe("APPROVED");
  });

  it("still cannot be approved by the officer once the officer has rewritten them", async () => {
    const w = await world();
    await w.db.user.create({ data: { username: `assistant-${w.station.id}`, displayName: "Assistant", rank: "System", role: "SYSTEM", stationId: w.station.id, passwordHash: "!", active: false } });
    await w.db.routingRule.updateMany({ data: { approvalRole: "INVESTIGATING_OFFICER" } });
    const since = now();
    await w.recordPayment();
    const result = await autoDraftRequests(w.db, w.officer, w.kase.id, { since });
    const { updateDraft, requestApproval, approveRequest, getRequestState } = await import("@/server/services/requests");
    const id = result.drafted[0]!.requestId;
    const v = await w.db.requestVersion.findFirstOrThrow({ where: { requestId: id } });
    const r = await w.db.request.findUniqueOrThrow({ where: { id }, include: { items: true } });
    await updateDraft(w.db, w.officer, id, { expectedVersion: r.version, recipientId: v.recipientId, subject: v.subject, body: `${v.body}\n\nAdded by the officer.`, scope: v.scope, periodFrom: v.periodFrom, periodTo: v.periodTo, items: r.items.map((i) => ({ label: i.label, itemType: i.itemType })), attachmentIds: [] });
    const state = await w.db.$transaction((tx) => getRequestState(tx, id));
    const pending = await requestApproval(w.db, w.officer, id, state.version);
    await expect(approveRequest(w.db, w.officer, id, pending.version, null)).rejects.toThrow(/You prepared this version/);
  });
});

describe("what the assistant leaves for the officer", () => {
  it("does not pre-draft low-priority requests", async () => {
    const w = await world();
    const since = now();
    await w.recordPayment();
    const t = (await w.openRequestTasks())[0]!;
    await w.db.task.update({ where: { id: t.id }, data: { priority: "LOW" } });
    const result = await autoDraftRequests(w.db, w.officer, w.kase.id, { since });
    expect(result.drafted.map((d) => d.taskId)).not.toContain(t.id);
  });
});
