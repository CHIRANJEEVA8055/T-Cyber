import { describe, expect, it } from "vitest";
import { buildWorld } from "../support/fixtures";
import { createDraft, requestApproval, approveRequest, submitRequest, recordPortalSubmission } from "@/server/services/requests";
import { importResponse, decideFinding, applyResponse, type IncomingMessage } from "@/server/services/responses";
import { istInputToUtc } from "@/domain/time";

const L = (r: number) => BigInt(r) * 100n;
const ist = (v: string) => istInputToUtc(v)!;

type World = Awaited<ReturnType<typeof buildWorld>>;

async function send(w: World, input: Parameters<typeof createDraft>[2]) {
  const draft = await createDraft(w.db, w.officer, input);
  const a = await requestApproval(w.db, w.officer, draft.id, draft.version);
  const ap = await approveRequest(w.db, w.supervisor, draft.id, a.version, null);
  const recipient = await w.db.recipient.findUniqueOrThrow({ where: { id: input.recipientId } });
  if (recipient.channel === "PORTAL") await recordPortalSubmission(w.db, w.officer, draft.id, { expectedVersion: ap.version, confirmed: true, portalReference: `PORTAL-${draft.id.slice(-6)}` });
  else await submitRequest(w.db, w.officer, draft.id, { expectedVersion: ap.version, confirmed: true, idempotencyKey: `sub-${draft.id}` });
  return w.db.request.findUniqueOrThrow({ where: { id: draft.id } });
}

/** Account A (Bank A) received ₹60,000 from Victim 1 (UPI ref known) and ₹40,000 from Victim 2 (reference partly unreadable). */
async function accountAWorld() {
  const w = await buildWorld();
  const db = w.db;
  const mk = (kind: string, label: string, value: string, attributes: Record<string, unknown> = {}) =>
    db.entity.create({ data: { caseId: w.kase.id, kind, label, value, normalizedValue: value, attributesJson: JSON.stringify(attributes), discoveredAt: new Date() } });
  const v1 = await mk("PERSON", "Victim 1", "person:v1");
  const v2 = await mk("PERSON", "Victim 2", "person:v2");
  const v1Acct = await mk("BANK_ACCOUNT", "Victim 1 account", "XXXXXXXXXXXX0019");
  const v2Acct = await mk("BANK_ACCOUNT", "Victim 2 account", "XXXXXXXXXXXX0027");
  const c1 = await db.victimClaim.create({ data: { caseId: w.kase.id, victimEntityId: v1.id, lossAmountMinor: L(60000), basis: "FIR" } });
  const c2 = await db.victimClaim.create({ data: { caseId: w.kase.id, victimEntityId: v2.id, lossAmountMinor: L(40000), basis: "FIR" } });
  const pay = (from: string, amount: number, at: string, reference: string, claimId: string) =>
    db.transaction.create({
      data: { caseId: w.kase.id, fromEntityId: from, toEntityId: w.account.id, amountMinor: L(amount), occurredAt: ist(at), channel: "UPI", reference, kind: "VICTIM_PAYMENT", layer: 1, claimId, status: "REPORTED_BY_VICTIM", discoveredAt: new Date(), dedupeKey: `REF:${reference}` },
    });
  const t1 = await pay(v1Acct.id, 60000, "2026-11-02T10:42", "630100000214", c1.id);
  const t2 = await pay(v2Acct.id, 40000, "2026-11-02T00:00", "6301000?08?7", c2.id);
  const request = await send(w, {
    caseId: w.kase.id,
    category: "HOLD",
    recipientId: w.recipient.id,
    subject: "Account A: statement, KYC and hold",
    body: "Please freeze debits and provide the statement and KYC.",
    scope: "Statement, KYC, hold",
    periodFrom: ist("2026-10-25T00:00"),
    periodTo: ist("2026-11-08T23:59"),
    items: [
      { label: "Statement of account", itemType: "STATEMENT" },
      { label: "KYC details", itemType: "KYC" },
      { label: "Confirmation of debit freeze and the amount held", itemType: "HOLD_CONFIRMATION" },
    ],
    subjectEntityIds: [w.account.id],
  });
  return { ...w, t1, t2, request };
}

