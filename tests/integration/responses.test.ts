import { describe, expect, it } from "vitest";
import { buildWorld } from "../support/fixtures";
import { createDraft, requestApproval, approveRequest, submitRequest } from "@/server/services/requests";
import { importResponse, decideFinding, applyResponse, confirmResponseMatch, type IncomingMessage } from "@/server/services/responses";
import { istInputToUtc } from "@/domain/time";

const L = (r: number) => BigInt(r) * 100n;

/** World with a submitted information request to Bank B about Account B, which received ₹6,00,000 from the victim. */
async function bankBWorld() {
  const w = await buildWorld();
  const db = w.db;
  const bankB = await db.recipient.create({
    data: { name: "Demo Bank B nodal officer", organisation: "Demo Bank B", organisationType: "BANK", channel: "EMAIL", address: "nodal@bank-b.example.invalid", verificationStatus: "VERIFIED", categoriesJson: JSON.stringify(["INFORMATION", "HOLD"]) },
  });
  const victimAcct = await db.entity.create({ data: { caseId: w.kase.id, kind: "BANK_ACCOUNT", label: "Victim account", value: "XXXXXXXX3390", normalizedValue: "XXXXXXXX3390", discoveredAt: new Date() } });
  const acctB = await db.entity.create({ data: { caseId: w.kase.id, kind: "BANK_ACCOUNT", label: "Account B", value: "XXXXXXXX0937", normalizedValue: "XXXXXXXX0937", attributesJson: JSON.stringify({ bank: "Demo Bank B" }), discoveredAt: new Date() } });
  const victim = await db.entity.create({ data: { caseId: w.kase.id, kind: "PERSON", label: "Victim", value: "Victim", normalizedValue: "person:v", discoveredAt: new Date() } });
  const claim = await db.victimClaim.create({ data: { caseId: w.kase.id, victimEntityId: victim.id, lossAmountMinor: L(600000), basis: "test" } });
  const t2 = await db.transaction.create({
    data: { caseId: w.kase.id, fromEntityId: victimAcct.id, toEntityId: acctB.id, amountMinor: L(600000), occurredAt: istInputToUtc("2026-10-04T15:10")!, channel: "NEFT", reference: "DEMOUTR0002", kind: "VICTIM_PAYMENT", layer: 1, claimId: claim.id, status: "REPORTED_BY_VICTIM", discoveredAt: new Date(), dedupeKey: "REF:DEMOUTR0002" },
  });
  const draft = await createDraft(db, w.officer, {
    caseId: w.kase.id,
    category: "INFORMATION",
    recipientId: bankB.id,
    subject: "Statement, KYC and balance: Account XXXXXXXX0937",
    body: "Please provide the statement, KYC and current balance for the account.",
    scope: "Statement, KYC, balance",
    periodFrom: istInputToUtc("2026-10-02T00:00"),
    periodTo: istInputToUtc("2026-10-18T23:59"),
    items: [
      { label: "Statement of account", itemType: "STATEMENT" },
      { label: "KYC details", itemType: "KYC" },
      { label: "Current balance and lien status", itemType: "BALANCE_CONFIRMATION" },
    ],
    subjectEntityIds: [acctB.id],
  });
  const a = await requestApproval(db, w.officer, draft.id, draft.version);
  const ap = await approveRequest(db, w.supervisor, draft.id, a.version, null);
  await submitRequest(db, w.officer, draft.id, { expectedVersion: ap.version, confirmed: true, idempotencyKey: `sub-${draft.id}` });
  return { ...w, bankB, acctB, victimAcct, claim, t2, request: await db.request.findUniqueOrThrow({ where: { id: draft.id } }) };
}

function partialMessage(reference: string): IncomingMessage {
  return {
    fromAddress: "nodal@bank-b.example.invalid",
    toAddress: "io@police.example.invalid",
    subject: `RE: ${reference} Statement request`,
    receivedAt: istInputToUtc("2026-10-21T16:40")!,
    bodyText: `With reference to ${reference}, please find attached the statement extract for a/c XXXXXXXX0937 for 04-10-2026 to 06-10-2026.\nKYC documents and current balance / lien status will be furnished separately.`,
    channel: "EMAIL",
    attachments: [
      {
        fileName: "BankB_statement_extract_XXXX0937.csv",
        buffer: Buffer.from(
          [
            "Txn Date,Description,Debit,Credit,UTR/RRN,Counterparty A/c,Counterparty IFSC,Counterparty Bank",
            '04-10-2026 15:10,NEFT inward,,"6,00,000.00",DEMOUTR0002,XXXXXXXX3390,DEMV0000001,Demo Bank V',
            '04-10-2026 16:02,IMPS outward,"4,00,000.00",,DEMOUTR0201,XXXXXXXX0068,DEME0003333,Demo Bank E',
          ].join("\n"),
        ),
      },
    ],
  };
}

