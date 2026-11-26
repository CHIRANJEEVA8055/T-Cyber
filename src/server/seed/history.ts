import crypto from "node:crypto";
import type { Db } from "../db";
import { refreshRecommendationsTx } from "../services/tasks";
import { getAppConfig } from "../config";
import type { DemoTimeline } from "./timeline";
import type { Actors } from "./scenario";
import { formatDayMonthIST } from "@/domain/time";
import { formatRequestRef } from "@/domain/request-ref";

/**
 * The station's history: older and lighter cases that carry the other officers' workload, and six months of
 * NCRP / 1930 complaints, so every dashboard figure is counted from rows rather than typed in. Inserted directly
 * (not replayed through the services) because only their totals matter; each is labelled synthetic.
 */

function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

const NAMES = ["A. Ramesh", "B. Kavitha", "C. Suresh", "D. Mounika", "E. Raju", "F. Swapna", "G. Mahesh", "H. Lakshmi", "I. Venkat", "J. Divya", "K. Srikanth", "L. Bhavani", "M. Naresh", "N. Haritha", "O. Prakash", "P. Sirisha", "Q. Anil", "R. Madhavi", "S. Kiran", "T. Sunitha", "U. Ravi", "V. Pavani", "W. Gopal", "X. Jyothi"];
const KINDS = [
  { category: "INVESTMENT", labels: ["Investment-app fraud", "Trading-app fraud"], sections: "BNS 318(4), IT Act 66D" },
  { category: "OTP", labels: ["OTP fraud", "Fake customer care"], sections: "BNS 318(4), IT Act 66C, 66D" },
  { category: "JOB", labels: ["Job scam"], sections: "BNS 318(4), IT Act 66D" },
  { category: "LOAN", labels: ["Loan-app extortion"], sections: "BNS 308, 351, IT Act 67" },
  { category: "COURIER", labels: ["Courier-parcel scam"], sections: "BNS 318(4), IT Act 66D" },
  { category: "UPI", labels: ["UPI collect-request fraud"], sections: "BNS 318(4), IT Act 66D" },
];
const BANKS = ["bank-a", "bank-b", "bank-c", "bank-d", "bank-e", "bank-f"];

/** Monthly complaint targets, oldest first, the last being the current month so far (₹ in lakh). */
const MONTHS = [
  { lakh: 14.2, count: 15 },
  { lakh: 11.8, count: 13 },
  { lakh: 17.5, count: 18 },
  { lakh: 15.1, count: 18 },
  { lakh: 24.6, count: 24 },
  { lakh: 9.3, count: 21 },
];

const HELD = [52000, 35000, 41500, 18000, 60000, 25000, 47000, 30000, 22500, 55000, 38000, 16000, 40000];
const FIRS = [404, 401, 399, 396, 393, 389, 386, 383, 380, 375, 372, 368, 365, 359, 351, 348, 344, 338, 335, 331, 322, 318, 314, 309, 305, 301, 297, 292, 288, 284];
const CLOSED_FIRS = [279, 271, 266, 259, 251, 244, 236, 228, 219, 211, 204, 198];

const L = (rupees: number) => BigInt(Math.round(rupees)) * 100n;
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