function bankAReply(reference: string): IncomingMessage {
  return {
    fromAddress: "nodal@bank-a.example.invalid",
    toAddress: "io@police.example.invalid",
    subject: `RE: ${reference} statement, KYC and hold`,
    receivedAt: ist("2026-11-08T13:58"),
    bodyText: [
      `With reference to ${reference}, the statement of account XXXXXXXX4821 for 25-10-2026 to 08-11-2026 is attached.`,
      "A debit freeze has been marked on the account. Available balance Rs. 0.00 as on 08-11-2026 13:30.",
    ].join("\n"),
    channel: "EMAIL",
    attachments: [
      {
        fileName: "BankA_statement.csv",
        buffer: Buffer.from(
          [
            "Txn Date,Txn Time,Description,UTR/RRN,Counterparty A/c,Counterparty IFSC,Counterparty Bank,Debit,Credit",
            "02-11-2026,10:42,UPI credit,630100000214,,,,,60000.00",
            "03-11-2026,09:15,UPI credit,BAUPI0099814,,,,,40000.00",
          ].join("\n"),
        ),
      },
    ],
  };
}

async function findingsOf(w: World, responseId: string) {
  return w.db.responseFinding.findMany({ where: { responseId }, orderBy: { sortOrder: "asc" } });
}

async function acceptAndApply(w: World, responseId: string, type: "ACKNOWLEDGEMENT" | "PARTIAL" | "COMPLETE" = "PARTIAL") {
  for (const f of await findingsOf(w, responseId)) await decideFinding(w.db, w.officer, f.id, { decision: "ACCEPTED" });
  const r = await w.db.response.findUniqueOrThrow({ where: { id: responseId } });
  return applyResponse(w.db, w.officer, responseId, { responseType: type, expectedVersion: r.version });
}

describe("statement rows against recorded victim payments", () => {
  it("treats a credit with the recorded reference as corroboration even when the statement omits the payer's account", async () => {
    const w = await accountAWorld();
    const res = await importResponse(w.db, bankAReply(w.request.reference), { actorId: w.officer.id, actor: w.officer, caseId: w.kase.id });
    const row = (await findingsOf(w, res.responseId)).find((f) => f.findingType === "TRANSACTION" && f.row === 2)!;
    expect(row.classification).toBe("ALREADY_KNOWN");
    expect(JSON.parse(row.payloadJson).existingTransactionId).toBe(w.t1.id);
  });

  it("flags a credit that matches a victim payment by amount and account but not by date, instead of treating it as new money", async () => {
    const w = await accountAWorld();
    const res = await importResponse(w.db, bankAReply(w.request.reference), { actorId: w.officer.id, actor: w.officer, caseId: w.kase.id });
    const row = (await findingsOf(w, res.responseId)).find((f) => f.findingType === "TRANSACTION" && f.row === 3)!;
    expect(row.classification).toBe("CONFLICTING");
    expect(row.classificationNote).toContain("03 Nov 2026");
    expect(row.classificationNote).toContain("02 Nov 2026");
    expect(JSON.parse(row.payloadJson)).toMatchObject({ existingTransactionId: w.t2.id, conflict: "DATE" });
  });

  it("records the date difference as a flag on the payment without disputing or changing it", async () => {
    const w = await accountAWorld();
    const res = await importResponse(w.db, bankAReply(w.request.reference), { actorId: w.officer.id, actor: w.officer, caseId: w.kase.id });
    await acceptAndApply(w, res.responseId);
    const t2 = await w.db.transaction.findUniqueOrThrow({ where: { id: w.t2.id } });
    expect(t2.status).toBe("CONFIRMED_BY_BANK");
    expect(t2.occurredAt.toISOString()).toBe(w.t2.occurredAt.toISOString());
    const flag = await w.db.sourceAssertion.findFirstOrThrow({ where: { subjectType: "TRANSACTION", subjectId: w.t2.id, stance: "CONTRADICTS" } });
    expect(flag.note).toContain("03 Nov 2026");
  });
});

