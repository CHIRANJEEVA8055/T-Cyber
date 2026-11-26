import { istInputToUtc } from "@/domain/time";
import { listOf, manualFirSchema, type ManualFir, type ManualFirInput } from "@/contracts/manual-fir";
import { normalizeIdentifier, isMaskedValue } from "@/domain/identifiers";
import { parseRupeesToMinor } from "@/domain/money";
import { verticalByKey } from "@/domain/mo-verticals";
import { decideMo, type MoDecision } from "../ai/mo-classify";
import { storeMo } from "./case-mo";
import { shortRank } from "@/lib/cn";
import { preparedFirPdf } from "../documents/fir-copy";
import { getAppConfig } from "../config";
import type { Db } from "../db";
import type { SessionUser } from "../auth/session";
import { AppError } from "../errors";
import { assertCaseWorker } from "../auth/access";
import { recordAudit } from "../audit";
import { createCase } from "./cases";
import { insertEvidenceTx, prepareEvidence, runExtractionTx, uploadEvidence } from "./evidence";
import { addManualTransaction } from "./funds";
import { readFirCopy, verticalOfDecision } from "./fir-reading";
import { now } from "../clock";

/**
 * Opening a case from the New FIR window. The copy is read again here (nothing the browser sends about its
 * contents is trusted), the case is created from what it states, the original is kept with its hash, and any
 * reading the local model made is kept beside it as a derived document for the officer to check.
 */
export async function openCaseFromFir(db: Db, user: SessionUser, file: { name: string; buffer: Buffer }, opts: { ack?: string | null } = {}) {
  assertCaseWorker(user);
  const reading = await readFirCopy(file);
  if (!reading.readable || !reading.proposal || !reading.brief) throw new AppError(reading.note ?? "The copy could not be read. Enter the details by hand.", "VALIDATION");
  const f = reading.proposal.fields;
  if (!f.firNumber || !f.firYear) throw new AppError("The copy does not show an FIR number the reader can use. Enter the case by hand.", "VALIDATION", { file: "The FIR number could not be read." });
  const victims = reading.proposal.parties.map((p) => ({ name: p.name.replace(/\s*\(synthetic\)$/, ""), role: p.role, lossRupees: p.lossRupees }));
  const kase = await createCase(db, user, {
    referenceType: "FIR",
    firNumber: f.firNumber,
    firYear: f.firYear,
    complaintRef: f.complaintRef ?? opts.ack ?? undefined,
    investigatingOfficerId: user.id,
    title: reading.brief.kind.label,
    fraudCategory: reading.brief.kind.label,
    incidentStart: f.incidentStart,
    incidentEnd: f.incidentEnd,
    reportedAt: f.reportedAt,
    legalSections: f.legalSections,
    narrative: f.narrative ?? "",
    parties: victims,
    identifiers: [],
  });
  if (f.reportedAt) await db.case.update({ where: { id: kase.id }, data: { registeredAt: new Date(`${f.reportedAt}:00+05:30`) } });
  // The vertical decided while the copy was read: as the FIR states it, or by the local model from the brief.
  await storeMo(db, user, kase.id, reading.brief.mo);
  const original = await uploadEvidence(db, user, kase.id, { fileName: file.name, buffer: file.buffer, title: `FIR ${f.firNumber}/${f.firYear}`, category: "FIR_COPY", sourceDescription: "Copy uploaded in the New FIR window", receivedAt: now() }, { runExtraction: reading.how === "TEXT" });
  if (reading.modelText) {
    const kind = reading.how === "TRANSLATED" ? "TRANSLATION" : "TRANSCRIPTION";
    const prepared = await prepareEvidence({
      fileName: `${file.name.replace(/\.[^.]+$/, "")}_${kind === "TRANSLATION" ? "english" : "transcript"}.txt`,
      buffer: Buffer.from(`${kind === "TRANSLATION" ? `English translation of ${file.name} by the local model (${reading.modelUsed}).` : `Transcription of ${file.name} by the local model (${reading.modelUsed}).`}\nCheck every detail against the original before relying on it.\n\n${reading.modelText}\n`),
      title: kind === "TRANSLATION" ? `FIR ${f.firNumber}/${f.firYear}: English translation (local model)` : `FIR ${f.firNumber}/${f.firYear}: transcription (local model)`,
      category: "OTHER",
      sourceDescription: `Made by the local model ${reading.modelUsed} from the uploaded copy; not evidence in itself`,
      receivedAt: now(),
      parentId: original.id,
      derivation: kind,
    });
    await db.$transaction(async (tx) => {
      const item = await insertEvidenceTx(tx, user.id, kase.id, prepared);
      await runExtractionTx(tx, user.id, item.id);
      await recordAudit(tx, { caseId: kase.id, actorId: user.id, action: "evidence.derived_added", objectType: "EvidenceItem", objectId: item.id, summary: `${item.title} added beside the original, to be checked against it` });
    });
  }
  await db.$transaction((tx) =>
    recordAudit(tx, {
      caseId: kase.id,
      actorId: user.id,
      action: "fir.read",
      objectType: "EvidenceItem",
      objectId: original.id,
      summary: `FIR copy read in the New FIR window: ${reading.found?.total ?? 0} details found, ${reading.found?.check ?? 0} to check${reading.modelUsed ? `; ${reading.how === "TRANSLATED" ? "translated" : "transcribed"} by the local model ${reading.modelUsed}` : "; read by rules from its text"}`,
    }),
  );
  return { caseId: kase.id, reading };
}

