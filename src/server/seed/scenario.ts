import type { Db } from "../db";
import type { SessionUser } from "../auth/session";
import { setClock } from "../clock";
import { recordAudit } from "../audit";
import { getAppConfig } from "../config";
import { createCase } from "../services/cases";
import { uploadEvidence } from "../services/evidence";
import { reviewCandidate, addManualCandidate, applyReviewedCandidates } from "../services/extraction";
import { prepareDraftFromTask } from "../services/drafting";
import { createDraft, updateDraft, requestApproval, approveRequest, submitRequest, recordPortalSubmission, getRequestState } from "../services/requests";
import { importResponse, decideFinding, applyResponse, type IncomingMessage } from "../services/responses";
import { addManualTransaction } from "../services/funds";
import { addOfficerEntry } from "../services/people";
import { logContact } from "../services/contacts";
import { deliverToInbox } from "../services/inbox";
import { autoDraftRequests } from "../services/auto-draft";
import { createOfficerTask, deferTask, dismissTask, reopenTask } from "../services/tasks";
import * as docs from "./documents";
import { F412 } from "./documents";
import { formatDateIST } from "@/domain/time";
import type { DemoTimeline } from "./timeline";

export interface Actors {
  krishna: SessionUser;
  lavanya: SessionUser;
  arjun: SessionUser;
  devi: SessionUser;
}

/** Directory address by configuration key, so the scripted correspondence follows config changes. */
export function addr(key: string): string {
  const entry = getAppConfig().directory.find((d) => d.key === key);
  if (!entry) throw new Error(`Directory key "${key}" is missing from the configuration file`);
  return entry.address;
}

export const recipientByKey = (db: Db, key: string) => db.recipient.findUniqueOrThrow({ where: { configKey: key } });

export function clockAt(T: DemoTimeline, off: number, hhmm: string) {
  setClock(T.at(off, hhmm));
}

export async function taskByKey(db: Db, caseId: string, key: string) {
  return db.task.findFirstOrThrow({ where: { caseId, dedupeKey: key } });
}

/** The assistant prepares the draft for a proposed action; nothing is sent. */
export async function assistantDraft(db: Db, io: SessionUser, caseId: string, key: string) {
  const t = await taskByKey(db, caseId, key);
  return prepareDraftFromTask(db, io, t.id, { asAssistant: true });
}

/** The investigating officer approves the assistant's wording and sends it (simulated channel or portal). */
export async function approveAndSend(db: Db, T: DemoTimeline, approver: SessionUser, sender: SessionUser, requestId: string, off: number, hhmm: string, portalReference?: string) {
  clockAt(T, off, hhmm);
  const r = await db.request.findUniqueOrThrow({ where: { id: requestId } });
  const pending = r.status === "DRAFT" ? await requestApproval(db, sender, requestId, r.version) : r;
  const approved = await approveRequest(db, approver, requestId, pending.version, "Checked against the case record.");
  if (portalReference) return recordPortalSubmission(db, sender, requestId, { expectedVersion: approved.version, confirmed: true, portalReference });
  // The demonstration's history: these requests went out before; they are written as sent, whatever the delivery mode.
  return submitRequest(db, sender, requestId, { expectedVersion: approved.version, confirmed: true, idempotencyKey: `seed:${approved.reference}`, direct: true });
}

export function message(from: string, subject: string, receivedAt: Date, body: string[], attachments: docs.SyntheticFile[] = [], channel: IncomingMessage["channel"] = "EMAIL"): IncomingMessage {
  return { fromAddress: from, toAddress: getAppConfig().mailbox.fromAddress, subject, receivedAt, bodyText: body.join("\n"), channel, attachments };
}

export async function receive(db: Db, io: SessionUser, caseId: string, msg: IncomingMessage, requestIdHint: string | null = null) {
  return importResponse(db, msg, { actorId: io.id, caseId, isSynthetic: true, requestIdHint });
}