describe("hold confirmations", () => {
  it("reads a bank hold reference written with slashes", async () => {
    const w = await accountAWorld();
    const reply: IncomingMessage = {
      ...bankAReply(w.request.reference),
      bodyText: `With reference to ${w.request.reference}, a lien of Rs. 50,000.00 has been marked on the account as on 08-11-2026 11:02. Hold reference no. BB/412/0908.`,
      attachments: [],
    };
    const res = await importResponse(w.db, reply, { actorId: w.officer.id, actor: w.officer, caseId: w.kase.id });
    const hold = (await findingsOf(w, res.responseId)).find((f) => f.findingType === "HOLD_STATUS")!;
    expect(JSON.parse(hold.payloadJson)).toMatchObject({ amountMinor: L(50000).toString(), bankReference: "BB/412/0908" });
  });

  it("records a cash withdrawal the bank reports before the hold, with the ATM as a historical sighting", async () => {
    const w = await accountAWorld();
    const reply: IncomingMessage = {
      ...bankAReply(w.request.reference),
      bodyText: [
        `With reference to ${w.request.reference}, a lien of Rs. 50,000.00 has been marked on the account as on 08-11-2026 11:02.`,
        "Before the lien, a cash withdrawal of Rs. 20,000.00 was made at an ATM in Kukatpally on 05-11-2026 at 21:14 hrs. The ATM ID is not available with this office.",
      ].join("\n"),
      attachments: [],
    };
    const res = await importResponse(w.db, reply, { actorId: w.officer.id, actor: w.officer, caseId: w.kase.id });
    const cash = (await findingsOf(w, res.responseId)).find((f) => f.findingType === "CASH_WITHDRAWAL")!;
    expect(cash.classification).toBe("NEW");
    expect(JSON.parse(cash.payloadJson)).toMatchObject({ amountMinor: L(20000).toString(), occurredAt: ist("2026-11-05T21:14").toISOString(), place: "Kukatpally", atmId: null });

    await acceptAndApply(w, res.responseId);
    const txn = await w.db.transaction.findFirstOrThrow({ where: { caseId: w.kase.id, kind: "CASH_WITHDRAWAL" }, include: { toEntity: true } });
    expect(txn).toMatchObject({ fromEntityId: w.account.id, amountMinor: L(20000) });
    expect(txn.toEntity.kind).toBe("CASH");
    const sighting = await w.db.locationObservation.findFirstOrThrow({ where: { caseId: w.kase.id, observationType: "ATM_WITHDRAWAL" } });
    expect(sighting).toMatchObject({ locationText: "ATM, Kukatpally", precision: "ATM_SITE", eventAt: ist("2026-11-05T21:14") });
    expect(sighting.limitations).toContain("ATM ID");
  });
});

describe("preservation receipts from a provider portal", () => {
  async function portalWorld() {
    const w = await buildWorld();
    const profile = await w.db.entity.create({ data: { caseId: w.kase.id, kind: "PLATFORM_PROFILE", label: "Profile Anvi_K", value: "Anvi_K (dating app)", normalizedValue: "anvi_k (dating app)", discoveredAt: new Date() } });
    const request = await send(w, {
      caseId: w.kase.id,
      category: "PRESERVATION",
      recipientId: w.portal.id,
      subject: "Preservation request: Anvi_K",
      body: "Please preserve the records.",
      scope: "Preservation",
      periodFrom: null,
      periodTo: null,
      items: [{ label: "Confirmation that records are preserved, and the retention period", itemType: "PRESERVATION_CONFIRMATION" }],
      subjectEntityIds: [profile.id],
    });
    return { ...w, profile, request };
  }

  function receipt(reference: string): IncomingMessage {
    return {
      fromAddress: "le-portal@platform.example.invalid",
      toAddress: "io@police.example.invalid",
      subject: `Preservation acknowledged: ${reference}`,
      receivedAt: ist("2026-11-07T16:40"),
      bodyText: [
        `Your preservation request ${reference} has been processed. Portal reference LE-88213.`,
        "The records of the account are preserved until 05-02-2027.",
        "Last login IP address: 203.0.113.42",
      ].join("\n"),
      channel: "PORTAL_DOWNLOAD",
      attachments: [],
    };
  }

  it("reads the preservation period and keeps the expiry date on the request", async () => {
    const w = await portalWorld();
    const res = await importResponse(w.db, receipt(w.request.reference), { actorId: w.officer.id, actor: w.officer, caseId: w.kase.id, requestIdHint: w.request.id });
    const kept = (await findingsOf(w, res.responseId)).find((f) => f.findingType === "PRESERVATION_CONFIRMED")!;
    expect(JSON.parse(kept.payloadJson)).toMatchObject({ preservedUntil: ist("2027-02-05T23:59").toISOString(), portalReference: "LE-88213" });
    await acceptAndApply(w, res.responseId, "COMPLETE");
    const req = await w.db.request.findUniqueOrThrow({ where: { id: w.request.id }, include: { items: true } });
    expect(req.preservedUntil?.toISOString()).toBe(ist("2027-02-05T23:59").toISOString());
    expect(req.items[0]!.status).toBe("RECEIVED");
  });

  it("records a login IP from the receipt against the profile, noting what is missing to identify a subscriber", async () => {
    const w = await portalWorld();
    const res = await importResponse(w.db, receipt(w.request.reference), { actorId: w.officer.id, actor: w.officer, caseId: w.kase.id, requestIdHint: w.request.id });
    const ip = (await findingsOf(w, res.responseId)).find((f) => f.findingType === "LOCATION_OBSERVATION")!;
    expect(ip.summary).toContain("203.0.113.42");
    expect(ip.classificationNote).toMatch(/port/i);
    await acceptAndApply(w, res.responseId, "COMPLETE");
    const entity = await w.db.entity.findFirstOrThrow({ where: { caseId: w.kase.id, kind: "IP_ADDRESS" } });
    const rel = await w.db.relationship.findFirstOrThrow({ where: { caseId: w.kase.id, fromEntityId: entity.id, toEntityId: w.profile.id } });
    expect(rel.type).toBe("LINKED_IDENTIFIER");
  });
});

