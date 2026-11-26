import type { Db } from "../db";
import type { SessionUser } from "../auth/session";
import { recordAudit } from "../audit";
import { createCase, setCaseStatus } from "../services/cases";
import { uploadEvidence } from "../services/evidence";
import { createDraft, requestApproval, approveRequest, submitRequest } from "../services/requests";
import { addManualTransaction, proposeAllocation, confirmAllocation, recordRefund, advanceRefund, recordHoldChange } from "../services/funds";
import { logContact } from "../services/contacts";
import { dismissTask } from "../services/tasks";
import { prepareDraftFromTask } from "../services/drafting";
import { assistantAuthorId } from "../assistant-identity";
import * as docs from "./documents";
import type { DemoTimeline } from "./timeline";
import { addr, approveAndSend, assistantDraft, clockAt, message, receive, recipientByKey, reviewAll, taskByKey, type Actors } from "./scenario";

/**
 * The station's other open and recently closed cases, each built through the same services an officer uses.
 * They are lighter than FIR 412/2026 but real: their holds, replies, decisions and deadlines drive the dashboard.
 */

const SYNTH = "This is a synthetic message created for demonstration. It is not a real communication.";

interface Spec {
  fir: number;
  io: SessionUser;
  registered: [number, string];
  title: string;
  sections: string;
  mo: string;
  complaint: { ack: string; channel: "NCRP_PORTAL" | "HELPLINE_1930"; at: [number, string]; category: string; label: string };
  victims: { name: string; loss: string; ownAccount: string }[];
  accounts?: { value: string; label: string; bank: string }[];
  upis?: { value: string; role: string }[];
  phones?: { value: string; role: string }[];
  people?: { name: string; role: "PERSON_OF_INTEREST" | "ACCOUNT_HOLDER_ON_RECORD" }[];
  payments: { victim: number; to: string; amount: string; at: [number, string]; ref: string; channel: string }[];
}

async function openCase(db: Db, T: DemoTimeline, s: Spec) {
  clockAt(T, ...s.complaint.at);
  const withheld = s.victims[0]!.name === "Withheld";
  await db.complaint.create({
    data: {
      ackNumber: s.complaint.ack,
      channel: s.complaint.channel,
      receivedAt: T.at(...s.complaint.at),
      category: s.complaint.category,
      categoryLabel: s.complaint.label,
      complainantName: withheld ? null : s.victims[0]!.name,
      lossAmountMinor: s.victims.reduce((sum, v) => sum + BigInt(v.loss.replace(/,/g, "")) * 100n, 0n),
      note: "",
      isSynthetic: true,
    },
  });
  clockAt(T, s.registered[0], s.registered[1]);
  const kase = await createCase(db, s.io, {
    referenceType: "FIR",
    firNumber: String(s.fir),
    firYear: "2026",
    complaintRef: s.complaint.ack,
    investigatingOfficerId: s.io.id,
    title: s.title,
    fraudCategory: s.title,
    legalSections: s.sections,
    reportedAt: T.input(...s.complaint.at),
    narrative: `${s.mo}. Synthetic demonstration case.`,
    parties: [...s.victims.map((v) => ({ name: v.name, role: "VICTIM" as const, lossRupees: v.loss })), ...(s.people ?? []).map((p) => ({ name: p.name, role: p.role }))],
    identifiers: [
      ...s.victims.map((v) => ({ kind: "BANK_ACCOUNT" as const, value: v.ownAccount, label: `${v.name === "Withheld" ? "Complainant" : v.name}'s account`, role: "Complainant's own account" })),
      ...(s.accounts ?? []).map((a) => ({ kind: "BANK_ACCOUNT" as const, value: a.value, label: a.label, role: "Reported beneficiary account", bank: a.bank })),
      ...(s.upis ?? []).map((u) => ({ kind: "UPI_ID" as const, value: u.value, role: u.role })),
      ...(s.phones ?? []).map((p) => ({ kind: "PHONE" as const, value: p.value, role: p.role })),
    ],
  });
  await db.case.update({ where: { id: kase.id }, data: { isDemo: true, registeredAt: T.at(s.registered[0], s.registered[1]), moSummary: s.mo } });
  await db.entity.updateMany({ where: { caseId: kase.id, kind: "PERSON" }, data: { isSynthetic: true } });
  const fir = await uploadEvidence(
    db,
    s.io,
    kase.id,
    {
      ...docs.simpleFirPdf({
        number: s.fir,
        registered: T.docTime(s.registered[0], s.registered[1]),
        complaintRef: s.complaint.ack,
        sections: s.sections,
        complainant: withheld ? "Withheld at the complainant's request" : `${s.victims[0]!.name} (synthetic)`,
        facts: [`${s.mo}.`],
        payments: s.payments.map((p) => `${T.docTime(p.at[0], p.at[1])} hrs: Rs. ${p.amount} paid by ${p.channel} to ${p.to}, ref ${p.ref}`),
        total: `Rs. ${s.victims.reduce((sum, v) => sum + Number(v.loss.replace(/,/g, "")), 0).toLocaleString("en-IN")}`,
      }),
      title: `FIR ${s.fir}/2026`,
      category: "FIR_COPY",
      sourceDescription: "Copy of the registered FIR, uploaded at intake",
      receivedAt: T.at(s.registered[0], s.registered[1]),
      isSynthetic: true,
    },
    { runExtraction: false },
  );
  const claims = await db.victimClaim.findMany({ where: { caseId: kase.id }, include: { victim: true }, orderBy: { createdAt: "asc" } });
  const ent = async (value: string) => db.entity.findFirstOrThrow({ where: { caseId: kase.id, value } });
  for (const p of s.payments) {
    const v = s.victims[p.victim]!;
    const claim = claims.find((c) => c.victim.label === v.name)!;
    await addManualTransaction(db, s.io, kase.id, {
      fromEntityId: (await ent(v.ownAccount)).id,
      toEntityId: (await ent(p.to)).id,
      amountRupees: p.amount,
      occurredAt: T.input(p.at[0], p.at[1]),
      channel: p.channel,
      reference: p.ref,
      kind: "VICTIM_PAYMENT",
      claimId: claim.id,
      sourceNote: "FIR, payments reported",
      evidenceId: fir.id,
      locator: "p. 1",
    });
  }
  return { kase, claims, ent, fir };
}

