import crypto from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@/server/db";
import { seedDemo } from "@/server/seed";
import type { SessionUser } from "@/server/auth/session";
import { createCase } from "@/server/services/cases";
import { withAutoDraft } from "@/server/services/auto-draft";
import { importNodalWorkbook } from "@/server/services/nodal";
import { getNextActions } from "@/server/services/next-actions";
import { updateIdentifierNotes } from "@/server/services/people";
import { setRecipientVerification } from "@/server/services/settings";
import { approveAndSend, createDraft, markDraftReviewed } from "@/server/services/requests";
import { applyResponse, decideFinding, importResponse } from "@/server/services/responses";
import { buildZip } from "@/server/documents/zip";

/**
 * A real (non-demonstration) case from FIR to replies, with synthetic values: what the FIR gives becomes the right
 * next actions, drafts go to the nodal officer list and wait for a supervisor to verify the address, replies are read
 * (a bank's text, an Excel statement, a platform's free-text answer through the local model) and what they reveal is
 * drafted for again.
 */
const db = getDb();
async function user(username: string): Promise<SessionUser> {
  const u = await db.user.findUniqueOrThrow({ where: { username }, include: { station: true } });
  return { id: u.id, username, displayName: u.displayName, rank: u.rank, role: u.role as SessionUser["role"], stationId: u.stationId, stationCode: u.station.code, stationName: u.station.name };
}
const offline = async () => ({ ok: false as const, error: "The local model is not running on this server." });

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
/** A one-sheet workbook; each row is a list of cell texts. */
function workbook(name: string, rows: string[][]): Buffer {
  const strings: string[] = [];
  const idx = (s: string) => (strings.includes(s) ? strings.indexOf(s) : strings.push(s) - 1);
  const col = (i: number) => String.fromCharCode(65 + i);
  const sheet = `<worksheet><sheetData>${rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => `<c r="${col(ci)}${ri + 1}" t="s"><v>${idx(v)}</v></c>`).join("")}</row>`).join("")}</sheetData></worksheet>`;
  return buildZip(
    Object.entries({
      "xl/workbook.xml": `<workbook xmlns:r="r"><sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
      "xl/worksheets/sheet1.xml": sheet,
      "xl/sharedStrings.xml": `<sst>${strings.map((s) => `<si><t>${xml(s)}</t></si>`).join("")}</sst>`,
    }).map(([n, t]) => ({ name: n, data: Buffer.from(t), modified: new Date() })),
  );
}

let caseId = "";
const ids: Record<string, string> = {};
const task = (key: string) => db.task.findFirstOrThrow({ where: { caseId, dedupeKey: key } });
const requestFor = async (key: string) => {
  const t = await task(key);
  return db.request.findUniqueOrThrow({ where: { id: t.requestId! }, include: { recipient: true } });
};

beforeAll(async () => {
  await seedDemo(db, { anchor: "2026-11-09" });
  const sup = await user("supervisor");
  // The nodal officer list (synthetic addresses in the shape of the CrimeOS export).
  await importNodalWorkbook(db, sup, {
    fileName: "nodal.xlsx",
    buffer: workbook("Nodal Officers", [
      ["S.No", "Service Type", "Provider Name", "Nodal Officer Name", "Provider Email", "Phone Number", "Provider Address", "Record ID", "Created At"],
      ["1", "Bank", "HDFC BANK LTD", "A. Nodal", "lea.cell@hdfcbank.example.invalid", "", "", "t-1", "2024-12-06 11:55:58"],
      ["2", "Bank", "Kotak Mahindra Bank", "B. Nodal", "nodal@kotak.example.invalid", "", "", "t-2", "2024-12-06 11:55:58"],
      ["3", "Bank", "ICICI Bank", "C. Nodal", "lea@icicibank.example.invalid", "", "", "t-3", "2024-12-06 11:55:58"],
      ["4", "Social Media Provider", "WhatsApp", "", "records@whatsapp.example.invalid", "", "", "t-4", "2024-12-06 11:55:58"],
      ["5", "Website", "Google India", "", "lis@google.example.invalid", "", "", "t-5", "2024-12-06 11:55:58"],
    ]),
  });
  const me = await user("officer1");
  const { result } = await withAutoDraft(db, me, async (c: { id: string }) => c.id, () =>
    createCase(db, me, {
      referenceType: "FIR",
      firNumber: "1501",
      firYear: "2026",
      investigatingOfficerId: me.id,
      title: "Investment fraud",
      incidentStart: "2026-11-01T10:00",
      reportedAt: "2026-11-05T10:00",
      legalSections: "BNS 318(4); IT Act 66-D",
      parties: [{ name: "Test Complainant", role: "VICTIM", lossRupees: "2,50,000" }],
      identifiers: [
        { kind: "BANK_ACCOUNT", value: "50100012346126", role: "Reported beneficiary account" },
        { kind: "BANK_ACCOUNT", value: "073649659002", role: "Complainant's own account", bank: "Kotak Mahindra Bank" },
        { kind: "PHONE", value: "+235 99 52 77 41", role: "Contact used by the alleged fraudster (WhatsApp)" },
        { kind: "EMAIL", value: "fraud.desk@gmail.com", role: "Email used by the alleged fraudster" },
        { kind: "EMAIL", value: "complainant.1@gmail.com", role: "Complainant's own email" },
        { kind: "EMAIL", value: "desk.x@mail.com", role: "Email used by the alleged fraudster" },
        { kind: "WEBSITE", value: "https://www.harmon.rest/register/1", role: "Website used in the fraud (per the FIR)" },
      ],
    }),
  );
  caseId = result.id;
  for (const e of await db.entity.findMany({ where: { caseId } })) ids[e.value] = e.id;
}, 240000);

