import crypto from "node:crypto";
import { z } from "zod";
import { normalizeIdentifier, isMaskedValue } from "@/domain/identifiers";
import { now } from "../clock";
import type { Db } from "../db";
import type { SessionUser } from "../auth/session";
import { loadCaseForUser } from "../auth/access";
import { recordAudit } from "../audit";
import { AppError, notFoundError } from "../errors";
import { bankFromIfsc } from "@/domain/providers";
import { parseAttributes } from "./facts";
import { refreshRecommendationsTx } from "./tasks";
import { flagDraftsForReviewTx } from "./requests";

export const BELONGS_TO = ["SUSPECT", "VICTIM", "WITNESS", "UNKNOWN"] as const;
export const ENTRY_KINDS = ["PERSON", "PHONE", "BANK_ACCOUNT", "UPI_ID", "EMAIL", "PLATFORM_PROFILE", "WEBSITE", "IP_ADDRESS"] as const;

const entrySchema = z.object({
  kind: z.enum(ENTRY_KINDS),
  value: z.string().trim().min(1, "Enter it before saving.").max(200),
  whatItIs: z.string().trim().max(300).default(""),
  belongsTo: z.enum(BELONGS_TO).default("UNKNOWN"),
  nickname: z.string().trim().max(60).optional().nullable(),
  bank: z.string().trim().max(80).optional().nullable(),
  ifsc: z.string().trim().max(11).optional().nullable(),
});

const WORD: Record<string, string> = { PERSON: "name", PHONE: "number", BANK_ACCOUNT: "account number", UPI_ID: "UPI ID", EMAIL: "email address", PLATFORM_PROFILE: "profile", WEBSITE: "website", IP_ADDRESS: "IP address" };

/**
 * Something the officer learned that no record has given yet (a phone call, a portal screen, a visit).
 * It is kept as the officer's entry, shown as such, until a record confirms it.
 */
export async function addOfficerEntry(db: Db, user: SessionUser, caseId: string, raw: z.input<typeof entrySchema>) {
  const parsed = entrySchema.safeParse(raw);
  if (!parsed.success) {
    const kind = (raw as { kind?: string }).kind ?? "";
    throw new AppError(`Enter the ${WORD[kind] ?? "value"} before saving.`, "VALIDATION", { value: `Enter the ${WORD[kind] ?? "value"} before saving.` });
  }
  const v = parsed.data;
  return db.$transaction(async (tx) => {
    await loadCaseForUser(tx, user, caseId, "write");
    const normalizedValue = v.kind === "PERSON" ? `person:${crypto.randomUUID()}` : normalizeIdentifier(v.kind, v.value);
    if (v.kind !== "PERSON") {
      const existing = await tx.entity.findUnique({ where: { caseId_kind_normalizedValue: { caseId, kind: v.kind, normalizedValue } } });
      if (existing) throw new AppError(`${existing.label} is already in this case.`, "CONFLICT", { value: `Already in the case as ${existing.label}.` });
    }
    // What the officer learned is a new discovery phase; entries made in the same sitting share it.
    const latest = await tx.entity.findFirst({ where: { caseId }, orderBy: [{ discoveryPhase: "desc" }, { discoveredAt: "desc" }] });
    const sameSitting = !!latest && latest.discoveryPhase > 0 && latest.officerEntry && now().getTime() - latest.discoveredAt.getTime() < 2 * 3600 * 1000;
    const discoveryPhase = sameSitting ? latest!.discoveryPhase : (latest?.discoveryPhase ?? 0) + 1;
    const attributes: Record<string, string> = {};
    if (v.bank) attributes.bank = v.bank;
    if (v.ifsc) attributes.ifsc = v.ifsc.toUpperCase();
    if (!attributes.bank && attributes.ifsc) {
      const fromCode = bankFromIfsc(attributes.ifsc);
      if (fromCode) attributes.bank = fromCode;
    }
    const entity = await tx.entity.create({
      data: {
        caseId,
        kind: v.kind,
        label: v.nickname?.trim() || v.value,
        value: v.value,
        normalizedValue,
        attributesJson: JSON.stringify(attributes),
        caseRole: v.whatItIs || null,
        isMasked: v.kind !== "PERSON" && isMaskedValue(v.value),
        belongsTo: v.belongsTo,
        nickname: v.nickname?.trim() || null,
        officerEntry: true,
        discoveredAt: now(),
        discoveryPhase,
      },
    });
    await recordAudit(tx, {
      caseId,
      actorId: user.id,
      action: "entity.officer_entry_added",
      objectType: "Entity",
      objectId: entity.id,
      summary: `${entity.label} added by ${user.displayName} (${v.kind.replace(/_/g, " ").toLowerCase()}); not from any record yet`,
      detail: { whatItIs: v.whatItIs, belongsTo: v.belongsTo },
    });
    // A new identifier can call for a request (a beneficiary account to freeze, a number to trace).
    await refreshRecommendationsTx(tx, caseId, user.id);
    return entity;
  });
}