describe("layers of the money trail", () => {
  it("puts cash taken out of a second-layer account in the third layer, even when the cash was recorded first", async () => {
    const w = await accountAWorld();
    const db = w.db;
    const acctB = await db.entity.create({ data: { caseId: w.kase.id, kind: "BANK_ACCOUNT", label: "Account B", value: "XXXXXXXXXXXX2093", normalizedValue: "XXXXXXXXXXXX2093", attributesJson: JSON.stringify({ bank: "Demo Bank A" }), discoveredAt: new Date() } });
    const holdB = await send(w, { caseId: w.kase.id, category: "HOLD", recipientId: w.recipient.id, subject: "Hold on Account B", body: "Please freeze debits on the account and confirm the amount held.", scope: "Hold on Account B", periodFrom: null, periodTo: null, items: [{ label: "Confirmation of debit freeze", itemType: "HOLD_CONFIRMATION" }], subjectEntityIds: [acctB.id] });
    const cashReply: IncomingMessage = {
      fromAddress: "nodal@bank-a.example.invalid",
      toAddress: "io@police.example.invalid",
      subject: `RE: ${holdB.reference} hold`,
      receivedAt: ist("2026-11-08T11:02"),
      bodyText: `With reference to ${holdB.reference}, a lien of Rs. 50,000.00 has been marked as on 08-11-2026 11:02.\nBefore the lien, a cash withdrawal of Rs. 20,000.00 was made at an ATM in Kukatpally on 05-11-2026 at 21:14 hrs.`,
      channel: "EMAIL",
      attachments: [],
    };
    const r1 = await importResponse(db, cashReply, { actorId: w.officer.id, actor: w.officer, caseId: w.kase.id });
    await acceptAndApply(w, r1.responseId, "COMPLETE");

    const statement: IncomingMessage = {
      ...bankAReply(w.request.reference),
      attachments: [{ fileName: "BankA_onward.csv", buffer: Buffer.from(["Txn Date,Txn Time,Description,UTR/RRN,Counterparty A/c,Counterparty IFSC,Counterparty Bank,Debit,Credit", "04-11-2026,00:31,IMPS outward,BA2026110400318,XXXXXXXXXXXX2093,BNKB0000711,Bank B,70000.00,"].join("\n")) }],
    };
    const r2 = await importResponse(db, statement, { actorId: w.officer.id, actor: w.officer, caseId: w.kase.id });
    await acceptAndApply(w, r2.responseId);

    const onward = await db.transaction.findFirstOrThrow({ where: { caseId: w.kase.id, toEntityId: acctB.id } });
    const cash = await db.transaction.findFirstOrThrow({ where: { caseId: w.kase.id, kind: "CASH_WITHDRAWAL" } });
    expect(onward.layer).toBe(2);
    expect(cash.layer).toBe(3);
  });
});

