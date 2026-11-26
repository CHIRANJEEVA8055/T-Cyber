import { describe, expect, it } from "vitest";
import { buildWorld } from "../support/fixtures";
import { prepareDraftFromTask } from "@/server/services/drafting";
import { refreshRecommendations } from "@/server/services/tasks";
import { addManualTransaction, upsertClaim } from "@/server/services/funds";
import { createDraft, requestApproval, approveRequest, submitRequest } from "@/server/services/requests";
import { formatDateTimeIST } from "@/domain/time";

async function draftingWorld() {
  const w = await buildWorld();
  const db = w.db;
  await db.routingRule.deleteMany({});
  const tpl = await db.template.create({
    data: {
      name: "Bank information request",
      category: "INFORMATION_BANK",
      subjectTemplate: "Statement and KYC: {{subjectValue}} ({{caseReference}})",
      bodyTemplate: "To the nodal officer, {{bank}}\n\nReference {{requestReference}}.\nCredits:\n{{transactions}}\n\nPlease provide:\n{{items}}\nPeriod: {{periodFrom}} to {{periodTo}}\n\n{{officerName}}, {{officerRank}}",
    },
  });
  await db.routingRule.create({ data: { name: "Bank accounts: information", subjectKind: "BANK_ACCOUNT", category: "INFORMATION", resolveBy: "ACCOUNT_BANK", templateId: tpl.id, approvalRole: "SUPERVISOR", followUpDays: 7, procedureNote: "Department procedure (demo)" } });
  await db.routingRule.create({ data: { name: "Bank accounts: hold", subjectKind: "BANK_ACCOUNT", category: "HOLD", resolveBy: "ACCOUNT_BANK", approvalRole: "SUPERVISOR", followUpDays: 5, procedureNote: "Department procedure (demo)" } });
  const victimAcct = await db.entity.create({ data: { caseId: w.kase.id, kind: "BANK_ACCOUNT", label: "Victim account", value: "XXXXXXXX3390", normalizedValue: "XXXXXXXX3390", discoveredAt: new Date() } });
  const victim = await db.entity.create({ data: { caseId: w.kase.id, kind: "PERSON", label: "Victim", value: "Victim", normalizedValue: "person:d", discoveredAt: new Date() } });
  const claim = await upsertClaim(db, w.officer, w.kase.id, { victimEntityId: victim.id, lossRupees: "10,00,000", basis: "Complaint" });
  await addManualTransaction(db, w.officer, w.kase.id, { fromEntityId: victimAcct.id, toEntityId: w.account.id, amountRupees: "10,00,000", occurredAt: "2026-10-03T11:42", channel: "IMPS", reference: "DEMOUTR0001", kind: "VICTIM_PAYMENT", claimId: claim.id, sourceNote: "FIR" });
  await refreshRecommendations(db, w.officer, w.kase.id);
  const task = (key: string) => db.task.findFirstOrThrow({ where: { caseId: w.kase.id, dedupeKey: key } });
  return { ...w, task };
}

