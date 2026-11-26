import crypto from "node:crypto";
import path from "node:path";
import { formatInr } from "@/domain/money";
import { readTrailRows, type TrailReading, type TrailRow } from "@/domain/ncrp-trail";
import { isMaskedValue, normalizeIdentifier, shownId } from "@/domain/identifiers";
import { parseCsv } from "@/domain/extraction";
import { bankFromIfsc } from "@/domain/providers";
import { now } from "../clock";
import type { Db, Tx } from "../db";
import type { SessionUser } from "../auth/session";
import { loadCaseForUser } from "../auth/access";
import { recordAudit } from "../audit";
import { AppError } from "../errors";
import { readXlsx } from "../documents/xlsx";
import { MAX_UPLOAD_BYTES } from "../storage";
import { insertEvidenceTx, prepareEvidence } from "./evidence";
import { refreshRecommendationsTx } from "./tasks";

/**
 * The NCRP money-trail export (Excel or CSV) uploaded with a new FIR: read and shown first, then, when the case opens,
 * kept as evidence and its accounts, onward transfers, ATM withdrawals and holds added to the case, each traced to its
 * sheet line. Records from the export are marked "Reported on NCRP" (what the banks entered on the portal); a bank's
 * own reply later confirms them. Nothing is sent anywhere.
 */

export const TRAIL_EXTENSIONS = [".xlsx", ".csv"] as const;

export function readTrailFile(fileName: string, buffer: Buffer): TrailReading & { sheet: string | null } {
  const ext = path.extname(fileName).toLowerCase();
  if (buffer.length > MAX_UPLOAD_BYTES) throw new AppError("The file is larger than 25 MB.", "VALIDATION", { file: "Choose a file under 25 MB." });
  if (ext === ".xls") throw new AppError("This is an old-style Excel file (.xls). Open it in Excel and save it as .xlsx, then upload that.", "VALIDATION", { file: "Save it as .xlsx first." });
  if (!(TRAIL_EXTENSIONS as readonly string[]).includes(ext)) throw new AppError("Upload the NCRP export as an Excel (.xlsx) or CSV file.", "VALIDATION", { file: "Choose an .xlsx or .csv file." });
  const tables: { name: string | null; rows: string[][] }[] = [];
  if (ext === ".csv") tables.push({ name: null, rows: parseCsv(buffer.toString("utf8").replace(/^﻿/, "")) });
  else {
    if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) throw new AppError("This file is not a readable Excel workbook. Save it again as .xlsx and upload that.", "VALIDATION", { file: "Not a readable .xlsx file." });
    try {
      tables.push(...readXlsx(buffer));
    } catch {
      throw new AppError("The workbook could not be read. Save it again as .xlsx and upload that.", "VALIDATION", { file: "Not a readable .xlsx file." });
    }
  }
  let best: (TrailReading & { sheet: string | null }) | null = null;
  let lastError = "";
  for (const t of tables) {
    try {
      const r = readTrailRows(t.rows);
      if (!best || r.rows.length > best.rows.length) best = { ...r, sheet: t.name };
    } catch (err) {
      lastError = (err as Error).message;
    }
  }
  if (!best) throw new AppError(lastError || "No sheet in the file looks like an NCRP money-trail export.", "VALIDATION", { file: lastError || "Not an NCRP money-trail export." });
  if (!best.rows.length) throw new AppError("The sheet has the NCRP headings but no rows with an account number.", "VALIDATION", { file: "No rows to add." });
  return best;
}

const LABEL: Record<string, string> = {
  ack: "Acknowledgement no.",
  victimUtr: "Complainant's UTR",
  layer: "Layer",
  fromAccount: "Account (at this layer)",
  fromBank: "Its bank",
  action: "Action by the bank",
  toAccount: "Moved to account",
  toIfsc: "Its IFSC",
  toBank: "Its bank",
  occurredAt: "Date and time",
  utr: "UTR of the movement",
  amount: "Amount",
  holdAmount: "Put on hold",
  disputed: "Disputed amount",
  terminal: "ATM / terminal ID",
  place: "Branch / ATM place",
  remarks: "Remarks",
  actionDate: "Date of action",
};

const sum = (xs: (bigint | null)[]) => xs.reduce<bigint>((s, x) => s + (x ?? 0n), 0n);