export async function seedHistory(db: Db, T: DemoTimeline, a: Actors) {
  const rand = rng(2026);
  const pick = <X>(xs: readonly X[]) => xs[Math.floor(rand() * xs.length)]!;
  const station = await db.station.findUniqueOrThrow({ where: { code: getAppConfig().station.code } });
  const recipients = Object.fromEntries(await Promise.all(BANKS.map(async (k) => [k, await db.recipient.findUniqueOrThrow({ where: { configKey: k } })] as const)));
  const officers = [...Array(7).fill(a.krishna), ...Array(8).fill(a.lavanya), ...Array(8).fill(a.arjun), ...Array(7).fill(a.devi)];
  let heldIx = 0;
  let ackSeq = 4400;

  const makeCase = async (fir: number, io: (typeof officers)[number], regOffset: number, open: boolean) => {
    const kind = pick(KINDS);
    const label = pick(kind.labels);
    const loss = Math.round((15000 + rand() * 285000) / 500) * 500;
    const name = rand() < 0.12 ? "Withheld" : pick(NAMES);
    const regAt = T.at(regOffset, `${String(10 + Math.floor(rand() * 7)).padStart(2, "0")}:${String(Math.floor(rand() * 60)).padStart(2, "0")}`);
    const ack = `337102600${String(ackSeq++).padStart(5, "0")}`;
    const kase = await db.case.create({
      data: {
        stationId: station.id,
        referenceType: "FIR",
        firNumber: fir,
        firYear: 2026,
        complaintRef: ack,
        title: label,
        fraudCategory: label,
        legalSections: kind.sections,
        narrative: "Station history (synthetic): only its totals are used on the dashboard.",
        complaintChannel: rand() < 0.4 ? "HELPLINE_1930" : "NCRP_PORTAL",
        complaintReceivedAt: new Date(regAt.getTime() - 20 * 3600 * 1000),
        registeredAt: regAt,
        status: open ? "OPEN" : "CLOSED",
        closureReason: open ? null : rand() < 0.5 ? "The loss was returned to the victim." : "No further lead; closed with the supervisor's approval.",
        isDemo: true,
        createdById: io.id,
        createdAt: regAt,
        assignments: { create: { userId: io.id, role: "INVESTIGATING_OFFICER", assignedAt: regAt } },
      },
    });
    await db.complaint.create({ data: { ackNumber: ack, channel: kase.complaintChannel!, receivedAt: kase.complaintReceivedAt!, category: kind.category, categoryLabel: label, complainantName: name === "Withheld" ? null : name, lossAmountMinor: L(loss), status: "REGISTERED", caseId: kase.id, isSynthetic: true } });
    const victim = await db.entity.create({ data: { caseId: kase.id, kind: "PERSON", label: name, value: name, normalizedValue: `person:${crypto.randomUUID()}`, belongsTo: "VICTIM", isSynthetic: true, discoveredAt: regAt } });
    await db.partyRole.create({ data: { caseId: kase.id, entityId: victim.id, role: "VICTIM", basis: "FIR" } });
    const claim = await db.victimClaim.create({ data: { caseId: kase.id, victimEntityId: victim.id, lossAmountMinor: L(loss), basis: "FIR", createdAt: regAt } });
    const bankKey = pick(BANKS);
    const bank = recipients[bankKey]!;
    const own = await db.entity.create({ data: { caseId: kase.id, kind: "BANK_ACCOUNT", label: `${name === "Withheld" ? "Complainant" : name}'s account`, value: `XXXXXXXXXXXX${String(1000 + fir).slice(-4)}`, normalizedValue: `XXXXXXXXXXXX${String(1000 + fir).slice(-4)}`, caseRole: "Complainant's own account", attributesJson: JSON.stringify({ isVictimAccount: true }), isMasked: true, isSynthetic: true, discoveredAt: regAt } });
    const benValue = `XXXXXXXXXXXX${String(Math.floor(rand() * 9000) + 1000)}`;
    const ben = await db.entity.create({ data: { caseId: kase.id, kind: "BANK_ACCOUNT", label: "Account A", value: benValue, normalizedValue: benValue, caseRole: "Reported beneficiary account", attributesJson: JSON.stringify({ bank: bank.organisation }), isMasked: true, isSynthetic: true, discoveredAt: regAt } });
    const paidAt = new Date(regAt.getTime() - 26 * 3600 * 1000);
    await db.transaction.create({ data: { caseId: kase.id, fromEntityId: own.id, toEntityId: ben.id, amountMinor: L(loss), occurredAt: paidAt, channel: pick(["UPI", "IMPS", "NEFT"]), reference: `HIST${fir}${String(loss).slice(0, 4)}`, kind: "VICTIM_PAYMENT", layer: 1, claimId: claim.id, status: "CONFIRMED_BY_BANK", discoveredAt: regAt, dedupeKey: `HIST:${fir}`, createdAt: regAt } });
    await db.auditEvent.create({ data: { caseId: kase.id, actorId: io.id, at: regAt, action: "case.created", objectType: "Case", objectId: kase.id, summary: `FIR ${fir}/2026 workspace opened (station history, synthetic)` } });
    if (!open) {
      await db.auditEvent.create({ data: { caseId: kase.id, actorId: io.id, at: new Date(regAt.getTime() + 62 * 24 * 3600 * 1000), action: "case.closed", objectType: "Case", objectId: kase.id, summary: `Case closed by officer decision: ${kase.closureReason} (station history)` } });
    }

    // Requests in a spread of states, as a station's open cases have them.
    // Most requests are answered, a third or so wait for replies, a few are overdue or not yet sent.
    const plans = open ? ["ANSWERED", "ANSWERED", "ANSWERED", "ANSWERED", rand() < 0.4 ? "WAITING" : "ANSWERED", rand() < 0.88 ? "WAITING" : "DUE", rand() < 0.3 ? "DRAFT" : "WAITING"] : ["ANSWERED", "ANSWERED", "ANSWERED"];
    let seq = 0;
    for (const plan of plans) {
      seq++;
      const createdAt = new Date(regAt.getTime() + seq * 30 * 3600 * 1000);
      if (createdAt > T.at(0, "08:00")) break;
      const category = seq === 1 ? "HOLD" : "INFORMATION";
      const reference = formatRequestRef(getAppConfig().requests.referencePrefix, `${fir}/2026`, seq, category);
      const subject = `FIR ${fir}/2026 · ${ben.label} ${benValue} · ${category === "HOLD" ? "hold request" : "statement and KYC"} · ${reference}`;
      const body = `Station history (synthetic). ${subject}`;
      const sent = plan !== "DRAFT";
      const followUpAt = sent ? new Date(createdAt.getTime() + (plan === "DUE" ? 3 : 40) * 24 * 3600 * 1000) : null;
      const status = plan === "DRAFT" ? "DRAFT" : plan === "ANSWERED" ? "COMPLETE_RESPONSE" : "SUBMITTED";
      const req = await db.request.create({
        data: {
          caseId: kase.id,
          reference,
          caseSeq: seq,
          category,
          status,
          recipientId: bank.id,
          channel: bank.channel,
          createdById: io.id,
          createdAt,
          submittedAt: sent ? new Date(createdAt.getTime() + 3600 * 1000) : null,
          followUpAt: plan === "DUE" ? new Date(Math.min(followUpAt!.getTime(), T.at(-2, "10:00").getTime())) : plan === "WAITING" ? new Date(Math.max(followUpAt!.getTime(), T.at(3, "10:00").getTime())) : null,
          externalReference: sent ? `SIM-EMAIL-${reference}` : null,
          approvedVersionNo: sent ? 1 : null,
          approvedHash: sent ? sha(body) : null,
          versions: { create: { versionNo: 1, recipientId: bank.id, subject, body, scope: category === "HOLD" ? "Hold" : "Statement and KYC", contentHash: sha(body), basisJson: "{}", createdById: io.id, createdAt } },
          items: { create: [{ label: category === "HOLD" ? "Confirmation of the hold" : "The account statement for the period", itemType: category === "HOLD" ? "HOLD_CONFIRMATION" : "STATEMENT", status: plan === "ANSWERED" ? "RECEIVED" : "PENDING", sortOrder: 0 }] },
          subjects: { create: [{ entityId: ben.id }] },
        },
      });
      if (sent) {
        await db.submission.create({ data: { requestId: req.id, versionNo: 1, adapter: "Simulated email gateway (station history)", attemptedAt: req.submittedAt!, outcome: "SUCCEEDED", externalReference: req.externalReference, recipientAddress: bank.address, actorId: io.id, idempotencyKey: `hist:${reference}` } });
        await db.auditEvent.create({ data: { caseId: kase.id, actorId: io.id, at: req.submittedAt!, action: "request.submitted", objectType: "Request", objectId: req.id, summary: `${reference} sent to ${bank.name} (simulated)` } });
      }
      if (plan === "ANSWERED") {
        const receivedAt = new Date(req.submittedAt!.getTime() + 2 * 24 * 3600 * 1000);
        if (receivedAt > T.at(0, "08:00")) continue;
        const resp = await db.response.create({ data: { caseId: kase.id, requestId: req.id, matchStatus: "MATCHED", matchBasis: "Quoted the request reference (station history).", fromAddress: bank.address, toAddress: getAppConfig().mailbox.fromAddress, subject: `RE: ${reference}`, receivedAt, bodyText: "Station history (synthetic reply).", channel: "EMAIL", responseType: "COMPLETE", reviewStatus: "APPLIED", appliedAt: receivedAt, appliedById: io.id, matchScore: 95, fingerprint: sha(`hist:${reference}`), importedById: io.id, importedAt: receivedAt } });
        await db.auditEvent.create({ data: { caseId: kase.id, actorId: io.id, at: receivedAt, action: "response.applied", objectType: "Response", objectId: resp.id, summary: `Reply to ${reference} reviewed (station history)` } });
      }
    }

    // About half of the open cases have money held.
    if (open && heldIx < HELD.length && rand() < 0.62) {
      const amount = Math.min(HELD[heldIx++]!, loss);
      const hold = await db.hold.create({ data: { caseId: kase.id, accountEntityId: ben.id, holdKey: `${bank.organisation}:${benValue}`, bankReference: `HIST/${fir}`, status: "CONFIRMED_HELD", confirmedAmountMinor: L(amount), confirmedAsOf: new Date(regAt.getTime() + 40 * 3600 * 1000), createdAt: regAt } });
      await db.holdEvent.create({ data: { holdId: hold.id, caseId: kase.id, at: hold.confirmedAsOf!, recordedAt: hold.confirmedAsOf!, type: "AMOUNT_CONFIRMED", amountMinor: L(amount), note: "Station history (synthetic).", actorId: io.id } });
    }
    if (!open && rand() < 0.5) {
      const refundAt = new Date(regAt.getTime() + 25 * 24 * 3600 * 1000);
      await db.refund.create({ data: { caseId: kase.id, claimId: claim.id, amountMinor: L(loss), status: "CREDIT_CONFIRMED", authorityReference: `Order (station history, synthetic) ${fir}/2026`, authorisedAt: refundAt, initiatedAt: refundAt, creditConfirmedAt: refundAt, createdById: io.id, createdAt: refundAt } });
    }
    return kase;
  };

  const ids: string[] = [];
  for (const [i, fir] of FIRS.entries()) {
    const kase = await makeCase(fir, officers[i]!, -(36 + i * 4), true);
    ids.push(kase.id);
  }
  for (const [i, fir] of CLOSED_FIRS.entries()) {
    const kase = await makeCase(fir, pick([a.krishna, a.lavanya, a.arjun, a.devi]), -(90 + i * 9), false);
    if (i < 2) await db.case.update({ where: { id: kase.id }, data: { chargeSheetedAt: new Date(kase.registeredAt!.getTime() + 60 * 24 * 3600 * 1000), closureReason: "Charge sheet filed; the case moves to court." } });
    ids.push(kase.id);
  }
  for (const id of ids) await db.$transaction((tx) => refreshRecommendationsTx(tx, id, null, T.at(0, "08:00")));

  // The complaint register: top each month up to its total with complaints handled without an FIR.
  const anchor = new Date(`${T.anchor}T00:00:00+05:30`);
  for (const [i, m] of MONTHS.entries()) {
    const monthsBack = MONTHS.length - 1 - i;
    const start = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() - monthsBack, 1) - 330 * 60 * 1000);
    const end = monthsBack === 0 ? T.at(0, "08:00") : new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() - monthsBack + 1, 1) - 330 * 60 * 1000);
    const existing = await db.complaint.aggregate({ where: { receivedAt: { gte: start, lt: end } }, _sum: { lossAmountMinor: true }, _count: true });
    const n = m.count - existing._count;
    if (n <= 0) continue;
    // Exactly n complaints whose losses add up to what the month still needs (small ones if nothing is left).
    const left = Math.max(n * 5000, Math.round(m.lakh * 100000 - Number((existing._sum.lossAmountMinor ?? 0n) / 100n)));
    const weights = Array.from({ length: n }, () => 0.4 + rand() * 1.2);
    const total = weights.reduce((a, b) => a + b, 0);
    const amounts = weights.map((w) => Math.max(500, Math.round((left * w) / total / 100) * 100));
    amounts[n - 1] = Math.max(500, left - amounts.slice(0, -1).reduce((a, b) => a + b, 0));
    for (const amount of amounts) {
      const at = new Date(start.getTime() + rand() * (end.getTime() - start.getTime()));
      const kind = pick(KINDS);
      const name = rand() < 0.15 ? null : pick(NAMES);
      await db.complaint.create({ data: { ackNumber: `337102600${String(ackSeq++).padStart(5, "0")}`, channel: rand() < 0.45 ? "HELPLINE_1930" : "NCRP_PORTAL", receivedAt: at, category: kind.category, categoryLabel: pick(kind.labels), complainantName: name, lossAmountMinor: L(amount), status: "CLOSED_NO_FIR", note: "Handled through the 1930 hold and refund process; no FIR needed (station history, synthetic).", isSynthetic: true } });
    }
  }
}