export async function reviewAll(db: Db, T: DemoTimeline, io: SessionUser, responseId: string, responseType: "ACKNOWLEDGEMENT" | "PARTIAL" | "COMPLETE", off: number, hhmm: string, reject: Record<string, string> = {}) {
  clockAt(T, off, hhmm);
  const findings = await db.responseFinding.findMany({ where: { responseId } });
  for (const f of findings) {
    const reason = reject[f.findingType];
    await decideFinding(db, io, f.id, reason ? { decision: "REJECTED", reason } : { decision: "ACCEPTED" });
  }
  const r = await db.response.findUniqueOrThrow({ where: { id: responseId } });
  return applyResponse(db, io, responseId, { responseType, expectedVersion: r.version });
}

const SYNTH = "This is a synthetic message created for demonstration. It is not a real communication.";

/**
 * FIR 412/2026, the worked example: two victims, ₹1,00,000 paid into Account A, moved on to B and C within 38 hours,
 * ₹80,000 held, ₹20,000 taken out as cash at an ATM in Kukatpally. Day 7 of the investigation is "today".
 */
export async function seedFir412(db: Db, T: DemoTimeline, a: Actors) {
  const io = a.krishna;

  // The complaint arrives on the portal first, an hour after Victim 1's payment.
  clockAt(T, -7, "11:02");
  await db.complaint.create({
    data: { ackNumber: F412.ack, channel: "NCRP_PORTAL", receivedAt: T.at(-7, "11:02"), category: "INVESTMENT", categoryLabel: "Investment-app fraud", complainantName: "Victim 1", lossAmountMinor: 6000000n, note: "Forwarded to PS Madhapur by the portal.", isSynthetic: true },
  });

  clockAt(T, -7, "12:05");
  const kase = await createCase(db, io, {
    referenceType: "FIR",
    firNumber: "412",
    firYear: "2026",
    complaintRef: F412.ack,
    investigatingOfficerId: io.id,
    title: "Investment-app fraud",
    fraudCategory: "Investment-app fraud",
    incidentStart: T.input(-12, "21:14"),
    incidentEnd: T.input(-7, "10:55"),
    reportedAt: T.input(-7, "11:02"),
    legalSections: "BNS 318(4), IT Act 66D",
    narrative: `On ${T.doc(-15)} the complainant received a match on a dating application from a profile named "${F412.profile}". The conversation moved to WhatsApp, where the person messaged her from ${F412.phone87} and promised returns from a crypto investment plan. As instructed, she paid Rs. 60,000 by UPI to A/c No. ${F412.accountA} (Bank A), in the name of P1. A second victim, introduced to the plan by the same person, paid Rs. 40,000 into the same account.`,
    parties: [
      { name: "Victim 1", role: "VICTIM", lossRupees: "60,000" },
      { name: "Victim 2", role: "VICTIM", lossRupees: "40,000" },
    ],
    identifiers: [],
  });
  await db.case.update({ where: { id: kase.id }, data: { isDemo: true, registeredAt: T.at(-7, "11:40"), moSummary: "Dating-app contact, then a fake trading app" } });
  const people = await db.entity.findMany({ where: { caseId: kase.id, kind: "PERSON" }, orderBy: { createdAt: "asc" } });
  const v1 = people.find((p) => p.label === "Victim 1")!;
  const v2 = people.find((p) => p.label === "Victim 2")!;
  await db.entity.updateMany({ where: { id: { in: [v1.id, v2.id] } }, data: { isSynthetic: true, belongsTo: "VICTIM", verificationStatus: "CORROBORATED", verificationNote: "Identity checked by the investigating officer at the station." } });
  const claims = await db.victimClaim.findMany({ where: { caseId: kase.id } });
  const c1 = claims.find((c) => c.victimEntityId === v1.id)!;
  const c2 = claims.find((c) => c.victimEntityId === v2.id)!;
  await db.victimClaim.update({ where: { id: c1.id }, data: { basis: "FIR item 4(a) and receipt 1" } });
  await db.victimClaim.update({ where: { id: c2.id }, data: { basis: "FIR item 4(b) and receipt 2" } });

  clockAt(T, -7, "12:10");
  const fir = await uploadEvidence(db, io, kase.id, { ...docs.fir412Pdf(T), title: "FIR 412/2026", category: "FIR_COPY", sourceDescription: "Copy of the registered FIR, uploaded at intake", receivedAt: T.at(-7, "11:40"), isSynthetic: true }, { runExtraction: true });
  await uploadEvidence(db, io, kase.id, { ...docs.chatExport412(T), title: "WhatsApp chat export", category: "SCREENSHOT", sourceDescription: "Exported by Victim 1 from her phone at the station", receivedAt: T.at(-7, "11:50"), isSynthetic: true }, { runExtraction: false });
  await uploadEvidence(db, io, kase.id, { ...docs.ncrpAck412(T), title: `NCRP acknowledgement ${F412.ack}`, category: "COMPLAINT", sourceDescription: "Forwarded by the reporting portal", receivedAt: T.at(-7, "11:02"), isSynthetic: true }, { runExtraction: false });

  // Check what was read from the FIR: confirm what was read correctly, and whose it is.
  clockAt(T, -7, "12:20");
  const candidates = await db.extractionCandidate.findMany({ where: { evidenceId: fir.id } });
  const ROLE: Record<string, string> = {
    [F412.v1Phone]: "Complainant's own number: noted, never requested",
    [F412.phone87]: "Messaged Victim 1 on WhatsApp; the caller used it (per FIR)",
    [F412.email]: 'Given to Victim 1 for "investment statements"',
    [F412.upiP1]: "UPI ID both victims paid to, in the name of P1",
    [F412.upiV1]: "Victim 1's own UPI ID (payer)",
    [F412.upiV2]: "Victim 2's own UPI ID (payer)",
  };
  for (const c of candidates) {
    if (c.field === "PERSON_NAME" && c.originalValue === "Victim 1") await reviewCandidate(db, io, c.id, { action: "ACCEPT", linkEntityId: v1.id, roleHint: "Complainant" });
    else if (c.field === "TRANSACTION_ROW") await reviewCandidate(db, io, c.id, { action: "REJECT", rejectReason: "Recorded per victim from the receipts: the FIR does not give the payer's account" });
    else if (c.field === "BANK_ACCOUNT") await reviewCandidate(db, io, c.id, { action: "ACCEPT", label: "Account A", roleHint: "Where both victims sent the money" });
    else if (ROLE[c.originalValue]) await reviewCandidate(db, io, c.id, { action: "ACCEPT", roleHint: ROLE[c.originalValue] });
    else await reviewCandidate(db, io, c.id, { action: "ACCEPT" });
  }
  const line = async (contains: string) => db.evidenceSegment.findFirstOrThrow({ where: { evidenceId: fir.id, text: { contains } } });
  const p1Line = await line("in the name of P1");
  await addManualCandidate(db, io, fir.id, { field: "PERSON_NAME", value: "P1", page: p1Line.page, line: p1Line.line, roleHint: "Named holder of Account A (per the FIR); not yet an accused" });
  const profileLine = await line(`"${F412.profile}"`);
  await addManualCandidate(db, io, fir.id, { field: "PLATFORM_PROFILE", value: F412.profile, page: profileLine.page, line: profileLine.line, roleHint: "Dating-app profile that first contacted Victim 1" });
  await applyReviewedCandidates(db, io, fir.id, {});

  const ent = (kind: string, value: string) => db.entity.findFirstOrThrow({ where: { caseId: kase.id, kind, value } });
  const A = await ent("BANK_ACCOUNT", F412.accountA);
  const profile = await ent("PLATFORM_PROFILE", F412.profile);
  const p1 = await db.entity.findFirstOrThrow({ where: { caseId: kase.id, kind: "PERSON", label: "P1" } });
  await db.entity.update({ where: { id: profile.id }, data: { label: "Profile “Anvi_K”", attributesJson: JSON.stringify({ platform: "Dating platform" }) } });
  await db.entity.update({ where: { id: p1.id }, data: { belongsTo: "UNKNOWN" } });
  await db.relationship.create({ data: { caseId: kase.id, fromEntityId: A.id, toEntityId: p1.id, type: "REGISTERED_TO", statement: "The FIR names P1 as the holder of Account A. Bank KYC has not confirmed it.", status: "UNVERIFIED", discoveredAt: T.at(-7, "12:20"), discoveryPhase: 0, dedupeKey: `REGISTERED_TO:${A.id}:${p1.id}` } });
  const upiV1 = await ent("UPI_ID", F412.upiV1);
  const upiV2 = await ent("UPI_ID", F412.upiV2);
  const upiP1 = await ent("UPI_ID", F412.upiP1);
  await db.entity.updateMany({ where: { id: { in: [upiV1.id, upiV2.id] } }, data: { belongsTo: "VICTIM", attributesJson: JSON.stringify({ isVictimAccount: true }) } });

  // Each victim's payment, recorded from the FIR line that states it.
  clockAt(T, -7, "12:30");
  const payA = await line(`Rs. 60,000 paid by Victim 1`);
  await addManualTransaction(db, io, kase.id, { fromEntityId: upiV1.id, toEntityId: A.id, amountRupees: "60,000", occurredAt: T.input(-7, "10:42"), channel: "UPI", reference: F412.utrV1, kind: "VICTIM_PAYMENT", claimId: c1.id, sourceNote: "FIR item 4(a) and receipt 1", evidenceId: fir.id, locator: `p. ${payA.page}, line ${payA.line}`, excerpt: payA.text });
  const payB = await line(`Rs. 40,000 paid by Victim 2`);
  await addManualTransaction(db, io, kase.id, { fromEntityId: upiV2.id, toEntityId: A.id, amountRupees: "40,000", occurredAt: T.input(-7, "10:55"), channel: "UPI", reference: F412.utrV2, kind: "VICTIM_PAYMENT", claimId: c2.id, sourceNote: "FIR item 4(b) and receipt 2 (two characters of the reference unreadable)", evidenceId: fir.id, locator: `p. ${payB.page}, line ${payB.line}`, excerpt: payB.text });
  await db.relationship.create({ data: { caseId: kase.id, fromEntityId: upiP1.id, toEntityId: A.id, type: "LINKED_IDENTIFIER", statement: "The FIR says the payments to this UPI ID reached Account A.", discoveredAt: T.at(-7, "12:30"), discoveryPhase: 0, dedupeKey: `LINKED_IDENTIFIER:${upiP1.id}:${A.id}` } });

  // H.REQ-412/2026-001: Bank A, hold with the statement and KYC asked for in the same request.
  clockAt(T, -7, "12:40");
  const r01 = await assistantDraft(db, io, kase.id, `HOLD:${A.id}`);
  const v = await db.requestVersion.findFirstOrThrow({ where: { requestId: r01.id }, orderBy: { versionNo: "desc" } });
  const st = await db.$transaction((tx) => getRequestState(tx, r01.id));
  await updateDraft(db, io, r01.id, {
    expectedVersion: st.version,
    recipientId: v.recipientId,
    subject: v.subject.replace("hold request", "statement, KYC and hold"),
    body: v.body.replace("Kindly mark a debit freeze", "Under Section 94 BNSS, kindly furnish the statement and KYC of the account, mark a debit freeze"),
    scope: "Statement, KYC and hold on Account A",
    periodFrom: T.at(-15, "00:00"),
    periodTo: null,
    items: [
      { label: `The account statement from ${formatDateIST(T.at(-15, "00:00"))} to date`, itemType: "STATEMENT" },
      { label: "KYC documents with photograph and ID proof", itemType: "KYC" },
      { label: "Confirmation of the debit freeze and the amount actually held", itemType: "HOLD_CONFIRMATION" },
    ],
    attachmentIds: [fir.id],
    changeNote: "Asked for the statement and KYC in the same request, so the bank answers once.",
  });
  await approveAndSend(db, T, a.devi, io, r01.id, -7, "12:55");
  const infoA = await taskByKey(db, kase.id, `INFO:${A.id}`);
  clockAt(T, -7, "13:00");
  await dismissTask(db, io, infoA.id, infoA.version, "Duplicate of H.REQ-412/2026-001, which asks for the statement and KYC too");
  const ack1 = await receive(db, io, kase.id, message(addr("bank-a"), `Acknowledgement: ${r01.reference}`, T.at(-7, "15:10"), [`We acknowledge receipt of your request ${r01.reference}. Ticket BA-LEA-55012. The request is under process.`, "Nodal Officer, Bank A (synthetic)", SYNTH]));
  await reviewAll(db, T, io, ack1.responseId, "ACKNOWLEDGEMENT", -7, "15:20");

  // R.REQ-412/2026-002 and P.REQ-412/2026-003, day 6: the number that messaged Victim 1, and the dating profile.
  const phone87 = await ent("PHONE", F412.phone87);
  clockAt(T, -6, "10:00");
  const r02 = await assistantDraft(db, io, kase.id, `SUBSCRIBER:${phone87.id}`);
  await approveAndSend(db, T, io, io, r02.id, -6, "10:20");
  clockAt(T, -6, "10:30");
  const r03 = await assistantDraft(db, io, kase.id, `PRESERVE:${profile.id}`);
  await approveAndSend(db, T, io, io, r03.id, -6, "10:45", "DP-LE-20931");

  // R.REQ-412/2026-004 to NPCI: the clear UPI reference only; Victim 2's is held back until verified.
  clockAt(T, -5, "08:40");
  const npci = await createDraft(db, io, {
    caseId: kase.id,
    category: "INFORMATION",
    recipientId: (await recipientByKey(db, "npci-route")).id,
    subject: `FIR 412/2026 · beneficiary trace · UPI ID ${F412.upiP1} · {{requestReference}}`,
    body: `Sir/Madam,\n\nIn FIR 412/2026 of PS Madhapur (BNS 318(4), IT Act 66D), Victim 1 paid Rs. 60,000 on ${T.doc(-7)} at 10:42 by UPI to ${F412.upiP1}, UTR ${F412.utrV1}.\n\nKindly furnish:\n- The beneficiary account and bank for the UTR above\n- The VPA holder's name, mobile number and linked account\n\nA second payment (reference ${F412.utrV2}) is not included: two characters of its reference are unreadable and a clearer receipt has been asked for.\n\nKindly reply quoting {{requestReference}}.\n\nKrishna, Sub-Inspector\n${getAppConfig().mailbox.signature.join("\n")}`,
    scope: "Beneficiary trace for the UPI payment with a readable reference",
    periodFrom: null,
    periodTo: null,
    items: [
      { label: `Beneficiary account and bank for UTR ${F412.utrV1}`, itemType: "OTHER" },
      { label: `VPA holder's name, mobile number and linked account for ${F412.upiP1}`, itemType: "KYC" },
    ],
    subjectEntityIds: [upiP1.id],
  });
  // Day 5: Bank A's onward-transfer report on CFCFRMS names two accounts; holds go to Banks B and C.
  clockAt(T, -5, "08:55");
  const B = await addOfficerEntry(db, io, kase.id, { kind: "BANK_ACCOUNT", value: F412.accountB, nickname: "Account B", whatItIs: "Received money from Account A (Bank A's onward-transfer report on CFCFRMS)", belongsTo: "UNKNOWN", bank: "Bank B", ifsc: F412.ifscB });
  const C = await addOfficerEntry(db, io, kase.id, { kind: "BANK_ACCOUNT", value: F412.accountC, nickname: "Account C", whatItIs: "Received money from Account A (Bank A's onward-transfer report on CFCFRMS)", belongsTo: "UNKNOWN", bank: "Bank C", ifsc: F412.ifscC });
  const holdDraft = async (acct: { id: string; value: string }, bankKey: string, bank: string, off: number, hhmm: string) => {
    clockAt(T, off, hhmm);
    return createDraft(db, io, {
      caseId: kase.id,
      category: "HOLD",
      recipientId: (await recipientByKey(db, bankKey)).id,
      subject: `FIR 412/2026 · Account ${acct.value} · hold request · {{requestReference}}`,
      body: `To the Nodal Officer, ${bank}\n\nSir/Madam,\n\nIn FIR 412/2026 of PS Madhapur, Cyberabad (318(4) BNS, 66D IT Act), Bank A reports on CFCFRMS that money from Account ${F412.accountA} was transferred to account ${acct.value} with your bank on ${T.doc(-5)}.\n\nKindly mark a debit freeze on the account and confirm the amount actually held, with the time the balance was taken.\n\nKindly reply quoting {{requestReference}}.\n\nKrishna, Sub-Inspector\n${getAppConfig().mailbox.signature.join("\n")}`,
      scope: `Hold on account ${acct.value}`,
      periodFrom: null,
      periodTo: null,
      items: [{ label: "Confirmation of the debit freeze and the amount actually held, with the time the balance was taken", itemType: "HOLD_CONFIRMATION" }],
      subjectEntityIds: [acct.id],
    });
  };
  const r05 = await holdDraft(B, "bank-b", "Bank B", -5, "09:00");
  const r06 = await holdDraft(C, "bank-c", "Bank C", -5, "09:02");
  await approveAndSend(db, T, a.devi, io, r05.id, -5, "09:10");
  await approveAndSend(db, T, a.devi, io, r06.id, -5, "09:11");

  await approveAndSend(db, T, a.devi, io, npci.id, -5, "12:30");

  const ackB = await receive(db, io, kase.id, message(addr("bank-b"), `Acknowledgement: ${r05.reference}`, T.at(-5, "12:02"), [`Your request ${r05.reference} has been received on CFCFRMS and is under process.`, "Nodal Officer, Bank B (synthetic)", SYNTH]));
  await reviewAll(db, T, io, ackB.responseId, "ACKNOWLEDGEMENT", -5, "12:40");
  const ackC = await receive(db, io, kase.id, message(addr("bank-c"), `Acknowledgement: ${r06.reference}`, T.at(-5, "12:06"), [`Your request ${r06.reference} has been received on CFCFRMS and is under process.`, "Nodal Officer, Bank C (synthetic)", SYNTH]));
  await reviewAll(db, T, io, ackC.responseId, "ACKNOWLEDGEMENT", -5, "12:42");

  // A lead the officer set aside, then reopened: a person of the same name appears in FIR 377/2026.
  clockAt(T, -5, "16:00");
  const lead = await createOfficerTask(db, io, kase.id, { title: "Check whether P1 is the person named in FIR 377", objective: "IDENTITY", question: "Is P1, the named holder of Account A, the person of the same name in FIR 377/2026?", purpose: "A matching name alone is not enough; one shared identifier, address or photo would link them.", dueAt: null, assigneeId: io.id });
  clockAt(T, -4, "10:00");
  const dismissed = await dismissTask(db, io, lead.id, lead.version, "A matching name alone is not enough");

  // Victim 2's receipt is unclear: asked for a clearer copy.
  clockAt(T, -3, "11:30");
  await logContact(db, io, kase.id, { victimEntityId: v2.id, channel: "CALL", summary: "Asked for a clearer copy of the second UPI receipt; not received yet", followUp: "A clearer UPI receipt", nextDueAt: null });
  // The officer last looked at the overview that evening.
  await db.reviewMarker.create({ data: { caseId: kase.id, userId: io.id, scope: "OVERVIEW", reviewedAt: T.at(-3, "18:05") } });

  // Day 2: the dating platform preserves the profile's records.
  const pres = await receive(db, io, kase.id, message("le-response@dating-portal.example.invalid", `Preservation acknowledged: ${r03.reference}`, T.at(-2, "16:40"), docs.preservationReceiptBody412(T, r03.reference), [], "PORTAL_DOWNLOAD"), r03.id);
  await reviewAll(db, T, io, pres.responseId, "COMPLETE", -2, "17:00");

  // Yesterday: holds confirmed on B and C, then Bank A's statement.
  const holdB = await receive(db, io, kase.id, message(addr("bank-b"), `RE: ${r05.reference} hold, A/c ···2093`, T.at(-1, "11:02"), docs.bankBHoldBody412(T, r05.reference)));
  await reviewAll(db, T, io, holdB.responseId, "COMPLETE", -1, "11:12");
  const holdC = await receive(db, io, kase.id, message(addr("bank-c"), `RE: ${r06.reference} hold, A/c ···7715`, T.at(-1, "11:06"), docs.bankCHoldBody412(T, r06.reference)));
  await reviewAll(db, T, io, holdC.responseId, "COMPLETE", -1, "11:14");
  const bankA = await receive(db, io, kase.id, message(addr("bank-a"), `RE: ${r01.reference} statement, KYC and hold, A/c ···4471`, T.at(-1, "13:58"), docs.bankAReplyBody412(T, r01.reference), [docs.bankAStatement412(T)]));
  await reviewAll(db, T, io, bankA.responseId, "PARTIAL", -1, "14:20");
  clockAt(T, -1, "14:21");
  await autoDraftRequests(db, io, kase.id, { since: T.at(-1, "14:20") });

  // The officer puts off three of the rule-raised actions, with reasons.
  clockAt(T, -1, "14:35");
  const putOff: [string, string][] = [
    ["DETAILS:", "The mail provider's address in the directory is not verified yet. Send once it is verified in Settings."],
    ["IPPORT:", "Ask Bank A for the port and exact time in the same letter as the missing KYC, once the reminder is answered."],
    ["INFO:", "Bank C has confirmed the hold. Its KYC can wait until Bank B's statement shows who moved the money."],
  ];
  for (const [prefix, reason] of putOff) {
    const t = await db.task.findFirst({ where: { caseId: kase.id, dedupeKey: { startsWith: prefix }, status: "OPEN", requestId: null, ...(prefix === "INFO:" ? { priority: "LOW" } : {}) } });
    if (t) await deferTask(db, io, t.id, t.version, null, reason);
  }

  clockAt(T, -1, "15:10");
  await logContact(db, io, kase.id, { victimEntityId: v1.id, channel: "CALL", summary: "Told that ₹80,000 is held and nothing is returned yet; the split is still to be decided", followUp: null, nextDueAt: T.input(3, "11:00") });
  clockAt(T, -1, "16:00");
  await reopenTask(db, io, lead.id, dismissed.version);

  // This morning: Bank C's hold table for four FIRs (no request reference), and two messages not yet read in.
  await receive(db, io, kase.id, message(addr("bank-c"), "Hold confirmation", T.at(0, "09:12"), ["Please find the hold confirmation for FIR 412/2026 (PS Madhapur), FIR 388/2026 (PS Gachibowli), FIR 290/2026 (PS Miyapur) and FIR 155/2026 (PS Gachibowli) attached.", "Nodal Officer, Bank C (synthetic)", SYNTH], [docs.bankCMultiFir(T)]));
  await deliverToInbox(db, { ...message(addr("npci-route"), `Acknowledgement of your request ${npci.reference}`, T.at(0, "09:02"), docs.npciAckBody412(npci.reference)), isSynthetic: true });
  await deliverToInbox(db, { ...message("dd.cyber@police.example.invalid", `Re: CDR and CAF, FIR 412/2026 · ${r02.reference}`, T.at(0, "10:14"), docs.unicrossReplyBody412(T, r02.reference), [docs.cdr87(T), docs.caf87(T)]), isSynthetic: true });

  await db.$transaction((tx) => recordAudit(tx, { caseId: kase.id, actorId: null, action: "demo.seeded", objectType: "Case", objectId: kase.id, summary: "Demonstration case (synthetic): every name, number and document is fictional", at: T.at(-7, "12:05") }));
  return kase;
}