/** What the officer sees before opening the case: plain counts, the layers, and one line per row. */
export function describeTrail(r: ReturnType<typeof readTrailFile>) {
  const transfers = r.rows.filter((x) => x.action === "TRANSFER");
  const holds = r.rows.filter((x) => x.action === "HOLD" || (x.holdMinor ?? 0n) > 0n);
  const cash = r.rows.filter((x) => x.action === "ATM" || x.action === "CASH");
  const accounts = new Set(r.rows.flatMap((x) => [x.from.account, ...(x.to ? [x.to.account] : [])]));
  const layers = [...new Set(r.rows.map((x) => x.layer).filter((l): l is number => l !== null))].sort((a, b) => a - b);
  const line = (x: TrailRow) => {
    const who = `${shownId(x.from.account)}${x.from.bank ? ` (${x.from.bank})` : ""}`;
    const amt = x.amountMinor !== null ? formatInr(x.amountMinor) : "amount not given";
    switch (x.action) {
      case "TRANSFER":
        return x.to ? `${who} sent ${amt} to ${shownId(x.to.account)}${x.to.bank || x.to.ifsc ? ` (${x.to.bank ?? bankFromIfsc(x.to.ifsc ?? "") ?? x.to.ifsc})` : ""}` : `${who}: "${x.actionText}", but the account it went to is not given`;
      case "HOLD":
        return `${who}: ${x.holdMinor ? formatInr(x.holdMinor) : "an amount not given"} put on hold`;
      case "ATM":
        return `${who}: ${amt} taken out at an ATM${x.place ? `, ${x.place}` : ""}${x.terminal ? ` (ATM ${x.terminal})` : ""}`;
      case "CASH":
        return `${who}: ${amt} withdrawn (${x.actionText})`;
      default:
        return `${who}: "${x.actionText || "no action given"}" (noted, nothing to trace)`;
    }
  };
  return {
    sheet: r.sheet,
    headerRow: r.headerRow,
    columns: r.columns.map((c) => ({ header: c.header, meaning: LABEL[c.role] ?? c.role })),
    acks: r.acks,
    rowCount: r.rows.length,
    layers,
    accounts: accounts.size,
    transfers: { count: transfers.length, total: formatInr(sum(transfers.map((x) => x.amountMinor))) },
    holds: { count: holds.length, total: formatInr(sum(holds.map((x) => x.holdMinor))) },
    cash: { count: cash.length, total: formatInr(sum(cash.map((x) => x.amountMinor))) },
    rows: r.rows.slice(0, 60).map((x) => ({ line: x.line, layer: x.layer, text: line(x), when: x.occurredAt })),
    skipped: r.skipped.slice(0, 30),
  };
}
export type TrailPreview = ReturnType<typeof describeTrail>;

const channelOf = (t: string) => (/imps/i.test(t) ? "IMPS" : /neft/i.test(t) ? "NEFT" : /rtgs/i.test(t) ? "RTGS" : /upi/i.test(t) ? "UPI" : "OTHER");
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 32);

async function accountEntity(tx: Tx, caseId: string, a: { account: string; bank: string | null; ifsc: string | null }, layer: number | null, at: Date) {
  const kind = /@/.test(a.account) ? "UPI_ID" : "BANK_ACCOUNT";
  const normalizedValue = normalizeIdentifier(kind, a.account);
  const bank = a.bank ?? (a.ifsc ? bankFromIfsc(a.ifsc) : null);
  const existing = await tx.entity.findUnique({ where: { caseId_kind_normalizedValue: { caseId, kind, normalizedValue } } });
  if (existing) {
    const attrs = JSON.parse(existing.attributesJson || "{}") as Record<string, unknown>;
    if ((!attrs.bank && bank) || (!attrs.ifsc && a.ifsc)) {
      await tx.entity.update({ where: { id: existing.id }, data: { attributesJson: JSON.stringify({ ...attrs, ...(attrs.bank || !bank ? {} : { bank }), ...(attrs.ifsc || !a.ifsc ? {} : { ifsc: a.ifsc }) }) } });
    }
    return { entity: existing, created: false };
  }
  const entity = await tx.entity.create({
    data: {
      caseId,
      kind,
      label: a.account,
      value: a.account,
      normalizedValue,
      attributesJson: JSON.stringify({ ...(bank ? { bank } : {}), ...(a.ifsc ? { ifsc: a.ifsc } : {}), ...(layer ? { ncrpLayer: layer } : {}) }),
      caseRole: layer ? `Layer ${layer} account (NCRP money trail)` : "Account in the NCRP money trail",
      isMasked: isMaskedValue(a.account),
      discoveredAt: at,
    },
  });
  return { entity, created: true };
}

