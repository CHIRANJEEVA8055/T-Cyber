import type { Prisma } from "@/generated/prisma/client";
import { nodalKey, type Provider } from "@/domain/providers";
import { canWorkCases } from "@/domain/permissions";
import type { Db, Tx } from "../db";
import type { SessionUser } from "../auth/session";
import { recordAudit } from "../audit";
import { now } from "../clock";
import { AppError, notFoundError } from "../errors";
import { readXlsx } from "../documents/xlsx";

/**
 * The nodal officer directory: who to write to at each bank, wallet, telecom operator, platform and other provider,
 * from the CrimeOS nodal officer list the station imports. It is a reference list. A contact becomes a request's
 * recipient only after a supervisor adds it to the recipient directory and verifies it; nothing is ever sent from
 * here, and the email gateway stays simulated.
 */

const clean = (s: string) => s.replace(/\s+/g, " ").trim();
/** "Ujjivan Small Finance\nBank Ltd." → "ujjivan small finance bank". */
export const providerKey = nodalKey;
const TYPE_LABEL: Record<string, string> = { "e commerce website": "E-commerce website", "credit card": "Credit card", "": "Other" };
export const serviceTypeOf = (raw: string) => {
  const k = clean(raw).replace(/-\s*/g, "-").replace(/\s*\/\s*/g, " / ");
  return TYPE_LABEL[k.toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim()] ?? (k || "Other");
};
const emailsIn = (s: string) => [...new Set((s.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g) ?? []).map((e) => e.toLowerCase()))];
const phonesIn = (s: string) => [...new Set((s.match(/\+?\d[\d\s-]{6,}\d/g) ?? []).map((p) => p.replace(/[\s-]/g, "")).filter((p) => p.replace(/\D/g, "").length >= 8))];

function assertManager(user: SessionUser) {
  if (user.role !== "SUPERVISOR" && user.role !== "DEVELOPER") throw new AppError("Only a supervisor or the developer account can import the nodal officer list.", "FORBIDDEN");
}

/** Imports (or refreshes) the list from the CrimeOS export workbook; records are matched by their record ID. */
export async function importNodalWorkbook(db: Db, user: SessionUser, file: { fileName: string; buffer: Buffer }) {
  assertManager(user);
  let sheets: ReturnType<typeof readXlsx>;
  try {
    sheets = readXlsx(file.buffer);
  } catch {
    throw new AppError("The file could not be read as an Excel workbook (.xlsx). Export the list again and upload that file.");
  }
  const sheet = sheets.find((s) => /nodal/i.test(s.name)) ?? sheets[0];
  const header = sheet?.rows[0]?.map((h) => clean(h).toLowerCase()) ?? [];
  const col = (re: RegExp) => header.findIndex((h) => re.test(h));
  const c = { type: col(/service type/), provider: col(/provider name/), officer: col(/nodal officer/), email: col(/email/), phone: col(/phone/), address: col(/address/), record: col(/record id/), created: col(/created/) };
  if (!sheet || c.provider < 0 || c.email < 0 || c.record < 0) throw new AppError("This workbook does not look like the nodal officer list: it needs Provider Name, Provider Email and Record ID columns.");
  const source = `${file.fileName} (imported ${now().toISOString().slice(0, 10)})`;
  let added = 0,
    updated = 0,
    skipped = 0;
  const rows = sheet.rows.slice(1);
  for (let i = 0; i < rows.length; i += 200) {
    await db.$transaction(async (tx) => {
      for (const r of rows.slice(i, i + 200)) {
        const recordId = clean(r[c.record] ?? "");
        const provider = clean(r[c.provider] ?? "");
        if (!recordId || !provider) {
          skipped++;
          continue;
        }
        const emails = emailsIn(`${r[c.email] ?? ""}`);
        const officer = clean(r[c.officer] ?? "") || null;
        const data = {
          serviceType: serviceTypeOf(r[c.type] ?? ""),
          provider,
          providerKey: providerKey(provider),
          officerName: officer,
          emailsJson: JSON.stringify(emails),
          phonesJson: JSON.stringify(phonesIn(`${c.phone >= 0 ? (r[c.phone] ?? "") : ""}`)),
          address: c.address >= 0 ? clean(r[c.address] ?? "") || null : null,
          listedAt: c.created >= 0 && /^\d{4}-\d{2}-\d{2}/.test(r[c.created] ?? "") ? new Date(`${(r[c.created] ?? "").replace(" ", "T")}+05:30`) : null,
          source,
          importedAt: now(),
        };
        const existing = await tx.nodalContact.findUnique({ where: { recordId }, select: { id: true } });
        if (existing) {
          await tx.nodalContact.update({ where: { recordId }, data });
          updated++;
        } else {
          await tx.nodalContact.create({ data: { recordId, ...data } });
          added++;
        }
      }
    });
  }
  await db.$transaction((tx) => recordAudit(tx, { caseId: null, actorId: user.id, action: "directory.nodal_imported", objectType: "NodalContact", objectId: null, summary: `Imported the nodal officer list ${file.fileName}: ${added} added, ${updated} updated${skipped ? `, ${skipped} rows without a provider skipped` : ""}` }));
  return { added, updated, skipped, total: added + updated };
}