const holdLetter = (ref: string, acct: string, amount: string, asOf: string, holdRef: string, until?: string) => [
  `With reference to your request ${ref}, a lien of Rs. ${amount} has been marked on A/c No. ${acct} as on ${asOf} hrs.`,
  `Hold reference no. ${holdRef}`,
  ...(until ? [`The lien is valid until ${until}.`] : []),
  "Nodal Officer (synthetic), via CFCFRMS",
  SYNTH,
];

/** Assistant drafts the hold, the officer sends it, the bank confirms, the officer accepts the confirmation. */
async function holdConfirmed(db: Db, T: DemoTimeline, io: SessionUser, caseId: string, acct: { id: string; value: string }, bankKey: string, sent: [number, string], reply: [number, string], amount: string, holdRef: string, until?: number) {
  clockAt(T, sent[0], sent[1]);
  const r = await assistantDraft(db, io, caseId, `HOLD:${acct.id}`);
  await approveAndSend(db, T, io, io, r.id, sent[0], sent[1]);
  const res = await receive(db, io, caseId, message(addr(bankKey), `RE: ${r.reference} hold`, T.at(reply[0], reply[1]), holdLetter(r.reference, acct.value, amount, T.docTime(reply[0], reply[1]), holdRef, until !== undefined ? T.doc(until) : undefined)));
  await reviewAll(db, T, io, res.responseId, "COMPLETE", reply[0], `${reply[1].slice(0, 3)}${String(Math.min(59, Number(reply[1].slice(3)) + 15)).padStart(2, "0")}`);
  return db.hold.findFirstOrThrow({ where: { caseId, accountEntityId: acct.id } });
}

async function sendInfo(db: Db, T: DemoTimeline, io: SessionUser, caseId: string, key: string, at: [number, string]) {
  clockAt(T, at[0], at[1]);
  const r = await assistantDraft(db, io, caseId, key);
  await approveAndSend(db, T, io, io, r.id, at[0], at[1]);
  return r;
}

async function dismissKey(db: Db, T: DemoTimeline, io: SessionUser, caseId: string, key: string, at: [number, string], reason: string) {
  clockAt(T, at[0], at[1]);
  const t = await taskByKey(db, caseId, key);
  await dismissTask(db, io, t.id, t.version, reason);
}