/** NCRP and 1930 complaints still waiting for an FIR at the station. */
export async function seedAwaitingFir(db: Db, T: DemoTimeline) {
  const rows = [
    { ackNumber: "33710260071203", channel: "HELPLINE_1930", at: T.at(-1, "08:10"), category: "INVESTMENT", categoryLabel: "Investment-app fraud", complainantName: "M. Srinivas", loss: 215000, held: 140000, note: "1930 placed a hold of ₹1,40,000. Statement taken; FIR to register." },
    { ackNumber: "33710260070844", channel: "NCRP_PORTAL", at: T.at(-2, "13:40"), category: "OTP", categoryLabel: "OTP fraud", complainantName: "K. Padma", loss: 48000, held: 0, note: `Victim statement taken on ${formatDayMonthIST(T.at(-2, "12:00"))}. Nothing held yet.` },
    { ackNumber: "33710260069512", channel: "NCRP_PORTAL", at: T.at(-3, "19:05"), category: "INVESTMENT", categoryLabel: "Trading-app fraud", complainantName: null, loss: 360000, held: 0, note: `Bank E has not confirmed the hold. Complainant coming in on ${formatDayMonthIST(T.at(2, "12:00"))}.` },
    { ackNumber: "33710260067990", channel: "HELPLINE_1930", at: T.at(-6, "11:25"), category: "COURIER", categoryLabel: "Courier-parcel scam", complainantName: "R. Mahesh", loss: 12500, held: 0, note: "Complainant not reachable; 2 calls logged." },
  ];
  for (const r of rows) {
    await db.complaint.create({ data: { ackNumber: r.ackNumber, channel: r.channel, receivedAt: r.at, category: r.category, categoryLabel: r.categoryLabel, complainantName: r.complainantName, lossAmountMinor: L(r.loss), heldAmountMinor: L(r.held), note: r.note, status: "AWAITING_FIR", isSynthetic: true } });
  }
}
