import { describe, expect, it } from "vitest";
import { buildWorld } from "../support/fixtures";
import {
  getLedgerView,
  upsertClaim,
  recordHoldConfirmation,
  recordHoldChange,
  proposeAllocation,
  confirmAllocation,
  withdrawAllocation,
  recordRefund,
  advanceRefund,
  addManualTransaction,
} from "@/server/services/funds";
import { createDraft, requestApproval, approveRequest, submitRequest } from "@/server/services/requests";

const L = (r: number) => BigInt(r) * 100n;

async function fundsWorld() {
  const w = await buildWorld();
  const victimAcct = await w.db.entity.create({ data: { caseId: w.kase.id, kind: "BANK_ACCOUNT", label: "Victim account", value: "XXXXXXXX3390", normalizedValue: "XXXXXXXX3390", discoveredAt: new Date() } });
  const v1 = await w.db.entity.create({ data: { caseId: w.kase.id, kind: "PERSON", label: "Victim One", value: "Victim One", normalizedValue: "person:1", discoveredAt: new Date() } });
  const v2 = await w.db.entity.create({ data: { caseId: w.kase.id, kind: "PERSON", label: "Victim Two", value: "Victim Two", normalizedValue: "person:2", discoveredAt: new Date() } });
  const c1 = await upsertClaim(w.db, w.officer, w.kase.id, { victimEntityId: v1.id, lossRupees: "60,000", basis: "Complaint" });
  const c2 = await upsertClaim(w.db, w.officer, w.kase.id, { victimEntityId: v2.id, lossRupees: "40,000", basis: "Complaint" });
  await addManualTransaction(w.db, w.officer, w.kase.id, { fromEntityId: victimAcct.id, toEntityId: w.account.id, amountRupees: "60,000", occurredAt: "2026-10-03T11:00", channel: "UPI", reference: "U-1", kind: "VICTIM_PAYMENT", claimId: c1.id, sourceNote: "Victim receipt" });
  await addManualTransaction(w.db, w.officer, w.kase.id, { fromEntityId: victimAcct.id, toEntityId: w.account.id, amountRupees: "40,000", occurredAt: "2026-10-03T12:00", channel: "UPI", reference: "U-2", kind: "VICTIM_PAYMENT", claimId: c2.id, sourceNote: "Victim receipt" });
  const hold = await recordHoldConfirmation(w.db, w.officer, w.kase.id, { accountEntityId: w.account.id, amountRupees: "50,000", asOf: "2026-10-09T14:30", bankReference: "LIEN-1", note: "Bank letter" });
  return { ...w, c1, c2, hold, victimAcct };
}