async function acceptAll(w: Awaited<ReturnType<typeof bankBWorld>>, responseId: string) {
  const findings = await w.db.responseFinding.findMany({ where: { responseId } });
  for (const f of findings) await decideFinding(w.db, w.officer, f.id, { decision: "ACCEPTED" });
  return findings;
}

describe("importResponse", () => {
  it("matches by quoted reference and classifies each result", async () => {
    const w = await bankBWorld();
    const res = await importResponse(w.db, partialMessage(w.request.reference), { actorId: w.officer.id, actor: w.officer, caseId: w.kase.id });
    expect(res).toMatchObject({ status: "IMPORTED", matchStatus: "MATCHED" });
    const findings = await w.db.responseFinding.findMany({ where: { responseId: res.responseId }, orderBy: { sortOrder: "asc" } });
    const byType = (t: string) => findings.filter((f) => f.findingType === t);
    expect(byType("TRANSACTION").map((f) => f.classification).sort()).toEqual(["ALREADY_KNOWN", "NEW"]);
    expect(byType("BALANCE_UNCONFIRMED")[0]?.summary).toContain("₹2,00,000");
    expect(byType("ITEM_NOT_PROVIDED").map((f) => f.summary)).toEqual(
      expect.arrayContaining(["Statement covers only part of the requested period", "KYC details not provided"]),
    );
    const response = await w.db.response.findUniqueOrThrow({ where: { id: res.responseId } });
    expect(response.suggestedType).toBe("PARTIAL");
    expect(response.reviewStatus).toBe("UNREVIEWED");
  });

  it("detects a duplicate import and creates nothing new", async () => {
    const w = await bankBWorld();
    const first = await importResponse(w.db, partialMessage(w.request.reference), { actorId: w.officer.id, actor: w.officer, caseId: w.kase.id });
    const evidenceBefore = await w.db.evidenceItem.count({ where: { caseId: w.kase.id } });
    const second = await importResponse(w.db, partialMessage(w.request.reference), { actorId: w.officer.id, actor: w.officer, caseId: w.kase.id });
    expect(second).toMatchObject({ status: "DUPLICATE", responseId: first.responseId });
    expect(await w.db.response.count({ where: { caseId: w.kase.id } })).toBe(1);
    expect(await w.db.evidenceItem.count({ where: { caseId: w.kase.id } })).toBe(evidenceBefore);
  });

  it("does not change any financial record on receipt", async () => {
    const w = await bankBWorld();
    await importResponse(w.db, partialMessage(w.request.reference), { actorId: w.officer.id, actor: w.officer, caseId: w.kase.id });
    expect(await w.db.transaction.count({ where: { caseId: w.kase.id } })).toBe(1);
    expect(await w.db.hold.count({ where: { caseId: w.kase.id, status: "CONFIRMED_HELD" } })).toBe(0);
  });

  it("queues messages without a reference for match review instead of guessing", async () => {
    const w = await bankBWorld();
    const msg = { ...partialMessage("none"), subject: "Reg: your letter", bodyText: "Your request is under process.", attachments: [] };
    const res = await importResponse(w.db, msg, { actorId: w.officer.id, actor: w.officer, caseId: w.kase.id });
    expect(res.matchStatus).toBe("NEEDS_MATCH_REVIEW");
    const r = await w.db.response.findUniqueOrThrow({ where: { id: res.responseId } });
    expect(r.matchBasis).toMatch(/No request reference/);
    await expect(applyResponse(w.db, w.officer, res.responseId, { responseType: "ACKNOWLEDGEMENT", expectedVersion: r.version })).rejects.toThrow(/Confirm which request/);
    const matched = await confirmResponseMatch(w.db, w.officer, res.responseId, w.request.id);
    expect(matched.matchStatus).toBe("MATCHED");
  });
});