export type NodalRow = { id: string; serviceType: string; provider: string; officerName: string | null; emails: string[]; phones: string[]; address: string | null };
const toRow = (n: { id: string; serviceType: string; provider: string; officerName: string | null; emailsJson: string; phonesJson: string; address: string | null }): NodalRow => ({
  id: n.id,
  serviceType: n.serviceType,
  provider: clean(n.provider),
  officerName: n.officerName,
  emails: JSON.parse(n.emailsJson) as string[],
  phones: JSON.parse(n.phonesJson) as string[],
  address: n.address,
});

export const NODAL_SORTS = ["provider", "officer", "email", "phone"] as const;
export type NodalSort = (typeof NODAL_SORTS)[number];

export async function listNodal(db: Db, user: SessionUser, opts: { q?: string; type?: string; page?: number; sort?: string; dir?: string } = {}) {
  if (!canWorkCases(user) && user.role !== "DEVELOPER") throw new AppError("This account cannot open the nodal officer list.", "FORBIDDEN");
  const q = opts.q?.trim().slice(0, 80);
  const where: Prisma.NodalContactWhereInput = {
    ...(opts.type && opts.type !== "ALL" ? { serviceType: opts.type } : {}),
    ...(q ? { OR: [{ providerKey: { contains: providerKey(q) || q.toLowerCase() } }, { provider: { contains: q } }, { officerName: { contains: q } }, { emailsJson: { contains: q.toLowerCase() } }] } : {}),
  };
  const size = 50;
  const page = Math.max(1, Math.floor(opts.page ?? 1));
  const [rows, total, types, all] = await Promise.all([
    db.nodalContact.findMany({ where, orderBy: nodalOrder(opts.sort, opts.dir), skip: (page - 1) * size, take: size }),
    db.nodalContact.count({ where }),
    db.nodalContact.groupBy({ by: ["serviceType"], _count: { _all: true }, orderBy: { _count: { serviceType: "desc" } } }),
    db.nodalContact.count(),
  ]);
  const latest = await db.nodalContact.findFirst({ orderBy: { importedAt: "desc" }, select: { importedAt: true, source: true } });
  const sort = (NODAL_SORTS as readonly string[]).includes(opts.sort ?? "") ? (opts.sort as NodalSort) : null;
  return { rows: rows.map(toRow), total, all, page, sort, dir: sort && opts.dir === "desc" ? ("desc" as const) : ("asc" as const), pages: Math.max(1, Math.ceil(total / size)), types: types.map((t) => ({ type: t.serviceType, count: t._count._all })), source: latest?.source ?? null, importedAt: latest?.importedAt.toISOString() ?? null };
}
export type NodalList = Awaited<ReturnType<typeof listNodal>>;

/** The list's order: by the chosen column (empty values last), then by provider and officer; by provider by default. */
function nodalOrder(sort: string | undefined, dir: string | undefined): Prisma.NodalContactOrderByWithRelationInput[] {
  const d: Prisma.SortOrder = dir === "desc" ? "desc" : "asc";
  const tail: Prisma.NodalContactOrderByWithRelationInput[] = [{ providerKey: "asc" }, { officerName: { sort: "asc", nulls: "last" } }, { recordId: "asc" }];
  switch (sort) {
    case "provider":
      return [{ providerKey: d }, ...tail.slice(1)];
    case "officer":
      return [{ officerName: { sort: d, nulls: "last" } }, ...tail];
    case "email":
      return [{ emailsJson: d }, ...tail];
    case "phone":
      return [{ phonesJson: d }, ...tail];
    default:
      return tail;
  }
}

/** The contacts on the list for an organisation ("HDFC Bank", "Bank A (synthetic)" matches nothing). */
export async function nodalFor(db: Db, organisation: string, limit = 8): Promise<NodalRow[]> {
  const key = providerKey(organisation);
  if (key.length < 3) return [];
  const exact = await db.nodalContact.findMany({ where: { providerKey: key }, take: limit });
  const rows = exact.length ? exact : await db.nodalContact.findMany({ where: { providerKey: { startsWith: key } }, take: limit });
  return rows.map(toRow).filter((r) => r.emails.length);
}

const ORG_TYPE: Record<string, string> = { Bank: "BANK", Wallet: "PAYMENT_PROVIDER", "Wallet & PPI": "PAYMENT_PROVIDER", TSP: "TELECOM", ISP: "TELECOM", "Social Media Provider": "PLATFORM", "Social Media Platforms": "PLATFORM", "Messenging Platforms": "PLATFORM", "Email Platforms": "PLATFORM" };