const MODE: Record<string, string> = { UPI: "UPI", "IMPS or NEFT": "IMPS", RTGS: "RTGS", Card: "CARD", "Net banking": "OTHER", "Cash deposit": "CASH_DEPOSIT", "Crypto or wallet": "WALLET", Other: "OTHER" };
const IFSC = /\b([A-Za-z]{4}0[A-Za-z0-9]{6})\b/;
const looksLikePhone = (x: string) => /^\+?[\dXx*][\dXx*\s-]{7,}$/.test(x);

function parseManual(raw: ManualFirInput): ManualFir {
  const parsed = manualFirSchema.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors = Object.fromEntries(parsed.error.issues.map((i) => [i.path.join("."), i.message]));
    throw new AppError(parsed.error.issues.length > 1 ? `${parsed.error.issues.length} fields need attention.` : parsed.error.issues[0]!.message, "VALIDATION", fieldErrors);
  }
  return parsed.data;
}

/**
 * The FIR's vertical for the copy and the case: the officer's choice when they set one; otherwise as the FIR states it,
 * or else decided by the local model from the facts (the rules when it is not running).
 */
async function verticalFor(v: ManualFir): Promise<{ line: string; decision: MoDecision }> {
  const set = verticalByKey(v.moVertical);
  if (set) {
    const subtype = set.kinds.some((k) => k.label === v.moSubtype) ? v.moSubtype! : null;
    return { line: `${set.label}${subtype ? ` · ${subtype}` : ""}, set by the officer`, decision: { key: set.key, subtype, basis: "FIR", reason: "Set by the officer who entered the FIR.", model: null } };
  }
  const d = await decideMo({ firText: v.narrative, facts: v.narrative, sections: v.sections ?? null });
  const r = verticalOfDecision(d);
  return { line: `${r.label}. ${r.why}`, decision: d };
}

/** A printable copy of an FIR being typed in, for the officer to check or print before (or after) opening the case. */
export async function manualFirCopy(user: SessionUser, raw: ManualFirInput): Promise<{ fileName: string; buffer: Buffer }> {
  assertCaseWorker(user);
  const v = parseManual(raw);
  const cfg = getAppConfig();
  const buffer = preparedFirPdf(v, { stationName: cfg.station.name, district: cfg.station.district, preparedBy: `${shortRank(user.rank)} ${user.displayName}`, preparedAt: now(), investigatingOfficer: `${shortRank(user.rank)} ${user.displayName}`, vertical: (await verticalFor(v)).line });
  return { fileName: `FIR_${v.firNumber}_${v.firYear}_prepared.pdf`, buffer };
}