describe("a real case, from what the FIR gives", () => {
  it("proposes the right first steps and holds back what cannot be addressed yet", async () => {
    const t = await db.task.findMany({ where: { caseId } });
    const by = new Map(t.map((x) => [x.dedupeKey, x]));
    expect(by.get(`DEBITS:${ids["073649659002"]}`)?.status).toBe("DRAFT_PREPARED");
    expect(by.get(`WHATSAPP:${ids["+235 99 52 77 41"]}`)?.status).toBe("DRAFT_PREPARED");
    expect(by.get(`DETAILS:${ids["fraud.desk@gmail.com"]}`)?.status).toBe("DRAFT_PREPARED");
    expect(by.get(`HOLD:${ids["50100012346126"]}`)?.status).toBe("BLOCKED");
    expect(by.get("SITE:harmon.rest")?.status).toBe("BLOCKED");
    // Never: the complainant's own email, or UNICROSS for a foreign number.
    expect(by.has(`DETAILS:${ids["complainant.1@gmail.com"]}`)).toBe(false);
    expect(by.has(`PRESERVE:${ids["fraud.desk@gmail.com"]}`)).toBe(false);
    expect(by.has(`SUBSCRIBER:${ids["+235 99 52 77 41"]}`)).toBe(false);
  });

  it("addresses drafts to the nodal officer list, unverified, never to the demonstration directory", async () => {
    const debits = await requestFor(`DEBITS:${ids["073649659002"]}`);
    expect(debits.recipient).toMatchObject({ organisation: "Kotak Mahindra Bank", address: "nodal@kotak.example.invalid", verificationStatus: "UNVERIFIED", isSynthetic: false, channel: "EMAIL" });
    expect((await requestFor(`WHATSAPP:${ids["+235 99 52 77 41"]}`)).recipient.address).toBe("records@whatsapp.example.invalid");
    const details = await requestFor(`DETAILS:${ids["fraud.desk@gmail.com"]}`);
    expect(details.recipient.address).toBe("lis@google.example.invalid");
    expect(details.category).toBe("INFORMATION");
    const v = await db.requestVersion.findFirstOrThrow({ where: { requestId: debits.id } });
    expect(v.body).toMatch(/beneficiary account number, IFSC and bank/);
    expect(v.body).not.toMatch(/not available\]|\{\{/);
    expect(v.body).toMatch(/\(318\(4\) BNS, 66-D IT Act\), the complainant, who holds account 073649659002 with your bank, reports ₹2,50,000 lost/);
    expect(v.body).toMatch(/kindly furnish, for 01 Nov 2026 to 05 Nov 2026:/);
  });

  it("says before drafting when the provider has no address on the nodal officer list", async () => {
    const view = await getNextActions(db, await user("officer1"), caseId);
    const mailcom = view.actions.find((a) => a.title.includes("desk.x@mail.com"))!;
    expect(mailcom).toMatchObject({ kind: "REQUEST", status: { text: "Missing a detail" } });
    expect(mailcom.note).toMatch(/mail\.com has no email address on the nodal officer list/);
    // A request that can be addressed carries no such note.
    expect(view.actions.filter((a) => a.kind === "REQUEST" && !a.note).every((a) => a.status.text === "Not drafted")).toBe(true);
  });

  it("drafts the waiting freeze and statement once the officer records the account's IFSC", async () => {
    const me = await user("officer1");
    const { autoDraft } = await withAutoDraft(db, me, async (e: { caseId: string }) => e.caseId, () => updateIdentifierNotes(db, me, ids["50100012346126"]!, { ifsc: "HDFC0001234" }));
    expect(autoDraft?.drafted).toBe(2);
    const hold = await requestFor(`HOLD:${ids["50100012346126"]}`);
    expect(hold.recipient).toMatchObject({ organisation: "HDFC Bank", address: "lea.cell@hdfcbank.example.invalid" });
    await expect(updateIdentifierNotes(db, me, ids["50100012346126"]!, { ifsc: "HDFC123" })).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("tells the officer an unverified address cannot be sent to, and lets the supervisor verify it and send", async () => {
    const officerView = await getNextActions(db, await user("officer1"), caseId);
    const draft = officerView.actions.find((a) => a.request?.recipient.address === "lea.cell@hdfcbank.example.invalid")!;
    expect(draft.status.text).toBe("Address not verified");
    expect(draft.request!.canApproveAndSend).toBe(false);
    expect(draft.request!.approvalNote).toMatch(/cannot be sent/);
    const sup = await user("supervisor");
    const supView = await getNextActions(db, sup, caseId);
    const mine = supView.actions.find((a) => a.request?.id === draft.request!.id)!;
    expect(mine.request!.recipient.canVerify).toBe(true);
    await setRecipientVerification(db, sup, mine.request!.recipient.id, { verified: true, note: "Checked against the nodal officer list" });
    const req = await db.request.findUniqueOrThrow({ where: { id: mine.request!.id } });
    const sent = await approveAndSend(db, sup, req.id, { expectedVersion: req.version, idempotencyKey: crypto.randomUUID() });
    expect(sent.outcome).toBe("SUCCEEDED");
  });
});

describe("the demonstration directory and a real case", () => {
  it("never sends a real case's request to a demonstration entry, and offers to re-address it", async () => {
    const me = await user("officer1");
    const demo = await db.recipient.findFirstOrThrow({ where: { isSynthetic: true, organisationType: "BANK" } });
    const draft = await createDraft(db, me, { caseId, category: "INFORMATION", recipientId: demo.id, routeId: null, subject: "Statement of the complainant account", body: "Kindly furnish the statement of the account for the period.", scope: "Statement of account", periodFrom: null, periodTo: null, items: [{ label: "Statement", itemType: "STATEMENT" }], subjectEntityIds: [ids["073649659002"]!] , allowDuplicateReason: "Test of the demonstration guard" });
    const sup = await user("supervisor");
    const view = await getNextActions(db, sup, caseId);
    const shown = view.actions.flatMap((a) => (a.request?.id === draft.id ? [a] : []));
    for (const a of shown) expect(a.request).toMatchObject({ demoAddress: true, canApproveAndSend: false });
    await expect(approveAndSend(db, sup, draft.id, { expectedVersion: draft.version, idempotencyKey: crypto.randomUUID() })).rejects.toThrow(/demonstration directory entry/);
  });
});

describe("replies to a real case", () => {
  it("reads a bank's hold confirmation and records the hold once accepted", async () => {
    const sup = await user("supervisor");
    const hold = await requestFor(`HOLD:${ids["50100012346126"]}`);
    const r = await importResponse(
      db,
      { fromAddress: hold.recipient.address, toAddress: "io@police.example.invalid", subject: `Re: ${hold.reference}`, receivedAt: new Date(), bodyText: `Ref ${hold.reference}. A debit freeze is marked on account 50100012346126 and Rs. 1,20,000.00 is under lien as on 13-11-2026. Lien reference LIEN998877.`, channel: "MANUAL_IMPORT", attachments: [] },
      { actorId: sup.id, actor: sup, caseId, generate: offline },
    );
    expect(r).toMatchObject({ status: "IMPORTED", matchStatus: "MATCHED" });
    const f = await db.responseFinding.findFirstOrThrow({ where: { responseId: r.responseId, findingType: "HOLD_STATUS" } });
    expect(f.classification).toBe("NEW");
    await decideFinding(db, sup, f.id, { decision: "ACCEPTED" });
    const resp = await db.response.findUniqueOrThrow({ where: { id: r.responseId } });
    await applyResponse(db, sup, r.responseId, { responseType: "PARTIAL", expectedVersion: resp.version });
    expect(await db.hold.findFirst({ where: { caseId, accountEntityId: ids["50100012346126"], status: "CONFIRMED_HELD" } })).toMatchObject({ confirmedAmountMinor: 12000000n });
  });

  it("checks the name the FIR stated for an account against the bank's KYC, and keeps the result", async () => {
    const sup = await user("supervisor");
    const benId = ids["50100012346126"]!;
    const ben = await db.entity.findUniqueOrThrow({ where: { id: benId } });
    // As the FIR reader records it: "a vendor named adharsh bearing account …".
    await db.entity.update({ where: { id: benId }, data: { attributesJson: JSON.stringify({ ...JSON.parse(ben.attributesJson), statedName: "adharsh", statedNameBasis: "As stated in the FIR; not verified" }) } });
    const info = await requestFor(`INFO:${benId}`);
    // The hold reply changed what is known about the account, so the unsent statement request was flagged for review.
    const flagged = await db.request.findUniqueOrThrow({ where: { id: info.id } });
    expect(flagged.needsReview).toBe(true);
    const view = await getNextActions(db, sup, caseId);
    expect(view.actions.find((a) => a.request?.id === info.id)).toMatchObject({ status: { text: "Check before sending" }, request: { canApproveAndSend: false } });
    await markDraftReviewed(db, sup, info.id, flagged.version, "Still right after the hold was confirmed");
    const fresh = await db.request.findUniqueOrThrow({ where: { id: info.id } });
    expect((await approveAndSend(db, sup, info.id, { expectedVersion: fresh.version, idempotencyKey: crypto.randomUUID() })).outcome).toBe("SUCCEEDED");
    const r = await importResponse(
      db,
      { fromAddress: info.recipient.address, toAddress: "io@police.example.invalid", subject: `Re: ${info.reference}`, receivedAt: new Date(), bodyText: `Ref ${info.reference}.\nAccount holder name: ADHARSH KUMAR\nRegistered mobile: 9876543210`, channel: "MANUAL_IMPORT", attachments: [] },
      { actorId: sup.id, actor: sup, caseId, generate: offline },
    );
    const kyc = await db.responseFinding.findFirstOrThrow({ where: { responseId: r.responseId, findingType: "KYC_RECORD" } });
    expect(kyc.classificationNote).toMatch(/The FIR stated .* to be “adharsh”; HDFC Bank's KYC names ADHARSH KUMAR: the names match\./);
    await decideFinding(db, sup, kyc.id, { decision: "ACCEPTED" });
    const resp = await db.response.findUniqueOrThrow({ where: { id: r.responseId } });
    await applyResponse(db, sup, r.responseId, { responseType: "PARTIAL", expectedVersion: resp.version });
    const after = JSON.parse((await db.entity.findUniqueOrThrow({ where: { id: benId } })).attributesJson);
    expect(after.statedNameCheck).toMatchObject({ stated: "adharsh", recordName: "ADHARSH KUMAR", verdict: "MATCHES" });
    expect(await db.auditEvent.count({ where: { objectId: benId, action: "entity.stated_name_checked" } })).toBe(1);
  });

  it("reads the complainant's bank statement in Excel, records the payment and drafts for the account it reveals", async () => {
    const sup = await user("supervisor");
    const debits = await requestFor(`DEBITS:${ids["073649659002"]}`);
    await setRecipientVerification(db, sup, debits.recipientId, { verified: true, note: "Checked against the nodal officer list" });
    const fresh = await db.request.findUniqueOrThrow({ where: { id: debits.id } });
    expect((await approveAndSend(db, sup, debits.id, { expectedVersion: fresh.version, idempotencyKey: crypto.randomUUID() })).outcome).toBe("SUCCEEDED");
    const statement = workbook("Statement", [
      ["KOTAK MAHINDRA BANK", "", "", "", "", "", ""],
      ["Account 073649659002 statement", "", "", "", "", "", ""],
      ["Transaction Date", "Particulars", "UTR Number", "Amount", "Dr/Cr", "Beneficiary Account Number", "Beneficiary IFSC Code"],
      ["02-11-2026 14:02:11", "IMPS/P2A", "KKBKR52026110200", "2,50,000.00", "DR", "000405009999", "ICIC0000123"],
      ["20-09-2026 09:00:00", "POS GROCERY", "POS1", "1,250.00", "DR", "", ""],
    ]);
    const r = await importResponse(
      db,
      { fromAddress: debits.recipient.address, toAddress: "io@police.example.invalid", subject: `Re: ${debits.reference}`, receivedAt: new Date(), bodyText: `Ref ${debits.reference}. The debit details are attached.`, channel: "MANUAL_IMPORT", attachments: [{ fileName: "debits.xlsx", buffer: statement }] },
      { actorId: sup.id, actor: sup, caseId, generate: offline },
    );
    const findings = await db.responseFinding.findMany({ where: { responseId: r.responseId, findingType: "TRANSACTION" } });
    const pay = findings.find((x) => x.summary.includes("2,50,000"))!;
    expect(pay).toMatchObject({ classification: "NEW" });
    expect(pay.summary).toMatch(/^Complainant's payment/);
    expect(findings.find((x) => x.summary.includes("1,250"))?.classification).toBe("UNCERTAIN");
    await decideFinding(db, sup, pay.id, { decision: "ACCEPTED" });
    const resp = await db.response.findUniqueOrThrow({ where: { id: r.responseId } });
    const { autoDraft } = await withAutoDraft(db, sup, async () => caseId, () => applyResponse(db, sup, r.responseId, { responseType: "PARTIAL", expectedVersion: resp.version }));
    const ben = await db.entity.findFirstOrThrow({ where: { caseId, value: "000405009999" } });
    expect(JSON.parse(ben.attributesJson)).toMatchObject({ bank: "ICICI Bank", ifsc: "ICIC0000123" });
    expect(await db.transaction.findFirst({ where: { caseId, toEntityId: ben.id } })).toMatchObject({ kind: "VICTIM_PAYMENT", layer: 1, amountMinor: 25000000n });
    expect(autoDraft?.drafted).toBeGreaterThanOrEqual(1);
    expect((await requestFor(`HOLD:${ben.id}`)).recipient.address).toBe("lea@icicibank.example.invalid");
  });

  it("has the local model read a platform's free-text reply, keeping only facts the reply states", async () => {
    const sup = await user("supervisor");
    const wa = await requestFor(`WHATSAPP:${ids["+235 99 52 77 41"]}`);
    await setRecipientVerification(db, sup, wa.recipientId, { verified: true, note: "Checked against the nodal officer list" });
    const fresh = await db.request.findUniqueOrThrow({ where: { id: wa.id } });
    expect((await approveAndSend(db, sup, wa.id, { expectedVersion: fresh.version, idempotencyKey: crypto.randomUUID() })).outcome).toBe("SUCCEEDED");
    const body = [
      `With reference to ${wa.reference}, the WhatsApp account on +235 99 52 77 41 was registered on 12-08-2026 by the user name 'Chanda Mentor', email mentor.chanda@example.invalid.`,
      "Last login IP: 102.89.34.11 on 01-11-2026 18:22:05 UTC.",
    ].join("\n");
    let prompt = "";
    const generate = async (o: { prompt: string }) => {
      prompt = o.prompt;
      return {
        ok: true as const,
        model: "gemma4:26b",
        ms: 5,
        text: JSON.stringify({
          facts: [
            { type: "ACCOUNT_HOLDER", holder: "Chanda Mentor", quote: "registered on 12-08-2026 by the user name 'Chanda Mentor'" },
            { type: "REGISTERED_EMAIL", email: "mentor.chanda@example.invalid", quote: "email mentor.chanda@example.invalid." },
            { type: "IP_LOG", ip: "102.89.34.11", at: "01-11-2026 18:22:05", quote: "Last login IP: 102.89.34.11 on 01-11-2026 18:22:05 UTC." },
            { type: "REGISTERED_MOBILE", mobile: "+91 98480 12345", quote: "The registered mobile is +91 98480 12345" },
          ],
        }),
      };
    };
    const r = await importResponse(db, { fromAddress: wa.recipient.address, toAddress: "io@police.example.invalid", subject: `Re: ${wa.reference}`, receivedAt: new Date(), bodyText: body, channel: "MANUAL_IMPORT", attachments: [] }, { actorId: sup.id, actor: sup, caseId, generate });
    expect(prompt).toContain("+235 99 52 77 41");
    expect(r.modelRead?.added).toBe(3);
    const model = await db.responseFinding.findMany({ where: { responseId: r.responseId, classification: "UNCERTAIN" }, orderBy: { sortOrder: "asc" } });
    expect(model.map((f) => f.findingType)).toEqual(["KYC_RECORD", "RELATIONSHIP", "LOCATION_OBSERVATION"]);
    expect(model[0]!.classificationNote).toMatch(/local model/);
    for (const f of model) await decideFinding(db, sup, f.id, { decision: "ACCEPTED" });
    const resp = await db.response.findUniqueOrThrow({ where: { id: r.responseId } });
    await applyResponse(db, sup, r.responseId, { responseType: "COMPLETE", expectedVersion: resp.version });
    expect(await db.entity.findFirst({ where: { caseId, kind: "IP_ADDRESS", value: "102.89.34.11" } })).not.toBeNull();
    expect(await db.entity.findFirst({ where: { caseId, kind: "EMAIL", value: "mentor.chanda@example.invalid" } })).not.toBeNull();
    expect(await db.entity.findFirst({ where: { caseId, kind: "PERSON", value: "Chanda Mentor" } })).not.toBeNull();
  });
});