describe("funds ledger", () => {
  it("rejects malformed rupee amounts with a field message", async () => {
    const w = await buildWorld();
    const v = await w.db.entity.create({ data: { caseId: w.kase.id, kind: "PERSON", label: "V", value: "V", normalizedValue: "person:z", discoveredAt: new Date() } });
    await expect(upsertClaim(w.db, w.officer, w.kase.id, { victimEntityId: v.id, lossRupees: "1,0,0", basis: "Traced from the victim payment" })).rejects.toMatchObject({ fieldErrors: { lossRupees: expect.any(String) } });
  });

  it("counts only confirmed allocations as secured", async () => {
    const w = await fundsWorld();
    const a = await proposeAllocation(w.db, w.officer, w.kase.id, { holdId: w.hold.id, claimId: w.c1.id, amountRupees: "30,000", basis: "Traced to victim one" });
    let view = await getLedgerView(w.db, w.officer, w.kase.id);
    expect(view.position.allocatedConfirmedMinor).toBe("0");
    expect(view.position.neitherReturnedNorSecuredMinor).toBe(L(100000).toString());
    await confirmAllocation(w.db, w.supervisor, a.id, { acknowledgeOverAllocation: false });
    view = await getLedgerView(w.db, w.officer, w.kase.id);
    expect(view.position.allocatedConfirmedMinor).toBe(L(30000).toString());
    expect(view.position.neitherReturnedNorSecuredMinor).toBe(L(70000).toString());
  });

  it("requires explicit acknowledgement to over-allocate and then shows needs reconciliation", async () => {
    const w = await fundsWorld();
    const a = await proposeAllocation(w.db, w.officer, w.kase.id, { holdId: w.hold.id, claimId: w.c1.id, amountRupees: "40,000", basis: "Traced from the victim payment" });
    const b = await proposeAllocation(w.db, w.officer, w.kase.id, { holdId: w.hold.id, claimId: w.c2.id, amountRupees: "20,000", basis: "Traced from the second payment" });
    await confirmAllocation(w.db, w.officer, a.id, { acknowledgeOverAllocation: false });
    await expect(confirmAllocation(w.db, w.officer, b.id, { acknowledgeOverAllocation: false })).rejects.toThrow(/exceed/i);
    await confirmAllocation(w.db, w.officer, b.id, { acknowledgeOverAllocation: true });
    const view = await getLedgerView(w.db, w.officer, w.kase.id);
    expect(view.position.reconciliation.status).toBe("NEEDS_RECONCILIATION");
    expect(view.position.neitherReturnedNorSecuredMinor).toBeNull();
    await withdrawAllocation(w.db, w.officer, b.id, "Entered in error");
    expect((await getLedgerView(w.db, w.officer, w.kase.id)).position.reconciliation.status).toBe("CONSISTENT");
  });

  it("counts a refund only when the credit is confirmed and reduces the held and allocated amounts", async () => {
    const w = await fundsWorld();
    const a = await proposeAllocation(w.db, w.officer, w.kase.id, { holdId: w.hold.id, claimId: w.c1.id, amountRupees: "40,000", basis: "Traced from the victim payment" });
    await confirmAllocation(w.db, w.officer, a.id, { acknowledgeOverAllocation: false });
    const r = await recordRefund(w.db, w.officer, w.kase.id, { claimId: w.c1.id, holdId: w.hold.id, amountRupees: "20,000", authorityReference: "ORDER-7", authorisedAt: "2026-10-25T10:00" });
    let view = await getLedgerView(w.db, w.officer, w.kase.id);
    expect(view.position.confirmedRefundsMinor).toBe("0");
    expect(view.position.refundPipeline.authorisedMinor).toBe(L(20000).toString());
    await advanceRefund(w.db, w.officer, r.id, { to: "INITIATED", at: "2026-10-27T10:00", note: "Bank initiated" });
    await advanceRefund(w.db, w.officer, r.id, { to: "CREDIT_CONFIRMED", at: "2026-10-29T10:00", note: "Credit confirmed by victim's bank" });
    view = await getLedgerView(w.db, w.officer, w.kase.id);
    expect(view.position.confirmedRefundsMinor).toBe(L(20000).toString());
    expect(view.position.confirmedHeldMinor).toBe(L(30000).toString());
    expect(view.position.outstandingLossMinor).toBe(L(80000).toString());
    const v1 = view.position.perClaim.find((c) => c.claimId === w.c1.id)!;
    expect(v1).toMatchObject({ outstandingMinor: L(40000).toString(), allocatedMinor: L(20000).toString(), neitherMinor: L(20000).toString() });
    const events = await w.db.holdEvent.findMany({ where: { holdId: w.hold.id }, orderBy: { recordedAt: "asc" } });
    expect(events.at(-1)).toMatchObject({ type: "RELEASED_TO_VICTIM", amountMinor: L(30000), previousAmountMinor: L(50000) });
  });

  it("refuses refund stages out of order", async () => {
    const w = await fundsWorld();
    const r = await recordRefund(w.db, w.officer, w.kase.id, { claimId: w.c1.id, holdId: null, amountRupees: "1,000", authorityReference: "ORDER-8", authorisedAt: "2026-10-25T10:00" });
    await expect(advanceRefund(w.db, w.officer, r.id, { to: "CREDIT_CONFIRMED", at: "2026-10-26T10:00", note: "skip" })).rejects.toThrow(/initiated/i);
  });

  it("flags allocations still recorded against a released hold", async () => {
    const w = await fundsWorld();
    const a = await proposeAllocation(w.db, w.officer, w.kase.id, { holdId: w.hold.id, claimId: w.c1.id, amountRupees: "10,000", basis: "Traced from the victim payment" });
    await confirmAllocation(w.db, w.officer, a.id, { acknowledgeOverAllocation: false });
    await recordHoldChange(w.db, w.officer, w.hold.id, { type: "RELEASED", amountRupees: null, at: "2026-11-01T10:00", note: "Bank released the lien" });
    const view = await getLedgerView(w.db, w.officer, w.kase.id);
    expect(view.position.reconciliation.issues.map((i) => i.code)).toContain("ALLOCATION_ON_UNCONFIRMED_HOLD");
  });

  it("records 'hold requested' when a hold request is submitted, without inventing an amount held", async () => {
    const w = await fundsWorld();
    const other = await w.db.entity.create({ data: { caseId: w.kase.id, kind: "BANK_ACCOUNT", label: "Account Z", value: "XXXXXXXX9999", normalizedValue: "XXXXXXXX9999", attributesJson: JSON.stringify({ bank: "Demo Bank A" }), discoveredAt: new Date() } });
    await addManualTransaction(w.db, w.officer, w.kase.id, { fromEntityId: w.account.id, toEntityId: other.id, amountRupees: "25,000", occurredAt: "2026-10-04T10:00", channel: "IMPS", reference: "U-9", kind: "ONWARD_TRANSFER", claimId: null, sourceNote: "Statement" });
    const d = await createDraft(w.db, w.officer, { caseId: w.kase.id, category: "HOLD", recipientId: w.recipient.id, subject: "Freeze Account Z", body: "Please freeze the account and confirm the amount held.", scope: "Freeze", periodFrom: null, periodTo: null, items: [{ label: "Hold", itemType: "HOLD_CONFIRMATION" }], subjectEntityIds: [other.id] });
    const a = await requestApproval(w.db, w.officer, d.id, d.version);
    const ap = await approveRequest(w.db, w.supervisor, d.id, a.version, null);
    await submitRequest(w.db, w.officer, d.id, { expectedVersion: ap.version, confirmed: true, idempotencyKey: "h1" });
    const hold = await w.db.hold.findFirstOrThrow({ where: { caseId: w.kase.id, accountEntityId: other.id } });
    expect(hold).toMatchObject({ status: "REQUESTED", requestedAmountMinor: L(25000), confirmedAmountMinor: null });
    const view = await getLedgerView(w.db, w.officer, w.kase.id);
    expect(view.position.unknownHoldCount).toBe(1);
  });

  it("refuses ledger access to unassigned officers", async () => {
    const w = await fundsWorld();
    await expect(getLedgerView(w.db, w.outsider, w.kase.id)).rejects.toThrow(/do not have access/);
  });
});
