import crypto from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { createCaseSchema, zodFieldErrors, type CreateCaseInput } from "@/contracts/case";
import { normalizeIdentifier, isMaskedValue } from "@/domain/identifiers";
import { parseRupeesToMinor } from "@/domain/money";
import { formatDateIST, istInputToUtc } from "@/domain/time";
import { verticalByKey } from "@/domain/mo-verticals";
import type { Db, Tx } from "../db";
import type { SessionUser } from "../auth/session";
import { assertCaseWorker, caseAccessWhere, loadCaseForUser } from "../auth/access";
import { recordAudit } from "../audit";
import { now } from "../clock";
import { AppError, conflictError } from "../errors";
import { shortRank } from "@/lib/cn";
import { refreshRecommendationsTx } from "./tasks";

export function caseReference(c: { referenceType: string; firNumber: number | null; firYear: number; complaintRef: string | null }): string {
  return c.referenceType === "FIR" && c.firNumber ? `FIR ${c.firNumber}/${c.firYear}` : `Complaint ${c.complaintRef ?? "(no reference)"}`;
}

export async function createCaseTx(tx: Tx, user: SessionUser, raw: CreateCaseInput) {
  assertCaseWorker(user);
  const parsed = createCaseSchema.safeParse(raw);
  if (!parsed.success) throw new AppError("Some fields need attention.", "VALIDATION", zodFieldErrors(parsed.error));
  const v = parsed.data;
  const firYear = Number(v.firYear);
  const firNumber = v.referenceType === "FIR" ? Number(v.firNumber) : null;

  const io = await tx.user.findUnique({ where: { id: v.investigatingOfficerId } });
  if (!io || io.stationId !== user.stationId || !io.active) {
    throw new AppError("Choose an investigating officer from your station.", "VALIDATION", { investigatingOfficerId: "Choose an officer from your station." });
  }

  // Duplicate references are blocked within the same station and year.
  const duplicate =
    v.referenceType === "FIR"
      ? await tx.case.findFirst({ where: { stationId: user.stationId, firYear, firNumber } })
      : await tx.case.findFirst({ where: { stationId: user.stationId, complaintRef: v.complaintRef } });
  if (duplicate) {
    const ref = caseReference(duplicate);
    throw new AppError(
      `${ref} already exists at ${user.stationName} (opened ${formatDateIST(duplicate.createdAt)}). Open the existing case instead of creating a duplicate.`,
      "CONFLICT",
      v.referenceType === "FIR" ? { firNumber: `${ref} already exists at this station.` } : { complaintRef: `${ref} already exists at this station.` },
    );
  }
  // An FIR may also carry its NCRP / complaint reference, which is unique per station too.
  if (v.referenceType === "FIR" && v.complaintRef) {
    const sameComplaint = await tx.case.findFirst({ where: { stationId: user.stationId, complaintRef: v.complaintRef } });
    if (sameComplaint) {
      const ref = caseReference(sameComplaint);
      throw new AppError(
        `Complaint reference ${v.complaintRef} is already recorded on ${ref}. Open that case, or correct the reference if this FIR is about a different complaint.`,
        "CONFLICT",
        { complaintRef: `Already recorded on ${ref}.` },
      );
    }
  }

  const at = now();
  const kase = await tx.case.create({
    data: {
      stationId: user.stationId,
      referenceType: v.referenceType,
      firNumber,
      firYear,
      complaintRef: v.complaintRef ?? null,
      title: v.title,
      fraudCategory: v.fraudCategory ?? null,
      narrative: v.narrative,
      legalSections: v.legalSections ?? null,
      legalSectionsSource: v.legalSections ? `Entered by ${user.displayName}` : null,
      incidentStart: v.incidentStart ? istInputToUtc(v.incidentStart) : null,
      incidentEnd: v.incidentEnd ? istInputToUtc(v.incidentEnd) : null,
      reportedAt: v.reportedAt ? istInputToUtc(v.reportedAt) : null,
      registeredAt: v.referenceType === "FIR" ? at : null,
      createdById: user.id,
      createdAt: at,
      assignments: {
        create: [
          { userId: io.id, role: "INVESTIGATING_OFFICER", assignedAt: at },
          ...(io.id !== user.id && user.role === "OFFICER" ? [{ userId: user.id, role: "ASSISTING_OFFICER", assignedAt: at }] : []),
        ],
      },
    },
  });

  for (const p of v.parties) {
    const person = await tx.entity.create({
      data: {
        caseId: kase.id,
        kind: "PERSON",
        label: p.name,
        value: p.name,
        normalizedValue: `person:${crypto.randomUUID()}`,
        caseRole: p.role === "VICTIM" ? "Victim (as stated at intake)" : null,
        discoveredAt: at,
        discoveryPhase: 0,
      },
    });
    await tx.partyRole.create({ data: { caseId: kase.id, entityId: person.id, role: p.role, basis: `Recorded at intake by ${user.displayName}`, createdAt: at } });
    if (p.role === "VICTIM" && p.lossRupees) {
      const loss = parseRupeesToMinor(p.lossRupees);
      if (loss.ok) {
        await tx.victimClaim.create({ data: { caseId: kase.id, victimEntityId: person.id, lossAmountMinor: loss.value, basis: "Loss stated at intake", createdAt: at } });
      }
    }
  }

  for (const idf of v.identifiers) {
    const normalizedValue = normalizeIdentifier(idf.kind, idf.value);
    await tx.entity.upsert({
      where: { caseId_kind_normalizedValue: { caseId: kase.id, kind: idf.kind, normalizedValue } },
      create: {
        caseId: kase.id,
        kind: idf.kind,
        label: idf.label ?? idf.value,
        value: idf.value,
        normalizedValue,
        attributesJson: JSON.stringify(idf.bank ? { bank: idf.bank } : {}),
        caseRole: idf.role ?? null,
        isMasked: isMaskedValue(idf.value),
        discoveredAt: at,
        discoveryPhase: 0,
      },
      update: {},
    });
  }

  await recordAudit(tx, {
    caseId: kase.id,
    actorId: user.id,
    action: "case.created",
    objectType: "Case",
    objectId: kase.id,
    summary: `${caseReference(kase)} workspace opened${v.referenceType === "COMPLAINT" ? " (FIR document not yet available)" : ""}`,
    detail: { parties: v.parties.length, identifiers: v.identifiers.length },
  });
  // An NCRP / 1930 complaint waiting for this FIR is now registered against it.
  if (v.complaintRef) {
    const complaint = await tx.complaint.findUnique({ where: { ackNumber: v.complaintRef } });
    if (complaint && complaint.status === "AWAITING_FIR") {
      await tx.complaint.update({ where: { id: complaint.id }, data: { status: "REGISTERED", caseId: kase.id } });
      await tx.case.update({ where: { id: kase.id }, data: { complaintChannel: complaint.channel, complaintReceivedAt: complaint.receivedAt } });
      await recordAudit(tx, { caseId: kase.id, actorId: user.id, action: "complaint.registered", objectType: "Complaint", objectId: complaint.id, summary: `Complaint ${complaint.ackNumber} (${complaint.channel === "HELPLINE_1930" ? "1930 helpline" : "NCRP portal"}) registered as ${caseReference(kase)}` });
    }
  }
  await refreshRecommendationsTx(tx, kase.id, user.id);
  return kase;
}