describe("applyResponse", () => {
  it("adds the new account and onward transfer, keeps the request open and proposes a follow-up", async () => {
    const w = await bankBWorld();
    const res = await importResponse(w.db, partialMessage(w.request.reference), { actorId: w.officer.id, actor: w.officer, caseId: w.kase.id });
    await acceptAll(w, res.responseId);
    const r = await w.db.response.findUniqueOrThrow({ where: { id: res.responseId } });
    const out = await applyResponse(w.db, w.officer, res.responseId, { responseType: "PARTIAL", expectedVersion: r.version });

    expect(out.requestStatus).toBe("PARTIAL_RESPONSE");
    const e = await w.db.entity.findFirst({ where: { caseId: w.kase.id, normalizedValue: "XXXXXXXX0068" } });
    expect(e?.label).toBe("Account C"); // next letter after Account A / Account B in this world
    const onward = await w.db.transaction.findFirst({ where: { caseId: w.kase.id, toEntityId: e!.id } });
    expect(onward).toMatchObject({ amountMinor: L(400000), layer: 2, status: "CONFIRMED_BY_BANK" });
    const t2 = await w.db.transaction.findUniqueOrThrow({ where: { id: w.t2.id } });
    expect(t2.status).toBe("CONFIRMED_BY_BANK");

    const items = await w.db.requestItem.findMany({ where: { requestId: w.request.id } });
    const status = Object.fromEntries(items.map((i) => [i.itemType, i.status]));
    expect(status).toEqual({ STATEMENT: "PARTIAL", KYC: "PENDING", BALANCE_CONFIRMATION: "PENDING" });

    const followUp = await w.db.request.findUniqueOrThrow({ where: { id: out.followUpRequestId! } });
    expect(followUp).toMatchObject({ status: "DRAFT", parentRequestId: w.request.id });

    const balanceTask = await w.db.task.findFirst({ where: { caseId: w.kase.id, dedupeKey: `BALANCE:${w.acctB.id}` } });
    expect(balanceTask?.kind).toBe("MISSING_INFORMATION");
    expect(["OPEN", "WAITING", "DRAFT_PREPARED"]).toContain(balanceTask?.status);

    expect(await w.db.hold.count({ where: { caseId: w.kase.id, status: "CONFIRMED_HELD" } })).toBe(0);
    expect(await w.db.refund.count({ where: { caseId: w.kase.id } })).toBe(0);
  });

  it("is idempotent: applying the same response again creates nothing", async () => {
    const w = await bankBWorld();
    const res = await importResponse(w.db, partialMessage(w.request.reference), { actorId: w.officer.id, actor: w.officer, caseId: w.kase.id });
    await acceptAll(w, res.responseId);
    const r1 = await w.db.response.findUniqueOrThrow({ where: { id: res.responseId } });
    await applyResponse(w.db, w.officer, res.responseId, { responseType: "PARTIAL", expectedVersion: r1.version });
    const counts = async () => ({
      tx: await w.db.transaction.count({ where: { caseId: w.kase.id } }),
      ent: await w.db.entity.count({ where: { caseId: w.kase.id } }),
      req: await w.db.request.count({ where: { caseId: w.kase.id } }),
      src: await w.db.sourceAssertion.count({ where: { caseId: w.kase.id } }),
    });
    const before = await counts();
    const r2 = await w.db.response.findUniqueOrThrow({ where: { id: res.responseId } });
    const again = await applyResponse(w.db, w.officer, res.responseId, { responseType: "PARTIAL", expectedVersion: r2.version });
    expect(again.applied).toBe(0);
    expect(await counts()).toEqual(before);
  });

  it("records rejected results without applying them and requires a reason", async () => {
    const w = await bankBWorld();
    const res = await importResponse(w.db, partialMessage(w.request.reference), { actorId: w.officer.id, actor: w.officer, caseId: w.kase.id });
    const newTx = (await w.db.responseFinding.findMany({ where: { responseId: res.responseId, findingType: "TRANSACTION", classification: "NEW" } }))[0]!;
    await expect(decideFinding(w.db, w.officer, newTx.id, { decision: "REJECTED" })).rejects.toThrow(/reason/i);
    await decideFinding(w.db, w.officer, newTx.id, { decision: "REJECTED", reason: "Not related to this case" });
    const r = await w.db.response.findUniqueOrThrow({ where: { id: res.responseId } });
    await applyResponse(w.db, w.officer, res.responseId, { responseType: "PARTIAL", expectedVersion: r.version });
    expect(await w.db.entity.findFirst({ where: { caseId: w.kase.id, normalizedValue: "XXXXXXXX0068" } })).toBeNull();
  });

  it("refuses access to officers not assigned to the case", async () => {
    const w = await bankBWorld();
    const res = await importResponse(w.db, partialMessage(w.request.reference), { actorId: w.officer.id, actor: w.officer, caseId: w.kase.id });
    const f = (await w.db.responseFinding.findMany({ where: { responseId: res.responseId } }))[0]!;
    await expect(decideFinding(w.db, w.outsider, f.id, { decision: "ACCEPTED" })).rejects.toThrow(/do not have access/);
  });
});