/** The complainant's account that layer-1 money came from: the one the FIR gives, else a "not stated" placeholder. */
async function victimSource(tx: Tx, caseId: string, at: Date) {
  const own = await tx.entity.findFirst({ where: { caseId, belongsTo: "VICTIM", kind: { in: ["BANK_ACCOUNT", "UPI_ID"] } }, orderBy: { createdAt: "asc" } });
  if (own) return own;
  const victim = await tx.entity.findFirst({ where: { caseId, kind: "PERSON", partyRoles: { some: { role: { in: ["VICTIM", "COMPLAINANT"] } } } }, orderBy: { createdAt: "asc" } });
  const key = `NOTSTATED:${victim?.id ?? "ncrp"}`;
  return tx.entity.upsert({
    where: { caseId_kind_normalizedValue: { caseId, kind: "BANK_ACCOUNT", normalizedValue: key } },
    create: { caseId, kind: "BANK_ACCOUNT", label: `${victim?.label ?? "Complainant"}'s account (not stated)`, value: `NOT STATED ${victim?.label ?? "complainant"}`, normalizedValue: key, caseRole: "Complainant's own account; the number is not in the NCRP export", attributesJson: JSON.stringify({ isVictimAccount: true, numberNotStated: true }), belongsTo: "VICTIM", discoveredAt: at },
    update: {},
  });
}

export interface TrailImportResult {
  evidenceId: string;
  accountsAdded: number;
  transfers: number;
  victimPayments: number;
  cashWithdrawals: number;
  holds: number;
  notes: string[];
}

/**
 * Keeps the export as evidence and adds what it shows to the case. Running it again with the same export adds
 * nothing new (each record has a key from its UTR or its row's contents).
 */