/** Opening a case typed in by hand (no copy, or a copy the reader cannot use). */
export async function openCaseManually(db: Db, user: SessionUser, raw: ManualFirInput) {
  assertCaseWorker(user);
  const v = parseManual(raw);
  const payments = v.payments.filter((p) => p.amount);
  const payerOf = (p: (typeof payments)[number]) => Math.min(Math.max(Number(p.payer ?? 0) || 0, 0), v.victims.length - 1);
  // Each victim's loss is what the payments show they paid.
  const lossOf = (i: number) => payments.filter((p) => payerOf(p) === i).reduce((s, p) => { const m = parseRupeesToMinor(p.amount); return m.ok ? s + m.value : s; }, 0n);
  const toValue = (p: (typeof payments)[number]) => (/@/.test(p.to!) ? p.to!.trim() : p.to!.replace(IFSC, "").split(/[\s,]+/).filter(Boolean)[0] ?? p.to!.trim());
  const statedRole = (i: number, a: ManualFir["accused"][number], what: string) => `Accused ${i + 1} in the FIR: ${what}${a.name ? `; stated to be “${a.name}” (per the FIR, not verified)` : ""}`;
  type Idf = { kind: "PHONE" | "EMAIL" | "UPI_ID" | "BANK_ACCOUNT" | "PLATFORM_PROFILE" | "WEBSITE"; value: string; role: string; bank?: string; statedName?: string };
  const identifiers: Idf[] = [
    ...v.victims.flatMap((x, i): Idf[] => [
      ...(x.mobile ? [{ kind: "PHONE" as const, value: x.mobile, role: i === 0 ? "Complainant's own number" : `Victim's own number (${x.name})` }] : []),
      ...(x.email ? [{ kind: "EMAIL" as const, value: x.email, role: i === 0 ? "Complainant's own email" : `Victim's own email (${x.name})` }] : []),
    ]),
    ...v.accused.flatMap((a, i): Idf[] => [
      ...listOf(a.phones).map((value) => ({ kind: "PHONE" as const, value, role: statedRole(i, a, "phone number"), statedName: a.name })),
      ...listOf(a.emails).map((value) => ({ kind: "EMAIL" as const, value, role: statedRole(i, a, "email address"), statedName: a.name })),
      ...listOf(a.accounts).map((value): Idf => {
        const ifsc = IFSC.exec(value)?.[1];
        return /@/.test(value) ? { kind: "UPI_ID", value, role: statedRole(i, a, "UPI ID"), statedName: a.name } : { kind: "BANK_ACCOUNT", value: value.replace(IFSC, "").replace(/\b(?:IFSC|A\/?c(?:count)?\s*(?:no\.?)?)[:\s]*/gi, "").split(/[\s,]+/).filter(Boolean)[0] ?? value, role: statedRole(i, a, `bank account${ifsc ? ` (IFSC ${ifsc.toUpperCase()})` : ""}`), statedName: a.name };
      }),
      ...listOf(a.profiles).map((value): Idf => (/^https?:\/\//i.test(value) ? { kind: "WEBSITE", value, role: statedRole(i, a, "page or website") } : looksLikePhone(value) ? { kind: "PHONE", value, role: statedRole(i, a, "phone number"), statedName: a.name } : { kind: "PLATFORM_PROFILE", value, role: statedRole(i, a, "profile"), statedName: a.name })),
    ]),
    ...listOf(v.suspectPhones).map((value) => ({ kind: "PHONE" as const, value, role: "Number used to contact the complainant (per complaint)" })),
    ...listOf(v.suspectProfiles).map((value): Idf => (looksLikePhone(value) ? { kind: "PHONE", value, role: "Number used to contact the complainant (per complaint)" } : /^https?:\/\//.test(value) ? { kind: "WEBSITE", value, role: "Page named in the complaint" } : { kind: "PLATFORM_PROFILE", value, role: "Profile that contacted the complainant (per complaint)" })),
    ...listOf(v.suspectOther).map((value): Idf => (/@[^.]+\.[a-z]/i.test(value) ? { kind: "EMAIL", value, role: "Email used by the alleged fraudster (per complaint)" } : { kind: "UPI_ID", value, role: "Account named in the complaint" })),
    ...payments.filter((p) => p.to).map((p): Idf => {
      const ifsc = (p.toIfsc ?? IFSC.exec(p.to!)?.[1])?.toUpperCase();
      return /@/.test(p.to!) ? { kind: "UPI_ID", value: toValue(p), role: "Reported beneficiary UPI ID" } : { kind: "BANK_ACCOUNT", value: toValue(p), role: `Reported beneficiary account${ifsc ? ` (IFSC ${ifsc})` : ""}`, bank: p.toBank };
    }),
  ];
  const unique = identifiers.filter((x, i, all) => all.findIndex((y) => y.kind === x.kind && y.value === x.value) === i);
  const registered = `${v.registeredOn}T${v.registeredTime}`;
  const kase = await createCase(db, user, {
    referenceType: "FIR",
    firNumber: v.firNumber,
    firYear: v.firYear,
    complaintRef: v.ack || undefined,
    investigatingOfficerId: user.id,
    title: "Online financial fraud",
    fraudCategory: undefined,
    incidentStart: v.occurredFrom,
    incidentEnd: v.occurredTo,
    reportedAt: registered,
    legalSections: v.sections || undefined,
    narrative: v.narrative,
    parties: v.victims.map((x, i) => ({ name: x.name, role: "VICTIM" as const, lossRupees: lossOf(i) > 0n ? (Number(lossOf(i)) / 100).toFixed(2) : undefined })),
    identifiers: unique.map(({ statedName: _s, ...x }) => x),
  });
  const { detectKind } = await import("@/domain/extraction/fir-brief");
  const kind = detectKind(`${v.narrative} ${v.sections ?? ""}`);
  const vertical = await verticalFor(v);
  await db.case.update({ where: { id: kase.id }, data: { registeredAt: istInputToUtc(registered), title: kind.label, fraudCategory: kind.label } });
  if (verticalByKey(v.moVertical)) await db.case.update({ where: { id: kase.id }, data: { moVertical: vertical.decision.key, moSubtype: vertical.decision.subtype, moBasis: "OFFICER", moReason: null } });
  else await storeMo(db, user, kase.id, vertical.decision);
  // The name the FIR gives an accused is kept beside each of their identifiers as stated, to be checked against KYC.
  for (const x of unique.filter((i) => i.statedName)) {
    const e = await db.entity.findFirst({ where: { caseId: kase.id, kind: x.kind, value: x.value } });
    if (e) await db.entity.update({ where: { id: e.id }, data: { attributesJson: JSON.stringify({ ...JSON.parse(e.attributesJson || "{}"), statedName: x.statedName, statedNameBasis: "As stated in the FIR (entered by hand); not verified" }) } });
  }
  // Each payment needs the account it was paid from: the one entered, or "not stated" until a bank record names it.
  const people = await db.entity.findMany({ where: { caseId: kase.id, kind: "PERSON" }, orderBy: { createdAt: "asc" } });
  const claims = await db.victimClaim.findMany({ where: { caseId: kase.id } });
  for (const p of payments) {
    const victim = people[payerOf(p)] ?? people[0];
    if (!victim) break;
    const toEntity = p.to ? await db.entity.findFirst({ where: { caseId: kase.id, value: toValue(p) } }) : null;
    if (!toEntity) continue;
    const own = p.fromAccount?.replace(/[^\dXx*]/g, "");
    const payer = own
      ? await db.entity.upsert({
          where: { caseId_kind_normalizedValue: { caseId: kase.id, kind: "BANK_ACCOUNT", normalizedValue: normalizeIdentifier("BANK_ACCOUNT", own) } },
          create: { caseId: kase.id, kind: "BANK_ACCOUNT", label: own, value: own, normalizedValue: normalizeIdentifier("BANK_ACCOUNT", own), caseRole: `${victim.label}'s own account`, attributesJson: JSON.stringify({ isVictimAccount: true, ...(p.fromBank ? { bank: p.fromBank } : {}) }), belongsTo: "VICTIM", isMasked: isMaskedValue(own), discoveredAt: now() },
          update: {},
        })
      : await db.entity.upsert({
          where: { caseId_kind_normalizedValue: { caseId: kase.id, kind: "BANK_ACCOUNT", normalizedValue: `NOTSTATED:${victim.id}` } },
          create: { caseId: kase.id, kind: "BANK_ACCOUNT", label: `${victim.label}'s account (not stated)`, value: `NOT STATED ${victim.label}`, normalizedValue: `NOTSTATED:${victim.id}`, caseRole: "Complainant's own account; the number is not in the complaint", attributesJson: JSON.stringify({ isVictimAccount: true, numberNotStated: true, ...(p.fromBank ? { bank: p.fromBank } : {}) }), belongsTo: "VICTIM", discoveredAt: now() },
          update: {},
        });
    const when = p.paidOn ? `${p.paidOn}T${p.paidTime ?? "00:00"}` : registered;
    await addManualTransaction(db, user, kase.id, {
      fromEntityId: payer.id,
      toEntityId: toEntity.id,
      amountRupees: p.amount,
      occurredAt: when,
      channel: MODE[p.mode] ?? "OTHER",
      reference: p.reference || null,
      kind: "VICTIM_PAYMENT",
      claimId: claims.find((c) => c.victimEntityId === victim.id)?.id ?? null,
      sourceNote: `Entered by hand in the New FIR window${p.paidOn ? (p.paidTime ? "" : "; time of payment not entered") : "; date of payment not entered, the FIR's registration time is used"}`,
    });
  }
  // A printable copy of what was entered is kept with the case. It is not the CCTNS copy: it is marked as prepared,
  // and requests never describe it as the signed FIR.
  const copy = await manualFirCopy(user, raw);
  await uploadEvidence(db, user, kase.id, { fileName: copy.fileName, buffer: copy.buffer, title: `FIR ${v.firNumber}/${v.firYear} (prepared from details entered by hand)`, category: "FIR_COPY", sourceDescription: "Prepared in T-CYBER from the details entered by hand in the New FIR window; not the CCTNS copy", receivedAt: now(), derivation: "PREPARED" }, { runExtraction: false });
  return { caseId: kase.id };
}