const notesSchema = z.object({
  nickname: z.string().trim().max(60).nullable().optional(),
  belongsTo: z.enum(BELONGS_TO).nullable().optional(),
  /** Accounts: the bank, or its IFSC (the bank is then read from the code). */
  bank: z.string().trim().max(80).nullable().optional(),
  ifsc: z
    .string()
    .trim()
    .max(11)
    .nullable()
    .optional()
    .refine((x) => !x || /^[A-Za-z]{4}0[A-Za-z0-9]{6}$/.test(x), "An IFSC is four letters, a zero and six letters or digits, like HDFC0001234."),
  /** Email, profile or website: who holds its records (the mail host, the platform, the registrar). */
  provider: z.string().trim().max(80).nullable().optional(),
});

/**
 * The officer's own notes on an identifier: a nickname, whose it is, and for routing requests the bank of an account
 * or the provider that holds an email's, a profile's or a website's records. What any record said is untouched; the
 * next actions are worked out again, so a request that was waiting for the bank or provider can be drafted.
 */
export async function updateIdentifierNotes(db: Db, user: SessionUser, entityId: string, raw: z.input<typeof notesSchema>) {
  const parsed = notesSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new AppError(issue.message, "VALIDATION", { [String(issue.path[0] ?? "value")]: issue.message });
  }
  const v = parsed.data;
  return db.$transaction(async (tx) => {
    const e = await tx.entity.findUnique({ where: { id: entityId } });
    if (!e) throw notFoundError("identifier");
    await loadCaseForUser(tx, user, e.caseId, "write");
    const nickname = v.nickname === undefined ? e.nickname : v.nickname?.trim() || null;
    const belongsTo = v.belongsTo === undefined ? e.belongsTo : v.belongsTo;
    const before = parseAttributes(e.attributesJson);
    const attrs: Record<string, unknown> = { ...before };
    if (v.ifsc !== undefined) {
      if (v.ifsc) attrs.ifsc = v.ifsc.toUpperCase();
      else delete attrs.ifsc;
    }
    if (v.bank !== undefined) {
      if (v.bank) attrs.bank = v.bank;
      else delete attrs.bank;
    }
    if (!attrs.bank && typeof attrs.ifsc === "string") {
      const fromCode = bankFromIfsc(attrs.ifsc);
      if (fromCode) attrs.bank = fromCode;
    }
    if (v.provider !== undefined) {
      if (v.provider) attrs.provider = v.provider;
      else delete attrs.provider;
    }
    const routingChanged = ["bank", "ifsc", "provider"].some((k) => before[k] !== attrs[k]);
    const updated = await tx.entity.update({ where: { id: e.id }, data: { nickname, belongsTo, attributesJson: JSON.stringify(attrs) } });
    const routing = [attrs.bank ? `bank ${attrs.bank as string}` : null, attrs.ifsc ? `IFSC ${attrs.ifsc as string}` : null, attrs.provider ? `provider ${attrs.provider as string}` : null].filter(Boolean).join(", ");
    await recordAudit(tx, {
      caseId: e.caseId,
      actorId: user.id,
      action: "entity.notes_updated",
      objectType: "Entity",
      objectId: e.id,
      summary: `${user.displayName} noted ${e.label}${nickname ? ` as "${nickname}"` : ""}${belongsTo ? `, belonging to: ${belongsTo.toLowerCase()}` : ""}${routingChanged && routing ? `; ${routing}` : ""}. What the records said is unchanged.`,
      detail: { before: { nickname: e.nickname, belongsTo: e.belongsTo, bank: before.bank ?? null, ifsc: before.ifsc ?? null, provider: before.provider ?? null }, after: { nickname, belongsTo, bank: attrs.bank ?? null, ifsc: attrs.ifsc ?? null, provider: attrs.provider ?? null } },
    });
    if (routingChanged || belongsTo !== e.belongsTo) {
      // Unsent drafts about this identifier may now go elsewhere; the next actions are worked out again.
      if (routingChanged) await flagDraftsForReviewTx(tx, e.caseId, [e.id], "The bank or provider of this identifier was changed after the draft was written.");
      await refreshRecommendationsTx(tx, e.caseId, user.id);
    }
    return updated;
  });
}

