import { describe, expect, it } from "vitest";
import { buildWorld } from "../support/fixtures";
import { createCase } from "@/server/services/cases";
import { addOfficerEntry, updateIdentifierNotes } from "@/server/services/people";
import { logContact, listContacts } from "@/server/services/contacts";
import { deliverToInbox, listInboxForCase, importInboxMessage } from "@/server/services/inbox";
import { createDraft, requestApproval, approveRequest, submitRequest } from "@/server/services/requests";
import { scoreReply } from "@/domain/reply-match";
import { istInputToUtc } from "@/domain/time";

const ist = (v: string) => istInputToUtc(v)!;

describe("officer entries on people and identifiers", () => {
  it("adds an identifier the officer learned outside any record, marked as the officer's entry and logged", async () => {
    const w = await buildWorld();
    const e = await addOfficerEntry(w.db, w.officer, w.kase.id, { kind: "BANK_ACCOUNT", value: "XXXXXXXXXXXX2093", whatItIs: "Onward recipient in Bank A's trail report on CFCFRMS", belongsTo: "UNKNOWN", nickname: "Account B", bank: "Bank B", ifsc: "BNKB0000711" });
    expect(e).toMatchObject({ kind: "BANK_ACCOUNT", label: "Account B", officerEntry: true, belongsTo: "UNKNOWN", caseRole: "Onward recipient in Bank A's trail report on CFCFRMS" });
    expect(JSON.parse(e.attributesJson)).toMatchObject({ bank: "Bank B", ifsc: "BNKB0000711" });
    const audit = await w.db.auditEvent.findFirstOrThrow({ where: { caseId: w.kase.id, action: "entity.officer_entry_added" } });
    expect(audit.summary).toContain("not from any record yet");
  });

  it("asks for the value before saving, and refuses a duplicate of something already in the case", async () => {
    const w = await buildWorld();
    await expect(addOfficerEntry(w.db, w.officer, w.kase.id, { kind: "PHONE", value: "  ", whatItIs: "x", belongsTo: "UNKNOWN" })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(addOfficerEntry(w.db, w.officer, w.kase.id, { kind: "BANK_ACCOUNT", value: "XXXXXXXX4821", whatItIs: "again", belongsTo: "UNKNOWN" })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("keeps the officer's nickname and view beside the record without changing what the record said", async () => {
    const w = await buildWorld();
    const before = await w.db.entity.findUniqueOrThrow({ where: { id: w.account.id } });
    const after = await updateIdentifierNotes(w.db, w.officer, w.account.id, { nickname: "Mule 1", belongsTo: "SUSPECT" });
    expect(after).toMatchObject({ nickname: "Mule 1", belongsTo: "SUSPECT", value: before.value, label: before.label, caseRole: before.caseRole });
    expect(await w.db.auditEvent.count({ where: { caseId: w.kase.id, action: "entity.notes_updated" } })).toBe(1);
  });

  it("refuses officers who are not assigned to the case", async () => {
    const w = await buildWorld();
    await expect(addOfficerEntry(w.db, w.outsider, w.kase.id, { kind: "PHONE", value: "+91 9XXXX XXX41", whatItIs: "x", belongsTo: "UNKNOWN" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("keeping victims informed", () => {
  it("logs what a victim was told, with the next call, in the audit log", async () => {
    const w = await buildWorld();
    const victim = await w.db.entity.create({ data: { caseId: w.kase.id, kind: "PERSON", label: "Victim 1", value: "Victim 1", normalizedValue: "person:v1", discoveredAt: new Date() } });
    await logContact(w.db, w.officer, w.kase.id, { victimEntityId: victim.id, channel: "CALL", summary: "Told that ₹80,000 is held and nothing is returned yet", nextDueAt: "2026-11-12T10:00", followUp: null });
    const [c] = await listContacts(w.db, w.officer, w.kase.id);
    expect(c).toMatchObject({ victimLabel: "Victim 1", channel: "CALL", summary: "Told that ₹80,000 is held and nothing is returned yet" });
    expect(c!.nextDueAt?.toISOString()).toBe(ist("2026-11-12T10:00").toISOString());
    expect(await w.db.auditEvent.count({ where: { caseId: w.kase.id, action: "contact.logged" } })).toBe(1);
  });

  it("asks what the victim was told before saving", async () => {
    const w = await buildWorld();
    const victim = await w.db.entity.create({ data: { caseId: w.kase.id, kind: "PERSON", label: "Victim 1", value: "Victim 1", normalizedValue: "person:v1b", discoveredAt: new Date() } });
    await expect(logContact(w.db, w.officer, w.kase.id, { victimEntityId: victim.id, channel: "CALL", summary: " ", nextDueAt: null, followUp: null })).rejects.toMatchObject({ fieldErrors: { summary: expect.stringMatching(/what they were told/) } });
  });
});

describe("NCRP complaints that become FIRs", () => {
  it("links the complaint to the new FIR when the FIR carries its acknowledgement number", async () => {
    const w = await buildWorld();
    await w.db.complaint.create({ data: { ackNumber: "33710260071203", channel: "HELPLINE_1930", receivedAt: ist("2026-11-09T08:10"), category: "INVESTMENT", categoryLabel: "Investment-app fraud", complainantName: "M. Srinivas", lossAmountMinor: 21500000n, heldAmountMinor: 14000000n, note: "1930 placed a hold." } });
    const kase = await createCase(w.db, w.officer, { referenceType: "FIR", firNumber: "413", firYear: "2026", complaintRef: "33710260071203", investigatingOfficerId: w.officer.id, title: "Investment-app fraud" });
    const c = await w.db.complaint.findUniqueOrThrow({ where: { ackNumber: "33710260071203" } });
    expect(c).toMatchObject({ status: "REGISTERED", caseId: kase.id });
  });
});

describe("matching a reply to a request", () => {
  const request = { reference: "REQ-2026-0041", recipientAddress: "nodal.officer@bank-a.example.invalid", firReference: "412/2026", identifiers: ["XXXXXXXXXXXX4471"] };

  it("scores a reply that quotes the reference, comes from the bank and names the account and FIR as a near-certain match", () => {
    const s = scoreReply({ fromAddress: "nodal.officer@bank-a.example.invalid", subject: "RE: REQ-2026-0041 FIR 412/2026", bodyText: "Statement of a/c XXXXXXXXXXXX4471 attached." }, request);
    expect(s.score).toBeGreaterThanOrEqual(90);
    expect(s.reasons.join(" ")).toMatch(/quotes REQ-2026-0041/);
  });

  it("scores a reply without a reference that covers several FIRs below the automatic-match line", () => {
    const s = scoreReply(
      { fromAddress: "nodal.officer@bank-a.example.invalid", subject: "Hold confirmation", bodyText: "Holds for FIR 412/2026, FIR 388/2026 (PS Gachibowli), FIR 290/2026 (PS Miyapur) and FIR 377/2026. A/c ending 4471." },
      request,
    );
    expect(s.score).toBeLessThan(70);
    expect(s.score).toBeGreaterThan(30);
    expect(s.reasons.join(" ")).toMatch(/names 4 FIRs/);
  });

  it("scores a reply from somebody else about something else as unlikely", () => {
    expect(scoreReply({ fromAddress: "desk@other.example.invalid", subject: "Hello", bodyText: "Nothing related." }, request).score).toBeLessThan(15);
  });
});

describe("the station inbox", () => {
  async function inboxWorld() {
    const w = await buildWorld();
    const draft = await createDraft(w.db, w.officer, {
      caseId: w.kase.id,
      category: "INFORMATION",
      recipientId: w.recipient.id,
      subject: "Statement and KYC: Account A",
      body: "Please provide the statement and KYC.",
      scope: "Statement, KYC",
      periodFrom: null,
      periodTo: null,
      items: [{ label: "Statement of account", itemType: "STATEMENT" }],
      subjectEntityIds: [w.account.id],
    });
    const a = await requestApproval(w.db, w.officer, draft.id, draft.version);
    const ap = await approveRequest(w.db, w.supervisor, draft.id, a.version, null);
    await submitRequest(w.db, w.officer, draft.id, { expectedVersion: ap.version, confirmed: true, idempotencyKey: `sub-${draft.id}` });
    const request = await w.db.request.findUniqueOrThrow({ where: { id: draft.id } });
    const msg = await deliverToInbox(w.db, {
      fromAddress: "nodal@bank-a.example.invalid",
      toAddress: "io@police.example.invalid",
      subject: `RE: ${request.reference} statement`,
      receivedAt: ist("2026-11-10T10:14"),
      bodyText: `With reference to ${request.reference}, the statement of a/c XXXXXXXX4821 is attached.`,
      channel: "EMAIL",
      attachments: [{ fileName: "statement.csv", buffer: Buffer.from("Txn Date,Description,Debit,Credit\n02-11-2026 10:42,UPI credit,,60000.00\n") }],
      isSynthetic: true,
    });
    return { ...w, request, msg };
  }

  it("keeps a delivered message unread, with its attachment stored, until an officer reads it in", async () => {
    const w = await inboxWorld();
    expect(w.msg.status).toBe("UNREAD");
    const att = JSON.parse(w.msg.attachmentsJson) as { fileName: string; sha256: string }[];
    expect(att[0]).toMatchObject({ fileName: "statement.csv" });
    expect(att[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("lists unread messages that look like replies to the case, best match first, and only to officers on the case", async () => {
    const w = await inboxWorld();
    const unrelated = await deliverToInbox(w.db, { fromAddress: "someone@elsewhere.example.invalid", toAddress: "io@police.example.invalid", subject: "Newsletter", receivedAt: ist("2026-11-10T09:00"), bodyText: "Unrelated.", channel: "EMAIL", attachments: [], isSynthetic: true });
    const list = await listInboxForCase(w.db, w.officer, w.kase.id);
    expect(list[0]!.id).toBe(w.msg.id);
    expect(list.map((m) => m.id)).not.toContain(unrelated.id);
    expect(list[0]).toMatchObject({ requestReference: w.request.reference, attachments: 1 });
    expect(list[0]!.score).toBeGreaterThanOrEqual(70);
    await expect(listInboxForCase(w.db, w.outsider, w.kase.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("reads a message into the case as a reply matched to its request, once", async () => {
    const w = await inboxWorld();
    const res = await importInboxMessage(w.db, w.officer, w.kase.id, w.msg.id);
    expect(res.matchStatus).toBe("MATCHED");
    const response = await w.db.response.findUniqueOrThrow({ where: { id: res.responseId } });
    expect(response).toMatchObject({ caseId: w.kase.id, requestId: w.request.id });
    expect(response.matchScore).toBeGreaterThanOrEqual(70);
    expect(await w.db.evidenceItem.count({ where: { responseId: res.responseId, fileName: "statement.csv" } })).toBe(1);
    expect(await w.db.inboxMessage.findUniqueOrThrow({ where: { id: w.msg.id } })).toMatchObject({ status: "IMPORTED", caseId: w.kase.id, responseId: res.responseId });
    await expect(importInboxMessage(w.db, w.officer, w.kase.id, w.msg.id)).rejects.toMatchObject({ code: "PRECONDITION" });
  });
});

describe("officer entries in the discovery phases", () => {
  it("start a new phase, shared by entries made in the same sitting", async () => {
    const w = await buildWorld();
    const b = await addOfficerEntry(w.db, w.officer, w.kase.id, { kind: "BANK_ACCOUNT", value: "XXXXXXXXXXXX2093", whatItIs: "From a portal report", belongsTo: "UNKNOWN" });
    const c = await addOfficerEntry(w.db, w.officer, w.kase.id, { kind: "BANK_ACCOUNT", value: "XXXXXXXXXXXX7715", whatItIs: "From a portal report", belongsTo: "UNKNOWN" });
    expect(b.discoveryPhase).toBe(1);
    expect(c.discoveryPhase).toBe(1);
  });
});