describe("updates about requests that were already answered", () => {
  it("suggests the answered request a bank's unreferenced update most likely concerns, and waits for the officer", async () => {
    const w = await accountAWorld();
    const first = await importResponse(w.db, { ...bankAReply(w.request.reference), attachments: [] }, { actorId: w.officer.id, actor: w.officer, caseId: w.kase.id });
    await acceptAndApply(w, first.responseId, "COMPLETE");
    const update: IncomingMessage = {
      fromAddress: "nodal@bank-a.example.invalid",
      toAddress: "io@police.example.invalid",
      subject: "Hold confirmation",
      receivedAt: ist("2026-11-09T09:12"),
      bodyText: "Holds confirmed for FIR 412/2026 (PS Madhapur), FIR 388/2026 (PS Gachibowli), FIR 290/2026 (PS Miyapur) and FIR 155/2026 (PS Gachibowli). A/c XXXXXXXX4821.",
      channel: "EMAIL",
      attachments: [],
    };
    const res = await importResponse(w.db, update, { actorId: w.officer.id, actor: w.officer, caseId: w.kase.id });
    const r = await w.db.response.findUniqueOrThrow({ where: { id: res.responseId } });
    expect(r).toMatchObject({ matchStatus: "NEEDS_MATCH_REVIEW", requestId: w.request.id, firCount: 4 });
    expect(r.matchScore).toBeLessThan(70);
  });
});

describe("statement rows outside the money trail", () => {
  function fullStatement(reference: string): IncomingMessage {
    const rows = [
      "Txn Date,Txn Time,Description,UTR/RRN,Counterparty A/c,Counterparty IFSC,Counterparty Bank,Debit,Credit",
      "26-10-2026,11:05,Cash deposit,,,,,,500.00",
      "28-10-2026,19:40,UPI P2M grocery,UPI8801,,,,149.40,",
      "01-11-2026,08:12,UPI P2M recharge,UPI8807,,,,150.00,",
      "02-11-2026,10:42,UPI credit,630100000214,,,,,60000.00",
      "02-11-2026,10:43,SMS alert charges,,,,,2.36,",
      "03-11-2026,23:58,Account maintenance charges incl GST,,,,,139.24,",
    ];
    return { ...bankAReply(reference), attachments: [{ fileName: "BankA_full.csv", buffer: Buffer.from(rows.join("\n")) }] };
  }

  it("summarises rows before the first payment into the account in one note instead of a result per row", async () => {
    const w = await accountAWorld();
    const res = await importResponse(w.db, fullStatement(w.request.reference), { actorId: w.officer.id, actor: w.officer, caseId: w.kase.id });
    const findings = await findingsOf(w, res.responseId);
    expect(findings.filter((f) => f.findingType === "TRANSACTION" && [2, 3, 4].includes(f.row ?? 0))).toHaveLength(0);
    const note = findings.find((f) => f.findingType === "NOTE" && /before/.test(f.summary))!;
    expect(note.summary).toBe("3 rows before 02 Nov 2026 are outside the money trail");
  });

  it("summarises the bank's own charges in one note", async () => {
    const w = await accountAWorld();
    const res = await importResponse(w.db, fullStatement(w.request.reference), { actorId: w.officer.id, actor: w.officer, caseId: w.kase.id });
    const findings = await findingsOf(w, res.responseId);
    expect(findings.filter((f) => f.findingType === "TRANSACTION" && [6, 7].includes(f.row ?? 0))).toHaveLength(0);
    expect(findings.find((f) => f.findingType === "NOTE" && /charges/.test(f.summary))!.summary).toBe("2 rows are the bank's own charges (₹141.60 in all)");
  });

  it("does not count a registered mobile on the statement as the KYC that was asked for", async () => {
    const w = await accountAWorld();
    const reply = { ...bankAReply(w.request.reference), bodyText: `With reference to ${w.request.reference}, the statement is attached.\nRegistered mobile: +91 9XXXX XXX41` };
    const res = await importResponse(w.db, reply, { actorId: w.officer.id, actor: w.officer, caseId: w.kase.id });
    const mobile = (await findingsOf(w, res.responseId)).find((f) => f.findingType === "RELATIONSHIP")!;
    expect(mobile.requestItemId).toBeNull();
    expect((await findingsOf(w, res.responseId)).some((f) => f.findingType === "ITEM_NOT_PROVIDED" && /KYC/.test(f.summary))).toBe(true);
  });
});