const personSchema = z.object({
  /** The card's version when it was opened: a save over someone else's newer change is refused. */
  version: z.string().min(1),
  name: z.string().trim().max(120).nullable().optional(),
  alias: z.string().trim().max(60).nullable().optional(),
  relative: z.string().trim().max(120).nullable().optional(),
  age: z.string().trim().max(20).nullable().optional(),
  gender: z.string().trim().max(20).nullable().optional(),
  address: z.string().trim().max(400).nullable().optional(),
  occupation: z.string().trim().max(120).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  belongsTo: z.enum(BELONGS_TO).nullable().optional(),
});
const PERSON_FIELDS = ["name", "relative", "age", "gender", "address", "occupation", "notes"] as const;
const FIELD_WORD: Record<(typeof PERSON_FIELDS)[number] | "alias" | "belongsTo", string> = { name: "name", relative: "father's or husband's name", age: "age", gender: "gender", address: "address", occupation: "occupation", notes: "notes", alias: "alias", belongsTo: "side" };

/**
 * The officer's own details for a person: a name learned during the investigation, an alias, the father's or husband's
 * name, age, gender, address, occupation, notes and whose side they are on. They are kept beside what the records
 * said (never over it), shown as the officer's entry, and every change is logged with the before and after.
 */
export async function updatePersonDetails(db: Db, user: SessionUser, entityId: string, raw: z.input<typeof personSchema>) {
  const parsed = personSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    const field = String(issue.path[0] ?? "value");
    const msg = issue.code === "too_big" ? `The ${FIELD_WORD[field as keyof typeof FIELD_WORD] ?? field} is too long.` : issue.message;
    throw new AppError(msg, "VALIDATION", { [field]: msg });
  }
  const v = parsed.data;
  return db.$transaction(async (tx) => {
    const e = await tx.entity.findUnique({ where: { id: entityId } });
    if (!e || e.kind !== "PERSON") throw notFoundError("person");
    await loadCaseForUser(tx, user, e.caseId, "write");
    if (e.updatedAt.toISOString() !== v.version) throw new AppError("These details were changed by someone else after you opened the card. Close it and open it again to see their change, then make yours.", "CONFLICT");
    const attrs = parseAttributes(e.attributesJson);
    const before = (attrs.officer && typeof attrs.officer === "object" ? attrs.officer : {}) as Record<string, string>;
    const after: Record<string, string> = {};
    for (const k of PERSON_FIELDS) {
      const next = v[k] === undefined ? before[k] : v[k]?.trim();
      if (next) after[k] = next;
    }
    const nickname = v.alias === undefined ? e.nickname : v.alias?.trim() || null;
    const belongsTo = v.belongsTo === undefined ? e.belongsTo : v.belongsTo;
    const changed = [...PERSON_FIELDS.filter((k) => (before[k] ?? null) !== (after[k] ?? null)), ...(nickname !== e.nickname ? (["alias"] as const) : []), ...(belongsTo !== e.belongsTo ? (["belongsTo"] as const) : [])];
    if (!changed.length) return { entity: e, changed: [] as string[] };
    const stamp = { by: user.id, at: now().toISOString() };
    const officer = Object.keys(after).length ? { ...after, ...stamp } : undefined;
    const nextAttrs: Record<string, unknown> = { ...attrs };
    if (officer) nextAttrs.officer = officer;
    else delete nextAttrs.officer;
    const updated = await tx.entity.update({ where: { id: e.id }, data: { nickname, belongsTo, attributesJson: JSON.stringify(nextAttrs) } });
    await recordAudit(tx, {
      caseId: e.caseId,
      actorId: user.id,
      action: "entity.person_details_updated",
      objectType: "Entity",
      objectId: e.id,
      summary: `${user.displayName} updated the ${changed.map((k) => FIELD_WORD[k]).join(", ")} of ${e.label}${after.name && changed.includes("name") ? ` (name entered: "${after.name}")` : ""}. What the records said is unchanged.`,
      detail: { before: { ...Object.fromEntries(PERSON_FIELDS.map((k) => [k, before[k] ?? null])), alias: e.nickname, belongsTo: e.belongsTo }, after: { ...Object.fromEntries(PERSON_FIELDS.map((k) => [k, after[k] ?? null])), alias: nickname, belongsTo } },
    });
    // Whose side someone is on changes what the rules suggest (the investigation is about the accused).
    if (belongsTo !== e.belongsTo) await refreshRecommendationsTx(tx, e.caseId, user.id);
    return { entity: updated, changed: changed as string[] };
  });
}