export async function seedStationCases(db: Db, T: DemoTimeline, a: Actors) {
  // FIR 405/2026: fake customer care, single victim, the whole loss held; the restoration route is the officer's call.
  {
    const s = await openCase(db, T, {
      fir: 405, io: a.krishna, registered: [-10, "10:20"], title: "Fake customer care", sections: "BNS 318(4), IT Act 66C", mo: "A caller posing as bank customer care took a one-time password and moved the money",
      complaint: { ack: "33710260036651", channel: "HELPLINE_1930", at: [-11, "17:30"], category: "OTP", label: "Fake customer care" },
      victims: [{ name: "M. Farida", loss: "60,000", ownAccount: "XXXXXXXXXXXX0402" }],
      accounts: [{ value: "XXXXXXXXXXXX5521", label: "Account E1", bank: "Bank E" }],
      phones: [{ value: "+91-XXXXXXXX02", role: "Caller posing as customer care (used to contact the complainant)" }],
      payments: [{ victim: 0, to: "XXXXXXXXXXXX5521", amount: "60,000", at: [-11, "16:05"], ref: "IMPS4050660021", channel: "IMPS" }],
    });
    const acct = await s.ent("XXXXXXXXXXXX5521");
    const hold = await holdConfirmed(db, T, a.krishna, s.kase.id, acct, "bank-e", [-10, "10:45"], [-9, "11:30"], "60,000.00", "BE/405/1102");
    await sendInfo(db, T, a.krishna, s.kase.id, `SUBSCRIBER:${(await s.ent("+91-XXXXXXXX02")).id}`, [-5, "12:45"]);
    await sendInfo(db, T, a.krishna, s.kase.id, `INFO:${acct.id}`, [-3, "12:40"]);
    clockAt(T, -9, "12:50");
    const alloc = await proposeAllocation(db, a.krishna, s.kase.id, { holdId: hold.id, claimId: s.claims[0]!.id, amountRupees: "60,000", basis: "Single victim: the held money came only from her payment." });
    clockAt(T, -9, "15:00");
    await confirmAllocation(db, a.devi, alloc.id, { acknowledgeOverAllocation: false });
  }

  // FIR 398/2026: OTP fraud (SI P. Lavanya). Bank D refused to extend the hold, which lapses in two days.
  {
    const s = await openCase(db, T, {
      fir: 398, io: a.lavanya, registered: [-13, "15:10"], title: "OTP fraud", sections: "BNS 318(4), IT Act 66C, 66D", mo: "A caller sent a link, took the one-time passwords and made two transfers",
      complaint: { ack: "33710260031207", channel: "NCRP_PORTAL", at: [-13, "12:00"], category: "OTP", label: "OTP fraud" },
      victims: [{ name: "R. Prasad", loss: "2,40,000", ownAccount: "XXXXXXXXXXXX7730" }],
      accounts: [{ value: "XXXXXXXXXXXX3306", label: "Account D1", bank: "Bank D" }],
      payments: [
        { victim: 0, to: "XXXXXXXXXXXX3306", amount: "1,40,000", at: [-14, "19:20"], ref: "IMPS3980140001", channel: "IMPS" },
        { victim: 0, to: "XXXXXXXXXXXX3306", amount: "1,00,000", at: [-14, "19:34"], ref: "IMPS3980100002", channel: "IMPS" },
      ],
    });
    const acct = await s.ent("XXXXXXXXXXXX3306");
    await holdConfirmed(db, T, a.lavanya, s.kase.id, acct, "bank-d", [-13, "15:40"], [-12, "10:30"], "1,80,000.00", "BD/398/2231", 2);
    const parent = await db.request.findFirstOrThrow({ where: { caseId: s.kase.id, category: "HOLD" } });
    await sendInfo(db, T, a.lavanya, s.kase.id, `INFO:${acct.id}`, [-12, "11:40"]);
    clockAt(T, -2, "10:00");
    const ext = await createDraft(db, a.lavanya, {
      caseId: s.kase.id,
      category: "HOLD",
      recipientId: (await recipientByKey(db, "bank-d")).id,
      subject: `FIR 398/2026 · Account XXXXXXXXXXXX3306 · extension of the lien · {{requestReference}}`,
      body: `To the Nodal Officer, Bank D\n\nSir/Madam,\n\nIn FIR 398/2026 of PS Madhapur, the lien of Rs. 1,80,000 on account XXXXXXXXXXXX3306 (your reference BD/398/2231) is valid until ${T.doc(2)}. The investigation is continuing. Kindly extend the lien and confirm.\n\nKindly reply quoting {{requestReference}}.\n\nP. Lavanya, Sub-Inspector\nPS Madhapur, Cyberabad`,
      scope: "Extension of the lien on Account D1",
      periodFrom: null,
      periodTo: null,
      items: [{ label: "Confirmation that the lien is extended, and until when", itemType: "HOLD_CONFIRMATION" }],
      subjectEntityIds: [acct.id],
      parentRequestId: parent.id,
    });
    await approveAndSend(db, T, a.devi, a.lavanya, ext.id, -2, "10:35");
    await receive(db, a.lavanya, s.kase.id, message(addr("bank-d"), `RE: ${ext.reference} extension of the lien`, T.at(0, "08:40"), [`With reference to your request ${ext.reference}, the lien on A/c No. XXXXXXXXXXXX3306 cannot be extended without an order of the court.`, `The lien is valid until ${T.doc(2)}.`, "Nodal Officer, Bank D (synthetic)", SYNTH]));
  }

  // FIR 391/2026: loan-app extortion. Two replies awaited; the complainant has called twice for an update.
  {
    const s = await openCase(db, T, {
      fir: 391, io: a.krishna, registered: [-16, "11:00"], title: "Loan-app extortion", sections: "BNS 308, 351, IT Act 67", mo: "A loan app demanded repeated repayments and threatened to circulate edited photos",
      complaint: { ack: "33710260027744", channel: "NCRP_PORTAL", at: [-17, "20:10"], category: "LOAN", label: "Loan-app extortion" },
      victims: [{ name: "S. Anitha", loss: "35,000", ownAccount: "XXXXXXXXXXXX1188" }],
      upis: [{ value: "fastloan.recovery@okbnkf", role: "Reported beneficiary UPI ID (loan app's collection handle)" }],
      phones: [{ value: "+91-XXXXXXXX56", role: "Number the extortionist used to contact the complainant" }],
      payments: [{ victim: 0, to: "fastloan.recovery@okbnkf", amount: "35,000", at: [-18, "13:00"], ref: "391000350011", channel: "UPI" }],
    });
    const upi = await s.ent("fastloan.recovery@okbnkf");
    await dismissKey(db, T, a.krishna, s.kase.id, `HOLD:${upi.id}`, [-6, "09:55"], "No hold route for a UPI ID: the NPCI trace will name the account to hold");
    await sendInfo(db, T, a.krishna, s.kase.id, `SUBSCRIBER:${(await s.ent("+91-XXXXXXXX56")).id}`, [-6, "10:20"]);
    await sendInfo(db, T, a.krishna, s.kase.id, `INFO:${upi.id}`, [-4, "10:10"]);
    const victim = s.claims[0]!.victimEntityId;
    clockAt(T, -3, "18:10");
    await logContact(db, a.krishna, s.kase.id, { victimEntityId: victim, channel: "CALL_IN", summary: "Complainant called: wants an update on the case", followUp: "Call back with an update", nextDueAt: T.input(-2, "11:00") });
    clockAt(T, -1, "17:45");
    await logContact(db, a.krishna, s.kase.id, { victimEntityId: victim, channel: "CALL_IN", summary: "Complainant called again: wants an update on the case", followUp: "Call back with an update", nextDueAt: T.input(0, "11:00") });
  }

  // FIR 377/2026: job scam with four victims (SI M. Arjun). Shares a number and a name with FIR 412/2026.
  {
    const s = await openCase(db, T, {
      fir: 377, io: a.arjun, registered: [-22, "12:30"], title: "Job scam", sections: "BNS 318(4), IT Act 66D", mo: "A recruiter offered paid online tasks and took registration and upgrade fees",
      complaint: { ack: "33710260018802", channel: "NCRP_PORTAL", at: [-23, "10:00"], category: "JOB", label: "Job scam" },
      victims: [
        { name: "K. Vamsi", loss: "1,10,000", ownAccount: "XXXXXXXXXXXX0711" },
        { name: "S. Rekha", loss: "95,000", ownAccount: "XXXXXXXXXXXX0712" },
        { name: "T. Naveen", loss: "1,25,000", ownAccount: "XXXXXXXXXXXX0713" },
        { name: "B. Swathi", loss: "80,000", ownAccount: "XXXXXXXXXXXX0714" },
      ],
      accounts: [
        { value: "XXXXXXXXXXXX6120", label: "Account E2", bank: "Bank E" },
        { value: "XXXXXXXXXXXX7733", label: "Account F1", bank: "Bank F" },
      ],
      upis: [{ value: "jobs.desk@okbnke", role: "Reported beneficiary UPI ID (the recruiter's handle)" }],
      phones: [{ value: "+91-XXXXXXXX87", role: "Number the recruiter used to contact the victims" }],
      people: [{ name: "P1", role: "PERSON_OF_INTEREST" }],
      payments: [
        { victim: 0, to: "jobs.desk@okbnke", amount: "1,10,000", at: [-24, "12:10"], ref: "377011820311", channel: "UPI" },
        { victim: 1, to: "jobs.desk@okbnke", amount: "95,000", at: [-24, "16:40"], ref: "377011820322", channel: "UPI" },
        { victim: 2, to: "XXXXXXXXXXXX6120", amount: "1,25,000", at: [-23, "11:05"], ref: "IMPS3771250003", channel: "IMPS" },
        { victim: 3, to: "XXXXXXXXXXXX7733", amount: "80,000", at: [-23, "15:30"], ref: "IMPS3770800004", channel: "IMPS" },
      ],
    });
    const e2 = await s.ent("XXXXXXXXXXXX6120");
    const f1 = await s.ent("XXXXXXXXXXXX7733");
    const upi = await s.ent("jobs.desk@okbnke");
    const hE2 = await holdConfirmed(db, T, a.arjun, s.kase.id, e2, "bank-e", [-22, "13:00"], [-21, "11:20"], "70,000.00", "BE/377/0810");
    const hF1 = await holdConfirmed(db, T, a.arjun, s.kase.id, f1, "bank-f", [-22, "13:05"], [-21, "12:10"], "50,000.00", "BF/377/0144");
    // Each held account received one victim's money only; the officer proposes the split, a supervisor confirms it.
    clockAt(T, -2, "15:30");
    const claimOf = (name: string) => s.claims.find((c) => c.victim.label === name)!.id;
    await proposeAllocation(db, a.arjun, s.kase.id, { holdId: hE2.id, claimId: claimOf("T. Naveen"), amountRupees: "70,000", basis: "Account E2 received only T. Naveen's payment of Rs. 1,25,000 (IMPS3771250003)." });
    await proposeAllocation(db, a.arjun, s.kase.id, { holdId: hF1.id, claimId: claimOf("B. Swathi"), amountRupees: "50,000", basis: "Account F1 received only B. Swathi's payment of Rs. 80,000 (IMPS3770800004)." });
    await dismissKey(db, T, a.arjun, s.kase.id, `HOLD:${upi.id}`, [-22, "13:10"], "No hold route for a UPI ID: the NPCI trace will name the accounts");
    await sendInfo(db, T, a.arjun, s.kase.id, `INFO:${f1.id}`, [-13, "11:00"]);
    const npci = await sendInfo(db, T, a.arjun, s.kase.id, `INFO:${upi.id}`, [-10, "11:30"]);
    // Bank F has not replied: the reminder is due and the assistant has drafted it.
    clockAt(T, -1, "09:00");
    const { refreshRecommendations } = await import("../services/tasks");
    await refreshRecommendations(db, a.arjun, s.kase.id);
    const info = await db.request.findFirstOrThrow({ where: { caseId: s.kase.id, category: "INFORMATION", subjects: { some: { entityId: f1.id } } } });
    const follow = await db.task.findFirst({ where: { caseId: s.kase.id, dedupeKey: `FOLLOWUP:${info.id}` } });
    if (follow) await prepareDraftFromTask(db, a.arjun, follow.id, { asAssistant: true });
    await receive(db, a.arjun, s.kase.id, message(addr("npci-route"), `RE: ${npci.reference} beneficiary details`, T.at(-1, "17:20"), [`With reference to ${npci.reference}, beneficiary details for the UTRs found are attached. Two UTRs were not found as UPI transactions.`, "UPI law-enforcement desk, NPCI (synthetic)", SYNTH], [docs.npciBeneficiaries377(T)]));
  }

  // FIR 370/2026: sextortion; the held ₹20,000 is the subject of a restoration filing.
  {
    const s = await openCase(db, T, {
      fir: 370, io: a.krishna, registered: [-25, "16:00"], title: "Sextortion", sections: "BNS 308, IT Act 67", mo: "A video call was recorded and used to demand money",
      complaint: { ack: "33710260015530", channel: "NCRP_PORTAL", at: [-26, "09:30"], category: "SEXTORTION", label: "Sextortion" },
      victims: [{ name: "Withheld", loss: "20,000", ownAccount: "XXXXXXXXXXXX0370" }],
      accounts: [{ value: "XXXXXXXXXXXX4810", label: "Account D2", bank: "Bank D" }],
      payments: [{ victim: 0, to: "XXXXXXXXXXXX4810", amount: "20,000", at: [-26, "22:10"], ref: "IMPS3700200001", channel: "IMPS" }],
    });
    const acct = await s.ent("XXXXXXXXXXXX4810");
    const hold = await holdConfirmed(db, T, a.krishna, s.kase.id, acct, "bank-d", [-25, "16:20"], [-24, "12:00"], "20,000.00", "BD/370/1450");
    clockAt(T, -23, "11:00");
    const alloc = await proposeAllocation(db, a.krishna, s.kase.id, { holdId: hold.id, claimId: s.claims[0]!.id, amountRupees: "20,000", basis: "Single victim: the held money came only from the complainant's payment." });
    clockAt(T, -23, "15:00");
    await confirmAllocation(db, a.devi, alloc.id, { acknowledgeOverAllocation: false });
    clockAt(T, -3, "12:00");
    await recordRefund(db, a.krishna, s.kase.id, { claimId: s.claims[0]!.id, holdId: hold.id, amountRupees: "20,000", authorityReference: "Order in Crl.M.P. 1182/2026 (synthetic)", authorisedAt: T.input(-3, "11:30") });
  }

  // FIR 362/2026: courier-parcel scam (Inspector R. Devi). The payment app's reply about the VPA holder is in.
  {
    const s = await openCase(db, T, {
      fir: 362, io: a.devi, registered: [-29, "11:30"], title: "Courier-parcel scam", sections: "BNS 318(4), IT Act 66D", mo: "A caller claimed a parcel held at customs and demanded clearance fees",
      complaint: { ack: "33710260011906", channel: "NCRP_PORTAL", at: [-30, "16:00"], category: "COURIER", label: "Courier-parcel scam" },
      victims: [{ name: "D. Lokesh", loss: "1,50,000", ownAccount: "XXXXXXXXXXXX0362" }],
      upis: [{ value: "parcel.clear@okpay", role: "Reported beneficiary UPI ID" }],
      payments: [{ victim: 0, to: "parcel.clear@okpay", amount: "1,50,000", at: [-30, "14:20"], ref: "362001500021", channel: "UPI" }],
    });
    const upi = await s.ent("parcel.clear@okpay");
    await dismissKey(db, T, a.devi, s.kase.id, `HOLD:${upi.id}`, [-29, "11:50"], "No hold route for a UPI ID: the NPCI trace will name the account");
    await sendInfo(db, T, a.devi, s.kase.id, `INFO:${upi.id}`, [-20, "10:00"]);
    clockAt(T, -6, "10:00");
    const kyc = await createDraft(db, a.devi, {
      caseId: s.kase.id,
      category: "INFORMATION",
      recipientId: (await recipientByKey(db, "payment-app")).id,
      subject: "FIR 362/2026 · KYC of the VPA holder · parcel.clear@okpay · {{requestReference}}",
      body: "Sir/Madam,\n\nIn FIR 362/2026 of PS Madhapur (BNS 318(4), IT Act 66D), Rs. 1,50,000 was paid to the VPA parcel.clear@okpay registered with your app.\n\nKindly furnish:\n- The VPA holder's name, registered mobile number and linked bank account\n\nKindly reply quoting {{requestReference}}.\n\nR. Devi, Inspector\nPS Madhapur, Cyberabad",
      scope: "KYC of the VPA holder",
      periodFrom: null,
      periodTo: null,
      items: [{ label: "VPA holder's name, registered mobile number and linked bank account", itemType: "KYC" }],
      subjectEntityIds: [upi.id],
      allowDuplicateReason: "The payment app holds the KYC directly; NPCI's trace is still awaited.",
      authorId: await assistantAuthorId(db, s.kase.stationId),
    });
    clockAt(T, -6, "10:20");
    const p = await requestApproval(db, a.devi, kyc.id, kyc.version);
    const ap = await approveRequest(db, a.devi, kyc.id, p.version, "Checked.");
    await submitRequest(db, a.devi, kyc.id, { expectedVersion: ap.version, confirmed: true, idempotencyKey: `seed:${kyc.reference}`, direct: true });
    await receive(db, a.devi, s.kase.id, message(addr("payment-app"), `RE: ${kyc.reference} KYC of the VPA holder`, T.at(0, "07:05"), [`With reference to ${kyc.reference}, the VPA parcel.clear@okpay is registered as follows.`, "Account holder name: R. Kumar", "Registered mobile: +91-XXXXXXXX73", "Linked account: XXXXXXXXXXXX9045, Bank F", "LEA desk, Payment app (synthetic)", SYNTH]));
  }

  // FIR 355/2026: trading-app fraud. ₹1,20,000 already returned; ₹3,00,000 still held. Paid into the same Account A.
  {
    const s = await openCase(db, T, {
      fir: 355, io: a.krishna, registered: [-32, "10:00"], title: "Trading-app fraud", sections: "BNS 318(4), IT Act 66D", mo: "A trading app showed fake profits and blocked withdrawals",
      complaint: { ack: "33710260008123", channel: "NCRP_PORTAL", at: [-33, "18:30"], category: "INVESTMENT", label: "Trading-app fraud" },
      victims: [{ name: "P. Nagaraju", loss: "7,80,000", ownAccount: "XXXXXXXXXXXX0355" }],
      accounts: [
        { value: "XXXXXXXXXXXX4471", label: "Account A", bank: "Bank A" },
        { value: "XXXXXXXXXXXX9902", label: "Account D3", bank: "Bank D" },
      ],
      payments: [
        { victim: 0, to: "XXXXXXXXXXXX4471", amount: "4,00,000", at: [-34, "11:00"], ref: "IMPS3554000001", channel: "IMPS" },
        { victim: 0, to: "XXXXXXXXXXXX9902", amount: "3,80,000", at: [-33, "12:30"], ref: "IMPS3553800002", channel: "IMPS" },
      ],
    });
    const aAcct = await s.ent("XXXXXXXXXXXX4471");
    const dAcct = await s.ent("XXXXXXXXXXXX9902");
    const holdA = await holdConfirmed(db, T, a.krishna, s.kase.id, aAcct, "bank-a", [-32, "10:30"], [-31, "11:00"], "1,20,000.00", "BA/355/0091");
    const holdD = await holdConfirmed(db, T, a.krishna, s.kase.id, dAcct, "bank-d", [-32, "10:35"], [-31, "12:00"], "3,00,000.00", "BD/355/0302");
    const claim = s.claims[0]!.id;
    for (const [h, amt] of [[holdA, "1,20,000"], [holdD, "3,00,000"]] as const) {
      clockAt(T, -30, "11:00");
      const al = await proposeAllocation(db, a.krishna, s.kase.id, { holdId: h.id, claimId: claim, amountRupees: amt, basis: "Single victim: the held money came only from his payments." });
      clockAt(T, -30, "15:00");
      await confirmAllocation(db, a.devi, al.id, { acknowledgeOverAllocation: false });
    }
    clockAt(T, -22, "12:00");
    const refund = await recordRefund(db, a.krishna, s.kase.id, { claimId: claim, holdId: holdA.id, amountRupees: "1,20,000", authorityReference: "Order in Crl.M.P. 1009/2026 (synthetic)", authorisedAt: T.input(-22, "11:30") });
    clockAt(T, -19, "11:00");
    await advanceRefund(db, a.krishna, refund.id, { to: "INITIATED", at: T.input(-19, "11:00"), note: "Bank A confirmed it has initiated the transfer to the victim's account." });
    clockAt(T, -16, "16:00");
    await advanceRefund(db, a.krishna, refund.id, { to: "CREDIT_CONFIRMED", at: T.input(-16, "15:40"), note: "The victim's bank confirmed the credit of Rs. 1,20,000." });
    await recordHoldChange(db, a.krishna, holdA.id, { type: "RELEASED", amountRupees: null, at: T.input(-16, "16:10"), note: "Released after the restoration was credited to the victim." });
    clockAt(T, -6, "12:00");
    await recordRefund(db, a.krishna, s.kase.id, { claimId: claim, holdId: holdD.id, amountRupees: "3,00,000", authorityReference: "Order in Crl.M.P. 1206/2026 (synthetic)", authorisedAt: T.input(-6, "11:30") });
  }

  // Closed this month: FIR 341/2026 (fully returned) and FIR 326/2026 (charge sheet filed).
  {
    const s = await openCase(db, T, {
      fir: 341, io: a.krishna, registered: [-40, "12:00"], title: "UPI collect-request fraud", sections: "BNS 318(4), IT Act 66D", mo: "A buyer on a resale site sent a collect request instead of a payment",
      complaint: { ack: "33710260001250", channel: "NCRP_PORTAL", at: [-41, "19:00"], category: "UPI", label: "UPI collect-request fraud" },
      victims: [{ name: "G. Sravani", loss: "45,000", ownAccount: "XXXXXXXXXXXX0341" }],
      accounts: [{ value: "XXXXXXXXXXXX2215", label: "Account E3", bank: "Bank E" }],
      payments: [{ victim: 0, to: "XXXXXXXXXXXX2215", amount: "45,000", at: [-41, "18:00"], ref: "UPI3410450001", channel: "UPI" }],
    });
    const acct = await s.ent("XXXXXXXXXXXX2215");
    const hold = await holdConfirmed(db, T, a.krishna, s.kase.id, acct, "bank-e", [-40, "12:30"], [-39, "11:00"], "45,000.00", "BE/341/0207");
    clockAt(T, -38, "11:00");
    const al = await proposeAllocation(db, a.krishna, s.kase.id, { holdId: hold.id, claimId: s.claims[0]!.id, amountRupees: "45,000", basis: "Single victim." });
    clockAt(T, -38, "15:00");
    await confirmAllocation(db, a.devi, al.id, { acknowledgeOverAllocation: false });
    clockAt(T, -20, "12:00");
    const refund = await recordRefund(db, a.krishna, s.kase.id, { claimId: s.claims[0]!.id, holdId: hold.id, amountRupees: "45,000", authorityReference: "Order in Crl.M.P. 0961/2026 (synthetic)", authorisedAt: T.input(-20, "11:30") });
    clockAt(T, -15, "11:00");
    await advanceRefund(db, a.krishna, refund.id, { to: "INITIATED", at: T.input(-15, "11:00"), note: "Bank E confirmed it has initiated the transfer to the victim's account." });
    clockAt(T, -12, "16:00");
    await advanceRefund(db, a.krishna, refund.id, { to: "CREDIT_CONFIRMED", at: T.input(-12, "15:30"), note: "The victim's bank confirmed the credit of Rs. 45,000." });
    clockAt(T, -9, "17:00");
    const c = await db.case.findUniqueOrThrow({ where: { id: s.kase.id } });
    await setCaseStatus(db, a.krishna, s.kase.id, { expectedVersion: c.version, status: "CLOSED", reason: "The loss was fully returned to the victim." });
  }
  {
    const s = await openCase(db, T, {
      fir: 326, io: a.lavanya, registered: [-48, "12:00"], title: "Loan-app harassment", sections: "BNS 351, IT Act 67", mo: "A loan app's agents sent threatening messages to the complainant's contacts",
      complaint: { ack: "33710260000317", channel: "NCRP_PORTAL", at: [-49, "10:00"], category: "LOAN", label: "Loan-app harassment" },
      victims: [{ name: "Withheld", loss: "12,000", ownAccount: "XXXXXXXXXXXX0326" }],
      upis: [{ value: "quickcash.rec@okbnkf", role: "Reported beneficiary UPI ID" }],
      payments: [{ victim: 0, to: "quickcash.rec@okbnkf", amount: "12,000", at: [-50, "15:00"], ref: "326000120001", channel: "UPI" }],
    });
    clockAt(T, -18, "15:00");
    await db.case.update({ where: { id: s.kase.id }, data: { chargeSheetedAt: T.at(-18, "15:00") } });
    await db.$transaction((tx) => recordAudit(tx, { caseId: s.kase.id, actorId: a.lavanya.id, action: "case.charge_sheeted", objectType: "Case", objectId: s.kase.id, summary: "Charge sheet filed against the accused identified through the CAF (synthetic)", at: T.at(-18, "15:00") }));
    const c = await db.case.findUniqueOrThrow({ where: { id: s.kase.id } });
    await setCaseStatus(db, a.lavanya, s.kase.id, { expectedVersion: c.version, status: "CLOSED", reason: "Charge sheet filed; the case moves to court." });
  }
}