describe("a bank's hold table covering several FIRs", () => {
  it("reads only this FIR's row, notes a new debit freeze as a restriction separate from the hold, and skips the rest", async () => {
    const w = await accountAWorld();
    const kase = await w.db.case.update({ where: { id: w.kase.id }, data: { firNumber: 41299, firYear: 2026 } });
    const holdReply = await importResponse(w.db, { ...bankAReply(w.request.reference), bodyText: `With reference to ${w.request.reference}, a lien of Rs. 30,000.00 has been marked as on 08-11-2026 11:06. Hold reference no. BC/412/0411.`, attachments: [] }, { actorId: w.officer.id, actor: w.officer, caseId: w.kase.id });
    await acceptAndApply(w, holdReply.responseId, "COMPLETE");
    const table = [
      "FIR No,Police Station,Account No,Hold Amount,Hold Reference,Debit Freeze Date",
      `${kase.firNumber}/2026,PS Madhapur,XXXXXXXX4821,30000.00,BC/412/0411,09-11-2026`,
      "388/2026,PS Gachibowli,XXXXXXXX6612,12000.00,BC/388/0101,09-11-2026",
      "290/2026,PS Miyapur,XXXXXXXX9015,8500.00,BC/290/0077,",
      "155/2026,PS Gachibowli,XXXXXXXX3380,41000.00,BC/155/0310,09-11-2026",
    ].join("\n");
    const update: IncomingMessage = {
      fromAddress: "nodal@bank-a.example.invalid",
      toAddress: "io@police.example.invalid",
      subject: "Hold confirmation",
      receivedAt: ist("2026-11-09T09:12"),
      bodyText: `Please find the hold confirmation for FIR ${kase.firNumber}/2026, FIR 388/2026, FIR 290/2026 and FIR 155/2026 attached.`,
      channel: "EMAIL",
      attachments: [{ fileName: "hold_confirmation_4_FIRs.csv", buffer: Buffer.from(table) }],
    };
    const res = await importResponse(w.db, update, { actorId: w.officer.id, actor: w.officer, caseId: w.kase.id });
    const findings = await findingsOf(w, res.responseId);
    expect(findings.find((f) => f.findingType === "HOLD_STATUS")).toMatchObject({ classification: "ALREADY_KNOWN", row: 2 });
    const restriction = findings.find((f) => f.findingType === "RESTRICTION_CONFIRMED")!;
    expect(restriction.classification).toBe("NEW");
    expect(restriction.summary).toContain("09 Nov 2026");
    expect(findings.find((f) => f.findingType === "NOTE" && /other FIRs/.test(f.summary))!.summary).toBe("3 rows for other FIRs are skipped");
    expect(findings.some((f) => f.findingType === "TRANSACTION")).toBe(false);
  });
});

describe("how long a hold lasts", () => {
  it("records the date the bank says a lien lapses, so the hold can be extended or acted on in time", async () => {
    const w = await accountAWorld();
    const reply: IncomingMessage = {
      ...bankAReply(w.request.reference),
      bodyText: `With reference to ${w.request.reference}, a lien of Rs. 1,80,000.00 has been marked on the account as on 28-10-2026 15:00. The lien is valid until 11-11-2026.`,
      attachments: [],
    };
    const res = await importResponse(w.db, reply, { actorId: w.officer.id, actor: w.officer, caseId: w.kase.id });
    const hold = (await findingsOf(w, res.responseId)).find((f) => f.findingType === "HOLD_STATUS")!;
    expect(JSON.parse(hold.payloadJson).expiresAt).toBe(ist("2026-11-11T23:59").toISOString());
    expect(hold.summary).toContain("until 11 Nov 2026");
    await acceptAndApply(w, res.responseId, "COMPLETE");
    const h = await w.db.hold.findFirstOrThrow({ where: { caseId: w.kase.id, accountEntityId: w.account.id } });
    expect(h.expiresAt?.toISOString()).toBe(ist("2026-11-11T23:59").toISOString());
  });
});