export function createCase(db: Db, user: SessionUser, raw: CreateCaseInput) {
  return db.$transaction((tx) => createCaseTx(tx, user, raw));
}

export interface CaseListFilters {
  q?: string;
  status?: string;
  type?: string;
  scope?: "mine" | "all";
}

export async function listCases(db: Db, user: SessionUser, filters: CaseListFilters) {
  const and: Prisma.CaseWhereInput[] = [caseAccessWhere(user)];
  if (filters.status === "OPEN" || filters.status === "CLOSED") and.push({ status: filters.status });
  if (filters.type === "FIR" || filters.type === "COMPLAINT") and.push({ referenceType: filters.type });
  if (filters.scope === "mine") and.push({ assignments: { some: { userId: user.id } } });
  const q = filters.q?.trim();
  if (q) {
    const firMatch = /^(?:fir\s*)?(\d{1,6})(?:\s*\/\s*(\d{4}))?$/i.exec(q);
    and.push({
      OR: [
        { title: { contains: q } },
        { complaintRef: { contains: q } },
        { fraudCategory: { contains: q } },
        { entities: { some: { value: { contains: q } } } },
        { entities: { some: { label: { contains: q } } } },
        ...(firMatch ? [{ firNumber: Number(firMatch[1]), ...(firMatch[2] ? { firYear: Number(firMatch[2]) } : {}) }] : []),
      ],
    });
  }
  const cases = await db.case.findMany({
    where: { AND: and },
    orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
    include: {
      station: true,
      assignments: { include: { user: true } },
      claims: { where: { status: "ACTIVE" } },
      _count: {
        select: {
          tasks: { where: { status: { in: ["OPEN", "DRAFT_PREPARED"] } } },
          requests: { where: { status: { in: ["SUBMITTED", "ACKNOWLEDGED", "PARTIAL_RESPONSE"] } } },
          responses: { where: { reviewStatus: { in: ["UNREVIEWED", "IN_REVIEW"] } } },
        },
      },
    },
  });
  return cases.map((c) => {
    const io = c.assignments.find((a) => a.role === "INVESTIGATING_OFFICER")?.user;
    return {
      id: c.id,
      reference: caseReference(c),
      referenceType: c.referenceType,
      title: c.title,
      fraudCategory: c.fraudCategory,
      status: c.status,
      stationName: c.station.name,
      investigatingOfficer: io ? `${shortRank(io.rank)} ${io.displayName}` : "Not assigned",
      victimCount: c.claims.length,
      totalLossMinor: c.claims.reduce((s, k) => s + k.lossAmountMinor, 0n).toString(),
      openActions: c._count.tasks,
      awaitingResponses: c._count.requests,
      responsesToReview: c._count.responses,
      registeredAt: (c.registeredAt ?? c.createdAt).toISOString(),
      isDemo: c.isDemo,
      assignedToMe: c.assignments.some((a) => a.userId === user.id),
    };
  });
}