/** A supervisor adds one address from the list to the recipient directory, unverified until they verify it. */
export async function addRecipientFromNodal(db: Db, user: SessionUser, input: { contactId: string; email: string }) {
  if (user.role !== "SUPERVISOR") throw new AppError("Only a supervisor can add recipients to the directory.", "FORBIDDEN");
  const c = await db.nodalContact.findUnique({ where: { id: input.contactId } });
  if (!c) throw notFoundError("nodal contact");
  const email = input.email.trim().toLowerCase();
  if (!(JSON.parse(c.emailsJson) as string[]).includes(email)) throw new AppError("Choose one of the addresses the list gives for this contact.", "VALIDATION");
  const dup = await db.recipient.findFirst({ where: { address: email } });
  if (dup) throw new AppError(`${email} is already in the recipient directory as ${dup.organisation}.`, "CONFLICT");
  return db.$transaction(async (tx) => {
    const r = await tx.recipient.create({
      data: {
        name: c.officerName ? `${clean(c.officerName)}, Nodal Officer` : "Nodal Officer",
        organisation: clean(c.provider),
        organisationType: ORG_TYPE[c.serviceType] ?? "PLATFORM",
        channel: "EMAIL",
        address: email,
        verificationStatus: "UNVERIFIED",
        verificationNote: `From the nodal officer list (${c.source}); check it before it is used.`,
        categoriesJson: "[]",
        isSynthetic: false,
      },
    });
    await recordAudit(tx, { caseId: null, actorId: user.id, action: "directory.recipient_added", objectType: "Recipient", objectId: r.id, summary: `Added ${email} (${clean(c.provider)}) from the nodal officer list, unverified` });
    return { id: r.id };
  });
}

const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/;

/**
 * The address to write to a provider at, from the nodal officer list: the provider's own entries (by the names it goes
 * by there, preferring the right kind of entry), at its usual email domain, so a mistyped address on the list is not
 * chosen. The recipient is added to the directory unverified (or reused, keeping whatever a supervisor decided), so
 * a draft can be prepared; nothing can be sent to it until a supervisor verifies it.
 */
export async function nodalRecipientFor(tx: Db | Tx, provider: Provider, opts: { organisationType: string; category: string }) {
  // An address a supervisor already put in the directory for this organisation comes first, verified ones first.
  const own = (await tx.recipient.findMany({ where: { isSynthetic: false, active: true } })).filter((r) => provider.keys.includes(nodalKey(r.organisation)));
  const chosen = own.sort((a, b) => Number(b.verificationStatus === "VERIFIED") - Number(a.verificationStatus === "VERIFIED"))[0];
  if (chosen) {
    const cats = JSON.parse(chosen.categoriesJson) as string[];
    return cats.includes(opts.category) ? chosen : tx.recipient.update({ where: { id: chosen.id }, data: { categoriesJson: JSON.stringify([...cats, opts.category]) } });
  }
  const rows = await tx.nodalContact.findMany({ where: { providerKey: { in: provider.keys } }, orderBy: [{ recordId: "asc" }] });
  const typed = rows.filter((r) => provider.types.includes(r.serviceType));
  const pool = (typed.length ? typed : rows).map((r) => ({ r, emails: (JSON.parse(r.emailsJson) as string[]).filter((e) => EMAIL.test(e)) })).filter((x) => x.emails.length);
  if (!pool.length) return null;
  const count = new Map<string, number>();
  for (const x of pool) for (const e of x.emails) count.set(e.split("@")[1]!, (count.get(e.split("@")[1]!) ?? 0) + 1);
  const domain = provider.domains.find((d) => count.has(d)) ?? [...count.entries()].sort((a, b) => b[1] - a[1])[0]![0];
  const pick = pool.find((x) => x.emails.some((e) => e.endsWith(`@${domain}`)))!;
  const address = pick.emails.find((e) => e.endsWith(`@${domain}`))!;
  const existing = await tx.recipient.findFirst({ where: { address } });
  if (existing) {
    const cats = JSON.parse(existing.categoriesJson) as string[];
    if (!existing.isSynthetic && !cats.includes(opts.category)) return tx.recipient.update({ where: { id: existing.id }, data: { categoriesJson: JSON.stringify([...cats, opts.category]) } });
    return existing;
  }
  return tx.recipient.create({
    data: {
      name: pick.r.officerName ? `${clean(pick.r.officerName)}, Nodal Officer` : "Nodal Officer",
      organisation: provider.name,
      organisationType: opts.organisationType,
      channel: "EMAIL",
      address,
      verificationStatus: "UNVERIFIED",
      verificationNote: `From the nodal officer list (${pick.r.source}). A supervisor verifies it before anything is sent to it.`,
      categoriesJson: JSON.stringify(["INFORMATION", "PRESERVATION", "HOLD", "RESTORATION"].filter((c) => opts.organisationType === "BANK" || c !== "HOLD")),
      isSynthetic: false,
    },
  });
}

/** Whether the directory or the nodal officer list has an address for a provider (nothing is created). */
export async function nodalAddressAvailable(tx: Db | Tx, provider: Provider): Promise<boolean> {
  const own = (await tx.recipient.findMany({ where: { isSynthetic: false, active: true }, select: { organisation: true } })).some((r) => provider.keys.includes(nodalKey(r.organisation)));
  if (own) return true;
  const rows = await tx.nodalContact.findMany({ where: { providerKey: { in: provider.keys } }, select: { emailsJson: true } });
  return rows.some((r) => (JSON.parse(r.emailsJson) as string[]).some((e) => EMAIL.test(e)));
}