export async function importNcrpTrail(db: Db, user: SessionUser, caseId: string, file: { fileName: string; buffer: Buffer }, opts: { evidenceId?: string } = {}): Promise<TrailImportResult> {
  await loadCaseForUser(db, user, caseId, "write");
  const reading = readTrailFile(file.fileName, file.buffer);
  const at = now();
  // A file already kept with the case (added through "Add files") is not stored a second time.
  const prepared = opts.evidenceId ? null : await prepareEvidence({ fileName: file.fileName, buffer: file.buffer, title: `NCRP money trail${reading.acks.length ? ` (ack ${reading.acks.join(", ")})` : ""}`, category: "TRANSACTION_RECORD", sourceDescription: "NCRP money-trail export (action taken by banks), uploaded with the FIR", receivedAt: at });
  return db.$transaction(
    async (tx) => {
      const kase = await loadCaseForUser(tx, user, caseId, "write");
      const ev = prepared ? await insertEvidenceTx(tx, user.id, caseId, prepared) : await tx.evidenceItem.findFirstOrThrow({ where: { id: opts.evidenceId!, caseId } });
      const out: TrailImportResult = { evidenceId: ev.id, accountsAdded: 0, transfers: 0, victimPayments: 0, cashWithdrawals: 0, holds: 0, notes: [] };
      const source = async (subjectType: string, subjectId: string, r: TrailRow, note: string | null = null) => {
        const locator = `${reading.sheet ? `Sheet "${reading.sheet}", ` : ""}row ${r.line}`;
        await tx.sourceAssertion.upsert({
          where: { caseId_dedupeKey: { caseId, dedupeKey: `${subjectType}:${subjectId}:${ev.id}:${locator}:SUPPORTS` } },
          create: { caseId, evidenceId: ev.id, row: r.line, locator, excerpt: `${r.from.account} · ${r.actionText}${r.amountMinor !== null ? ` · ${formatInr(r.amountMinor)}` : ""}`.slice(0, 300), subjectType, subjectId, stance: "SUPPORTS", note, dedupeKey: `${subjectType}:${subjectId}:${ev.id}:${locator}:SUPPORTS`, createdById: user.id },
          update: {},
        });
      };
      const claims = await tx.victimClaim.findMany({ where: { caseId } });
      const claimId = claims.length === 1 ? claims[0]!.id : null;
      const holdsByAccount = new Map<string, { entityId: string; minor: bigint; rows: TrailRow[] }>();
      for (const r of reading.rows) {
        const from = await accountEntity(tx, caseId, r.from, r.layer, at);
        if (from.created) out.accountsAdded++;
        await source("ENTITY", from.entity.id, r);
        // How the money reached a layer-1 account: the complainant's payment, unless the FIR already records it.
        if (r.layer === 1 && (r.disputedMinor || r.victimUtr)) {
          const known = await tx.transaction.findFirst({ where: { caseId, toEntityId: from.entity.id, kind: "VICTIM_PAYMENT" } });
          const sameRef = r.victimUtr ? await tx.transaction.findFirst({ where: { caseId, reference: r.victimUtr } }) : null;
          if (!known && !sameRef && r.disputedMinor && r.occurredAt) {
            const victim = await victimSource(tx, caseId, at);
            const dedupeKey = `NCRP:V:${r.victimUtr ?? sha(`${from.entity.id}|${r.disputedMinor}`)}`;
            const exists = await tx.transaction.findUnique({ where: { caseId_dedupeKey: { caseId, dedupeKey } } });
            const t = exists ?? (await tx.transaction.create({ data: { caseId, fromEntityId: victim.id, toEntityId: from.entity.id, amountMinor: r.disputedMinor, occurredAt: new Date(r.occurredAt), channel: "OTHER", reference: r.victimUtr, kind: "VICTIM_PAYMENT", layer: 1, claimId, status: "REPORTED_ON_NCRP", discoveredAt: at, dedupeKey } }));
            if (!exists) out.victimPayments++;
            await source("TRANSACTION", t.id, r, "The export gives the disputed amount and UTR, not the payment's own time: the time shown is the bank's entry on this row, so the payment was at or before it. Confirm it from the complainant's statement.");
          }
        }
        const layer = (r.layer ?? 1) + 1;
        if (r.action === "TRANSFER") {
          if (!r.to) {
            out.notes.push(`Row ${r.line}: "${r.actionText}" without the account it went to; the account is added, the transfer is not.`);
            continue;
          }
          const to = await accountEntity(tx, caseId, r.to, layer, at);
          if (to.created) out.accountsAdded++;
          await source("ENTITY", to.entity.id, r);
          if (r.amountMinor === null || !r.occurredAt) {
            out.notes.push(`Row ${r.line}: the transfer to ${shownId(r.to.account)} has no ${r.amountMinor === null ? "amount" : "date"}; both accounts are added, the transfer is not.`);
            continue;
          }
          const dedupeKey = r.utr ? `REF:${r.utr.toUpperCase()}` : `NCRP:T:${sha(`${from.entity.id}|${to.entity.id}|${r.amountMinor}|${r.occurredAt}`)}`;
          const exists = await tx.transaction.findUnique({ where: { caseId_dedupeKey: { caseId, dedupeKey } } });
          const t = exists ?? (await tx.transaction.create({ data: { caseId, fromEntityId: from.entity.id, toEntityId: to.entity.id, amountMinor: r.amountMinor, occurredAt: new Date(r.occurredAt), channel: channelOf(r.actionText), reference: r.utr, kind: "ONWARD_TRANSFER", layer, status: "REPORTED_ON_NCRP", discoveredAt: at, dedupeKey } }));
          if (!exists) out.transfers++;
          await source("TRANSACTION", t.id, r);
        } else if (r.action === "ATM" || r.action === "CASH") {
          if (r.amountMinor === null || !r.occurredAt) {
            out.notes.push(`Row ${r.line}: a withdrawal from ${shownId(r.from.account)} without its ${r.amountMinor === null ? "amount" : "date"}; not added.`);
            continue;
          }
          const occurredAt = new Date(r.occurredAt);
          const cashValue = `Cash withdrawn from ${r.from.account} on ${r.occurredAt}`;
          const cash = await tx.entity.upsert({
            where: { caseId_kind_normalizedValue: { caseId, kind: "CASH", normalizedValue: normalizeIdentifier("CASH", cashValue) } },
            create: { caseId, kind: "CASH", label: r.action === "ATM" ? `Cash, ATM${r.place ? ` ${r.place}` : ""}` : "Cash withdrawal", value: cashValue, normalizedValue: normalizeIdentifier("CASH", cashValue), caseRole: "Cash taken out of the account; to be traced", discoveredAt: at },
            update: {},
          });
          const dedupeKey = `CASH:${sha(`${from.entity.id}|${r.amountMinor}|${r.occurredAt}`)}`;
          const exists = await tx.transaction.findUnique({ where: { caseId_dedupeKey: { caseId, dedupeKey } } });
          const t = exists ?? (await tx.transaction.create({ data: { caseId, fromEntityId: from.entity.id, toEntityId: cash.id, amountMinor: r.amountMinor, occurredAt, channel: "CASH_WITHDRAWAL", reference: r.terminal ?? r.utr, kind: "CASH_WITHDRAWAL", layer, status: "REPORTED_ON_NCRP", discoveredAt: at, dedupeKey } }));
          if (!exists) out.cashWithdrawals++;
          await source("TRANSACTION", t.id, r);
          if (r.action === "ATM") {
            const loc = await tx.locationObservation.upsert({
              where: { caseId_dedupeKey: { caseId, dedupeKey: `ATM_WITHDRAWAL:${from.entity.id}:${occurredAt.toISOString()}` } },
              create: { caseId, entityId: from.entity.id, observationType: "ATM_WITHDRAWAL", description: `${formatInr(r.amountMinor)} cash withdrawn from ${from.entity.label}`, locationText: r.place ? `ATM, ${r.place}` : "ATM, place not given", precision: "ATM_SITE", eventAt: occurredAt, eventAtNote: "Time of the withdrawal as entered on NCRP", receivedAt: at, limitations: `ATM site only: a historical sighting, not a current location.${r.terminal ? "" : " ATM ID not given, so footage cannot be requested yet."}`, dedupeKey: `ATM_WITHDRAWAL:${from.entity.id}:${occurredAt.toISOString()}` },
              update: {},
            });
            await source("LOCATION", loc.id, r);
          }
        }
        if ((r.holdMinor ?? 0n) > 0n) {
          const h = holdsByAccount.get(from.entity.id) ?? { entityId: from.entity.id, minor: 0n, rows: [] };
          h.minor += r.holdMinor!;
          h.rows.push(r);
          holdsByAccount.set(from.entity.id, h);
        } else if (r.action === "HOLD") out.notes.push(`Row ${r.line}: a hold on ${shownId(r.from.account)} without the amount held; check it with the bank.`);
      }
      for (const h of holdsByAccount.values()) {
        const existing = await tx.hold.findFirst({ where: { caseId, accountEntityId: h.entityId } });
        if (existing) {
          out.notes.push(`A hold on ${shownId(h.rows[0]!.from.account)} is already recorded in the case; the NCRP amount (${formatInr(h.minor)}) was not added again.`);
          continue;
        }
        const asOf = h.rows.map((r) => r.occurredAt).filter(Boolean).sort().at(-1);
        const hold = await tx.hold.create({
          data: { caseId, accountEntityId: h.entityId, holdKey: `NCRP:${h.entityId}`, bankReference: h.rows[0]!.ack ? `NCRP ack ${h.rows[0]!.ack}` : null, status: "CONFIRMED_HELD", confirmedAmountMinor: h.minor, confirmedAsOf: asOf ? new Date(asOf) : at, note: "Put on hold as entered by the bank on NCRP (money-trail export). Confirm the amount with the bank's own reply." },
        });
        out.holds++;
        for (const r of h.rows) await source("HOLD", hold.id, r);
      }
      for (const s of reading.skipped) out.notes.push(`Row ${s.line}: ${s.reason}`);
      await recordAudit(tx, {
        caseId,
        actorId: user.id,
        action: "ncrp_trail.imported",
        objectType: "EvidenceItem",
        objectId: ev.id,
        summary: `NCRP money trail added to ${kase.firNumber ? `FIR ${kase.firNumber}/${kase.firYear}` : "the case"}: ${out.accountsAdded} accounts, ${out.transfers} onward transfers, ${out.cashWithdrawals} withdrawals, ${out.holds} holds${reading.skipped.length ? `; ${reading.skipped.length} rows could not be used` : ""}`,
        detail: { sha256: ev.sha256, rows: reading.rows.length, skipped: reading.skipped.length },
      });
      await refreshRecommendationsTx(tx, caseId, user.id);
      return out;
    },
    { timeout: 60_000 },
  );
}