export async function updateCaseDetails(
  db: Db,
  user: SessionUser,
  caseId: string,
  input: { expectedVersion: number; title: string; narrative: string; legalSections: string | null; fraudCategory: string | null; moVertical?: string | null; moSubtype?: string | null },
) {
  return db.$transaction(async (tx) => {
    const c = await loadCaseForUser(tx, user, caseId, "write");
    if (c.version !== input.expectedVersion) throw conflictError("The case details were changed by someone else. Reload to see the latest version.");
    if (input.title.trim().length < 5) throw new AppError("Some fields need attention.", "VALIDATION", { title: "Enter a short case title (at least 5 characters)." });
    // The vertical: undefined leaves it as it is; null or "" goes back to reading it from the facts.
    const vertical = input.moVertical === undefined ? c.moVertical : input.moVertical || null;
    const v = vertical ? verticalByKey(vertical) : null;
    if (vertical && !v) throw new AppError("Some fields need attention.", "VALIDATION", { moVertical: "Choose one of the station's investigation verticals." });
    const subtype = input.moVertical === undefined && input.moSubtype === undefined ? c.moSubtype : v && input.moSubtype && v.kinds.some((k) => k.label === input.moSubtype) ? input.moSubtype : null;
    const legal = input.legalSections?.trim() || null;
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    if (c.title !== input.title.trim()) changes.title = { from: c.title, to: input.title.trim() };
    if (c.narrative !== input.narrative.trim()) changes.narrative = { from: "(previous text)", to: "(updated text)" };
    if (c.legalSections !== legal) changes.legalSections = { from: c.legalSections, to: legal };
    if ((c.fraudCategory ?? null) !== (input.fraudCategory?.trim() || null)) changes.fraudCategory = { from: c.fraudCategory, to: input.fraudCategory };
    if ((c.moVertical ?? null) !== vertical || (c.moSubtype ?? null) !== subtype)
      changes.moVertical = { from: c.moVertical ? `${verticalByKey(c.moVertical)?.label ?? c.moVertical}${c.moSubtype ? ` · ${c.moSubtype}` : ""}` : "read from the facts", to: v ? `${v.label}${subtype ? ` · ${subtype}` : ""}` : "read from the facts" };
    if (Object.keys(changes).length === 0) return c;
    const updated = await tx.case.update({
      where: { id: caseId },
      data: {
        title: input.title.trim(),
        narrative: input.narrative.trim(),
        legalSections: legal,
        legalSectionsSource: legal ? (c.legalSections === legal ? c.legalSectionsSource : `Entered by ${user.displayName}`) : null,
        fraudCategory: input.fraudCategory?.trim() || null,
        moVertical: vertical,
        moSubtype: subtype,
        // A change by an officer is theirs; going back clears it until the FIR is classified again.
        ...(changes.moVertical ? { moBasis: vertical ? "OFFICER" : null, moReason: null } : {}),
        version: { increment: 1 },
      },
    });
    await recordAudit(tx, { caseId, actorId: user.id, action: "case.details_updated", objectType: "Case", objectId: caseId, summary: `Case details updated (${Object.keys(changes).join(", ")})`, detail: changes });
    return updated;
  });
}

export async function setCaseStatus(db: Db, user: SessionUser, caseId: string, input: { expectedVersion: number; status: "OPEN" | "CLOSED"; reason: string }) {
  return db.$transaction(async (tx) => {
    const c = await loadCaseForUser(tx, user, caseId, "write");
    if (c.version !== input.expectedVersion) throw conflictError("The case was changed by someone else. Reload and try again.");
    if (input.reason.trim().length < 5) throw new AppError("Give the reason for this decision.", "VALIDATION", { reason: "Give the reason (at least 5 characters)." });
    const updated = await tx.case.update({ where: { id: caseId }, data: { status: input.status, closureReason: input.status === "CLOSED" ? input.reason.trim() : null, version: { increment: 1 } } });
    await recordAudit(tx, {
      caseId,
      actorId: user.id,
      action: input.status === "CLOSED" ? "case.closed" : "case.reopened",
      objectType: "Case",
      objectId: caseId,
      summary: input.status === "CLOSED" ? `Case closed by officer decision: ${input.reason.trim()}` : `Case reopened: ${input.reason.trim()}`,
    });
    return updated;
  });
}