describe("prepareDraftFromTask", () => {
  it("routes to the account's own bank and fills the template with case facts", async () => {
    const w = await draftingWorld();
    const t = await w.task(`INFO:${w.account.id}`);
    const req = await prepareDraftFromTask(w.db, w.officer, t.id);
    expect(req.recipientId).toBe(w.recipient.id);
    expect(req.subject).toBe("Statement and KYC: XXXXXXXX4821 (FIR " + `${w.kase.firNumber}/2026)`);
    expect(req.body).toContain(`Reference ${req.reference}.`);
    expect(req.body).toContain(`${formatDateTimeIST(new Date("2026-10-03T06:12:00Z"))}: ₹10,00,000 (ref DEMOUTR0001)`);
    expect(req.body).not.toMatch(/not available\]|\{\{/);
    const items = await w.db.requestItem.findMany({ where: { requestId: req.id }, orderBy: { sortOrder: "asc" } });
    expect(items.map((i) => i.itemType)).toEqual(["STATEMENT", "KYC", "BALANCE_CONFIRMATION", "LINKED_CONTACTS"]);
    const v = await w.db.requestVersion.findFirstOrThrow({ where: { requestId: req.id } });
    expect(v.periodFrom?.toISOString()).toBe("2026-09-30T18:30:00.000Z"); // 01 Oct 2026 00:00 IST
    const task = await w.task(`INFO:${w.account.id}`);
    expect(task).toMatchObject({ status: "DRAFT_PREPARED", requestId: req.id });
  });

  it("attaches the case's FIR copy, and says it is attached only when there is one", async () => {
    const w = await draftingWorld();
    await w.db.template.updateMany({ where: { category: "INFORMATION_BANK" }, data: { bodyTemplate: "To {{bank}}\n\nPlease provide:\n{{items}}\n\n{{firCopyNote}}Kindly reply quoting {{requestReference}}." } });
    const t = await w.task(`INFO:${w.account.id}`);
    const without = await prepareDraftFromTask(w.db, w.officer, t.id);
    expect(without.body).not.toContain("FIR copy attached");
    const v1 = await w.db.requestVersion.findFirstOrThrow({ where: { requestId: without.id } });
    expect(JSON.parse(v1.attachmentIdsJson)).toEqual([]);

    const w2 = await draftingWorld();
    await w2.db.template.updateMany({ where: { category: "INFORMATION_BANK" }, data: { bodyTemplate: "To {{bank}}\n\nPlease provide:\n{{items}}\n\n{{firCopyNote}}Kindly reply quoting {{requestReference}}." } });
    const fir = await w2.db.evidenceItem.create({ data: { caseId: w2.kase.id, title: "FIR copy", category: "FIR_COPY", fileName: "FIR.pdf", mimeType: "application/pdf", sizeBytes: 10, sha256: "0".repeat(64), storageKey: "x/fir.pdf", sourceDescription: "Station copy", receivedAt: new Date(), uploadedById: w2.officer.id } });
    const t2 = await w2.task(`INFO:${w2.account.id}`);
    const withFir = await prepareDraftFromTask(w2.db, w2.officer, t2.id);
    expect(withFir.body).toContain("Signed FIR copy attached. Kindly reply");
    const v2 = await w2.db.requestVersion.findFirstOrThrow({ where: { requestId: withFir.id } });
    expect(JSON.parse(v2.attachmentIdsJson)).toEqual([fir.id]);
  });

  it("returns the existing draft instead of creating a duplicate", async () => {
    const w = await draftingWorld();
    const t = await w.task(`INFO:${w.account.id}`);
    const first = await prepareDraftFromTask(w.db, w.officer, t.id);
    const second = await prepareDraftFromTask(w.db, w.officer, t.id);
    expect(second.id).toBe(first.id);
    expect(await w.db.request.count({ where: { caseId: w.kase.id } })).toBe(1);
  });

  it("explains when no route is configured", async () => {
    const w = await draftingWorld();
    await w.db.routingRule.deleteMany({ where: { category: "HOLD" } });
    const t = await w.task(`HOLD:${w.account.id}`);
    await expect(prepareDraftFromTask(w.db, w.officer, t.id)).rejects.toThrow(/No recipient is set up for hold requests about a bank account/);
    // Asked to, it is drafted with the addressee left blank instead.
    const r = await prepareDraftFromTask(w.db, w.officer, t.id, { withoutAddressee: true });
    expect(r.body).toMatch(/To the Nodal Officer, \[[^\]]+, whose address is not set up: to be filled in\]/);
  });

  it("turns a follow-up recommendation into a follow-up draft for the outstanding items", async () => {
    const w = await draftingWorld();
    const d = await createDraft(w.db, w.officer, { caseId: w.kase.id, category: "HOLD", recipientId: w.recipient.id, subject: "Freeze Account A", body: "Please freeze the account and confirm the amount held.", scope: "Freeze", periodFrom: null, periodTo: null, items: [{ label: "Hold confirmation", itemType: "HOLD_CONFIRMATION" }], subjectEntityIds: [w.account.id] });
    const a = await requestApproval(w.db, w.officer, d.id, d.version);
    const ap = await approveRequest(w.db, w.supervisor, d.id, a.version, null);
    await submitRequest(w.db, w.officer, d.id, { expectedVersion: ap.version, confirmed: true, idempotencyKey: "fu-1" });
    await w.db.request.update({ where: { id: d.id }, data: { followUpAt: new Date("2026-01-01T00:00:00Z") } });
    await refreshRecommendations(w.db, w.officer, w.kase.id);
    const t = await w.task(`FOLLOWUP:${d.id}`);
    const fu = await prepareDraftFromTask(w.db, w.officer, t.id);
    expect(fu.parentRequestId).toBe(d.id);
    expect(fu.subject).toContain(d.reference);
    const items = await w.db.requestItem.findMany({ where: { requestId: fu.id } });
    expect(items.map((i) => i.itemType)).toEqual(["HOLD_CONFIRMATION"]);
  });
});
