import { z } from "zod";
import { canManageKnowledge } from "@/domain/permissions";
import { splitIntoSections } from "@/domain/knowledge-split";
import { istInputToUtc } from "@/domain/time";
import type { Db, Tx } from "../db";
import type { SessionUser } from "../auth/session";
import { recordAudit } from "../audit";
import { now } from "../clock";
import { AppError, notFoundError } from "../errors";
import { KNOWLEDGE_AREA, readStoredFile, storeFile } from "../storage";
import { readTextDocument } from "../documents/read-text";

/**
 * The knowledge base the procedure assistant answers from. Only the developer account changes it, and every change
 * is in the audit log. A document goes DRAFT → CURRENT when published; a new version supersedes the old one on
 * publication; a retired document is WITHDRAWN and no longer answered from. Officers only ever see what is published.
 */

export const CATEGORIES = ["SOP", "CIRCULAR", "LAW", "PROVIDER", "OTHER"] as const;
export type KnowledgeCategory = (typeof CATEGORIES)[number];
export const CATEGORY_LABEL: Record<KnowledgeCategory, string> = { SOP: "SOP", CIRCULAR: "Circular", LAW: "Law", PROVIDER: "Provider policy", OTHER: "Other guidance" };
export const STATUS_LABEL: Record<string, string> = { DRAFT: "Draft", CURRENT: "Current", SUPERSEDED: "Superseded", WITHDRAWN: "Retired" };

function assertDeveloper(user: SessionUser) {
  if (!canManageKnowledge(user)) throw new AppError("Only the developer account can change the knowledge base.", "FORBIDDEN");
}

const text = (min: number, max: number, what: string) => z.string().trim().min(min, `Enter ${what}.`).max(max, `Keep ${what} under ${max} characters.`);

export const metaSchema = z.object({
  title: text(3, 200, "the document's title"),
  docNumber: text(1, 80, "its number (or “—” if it has none)"),
  issuingBody: text(2, 160, "who issued it"),
  jurisdiction: text(2, 120, "where it applies"),
  version: text(1, 40, "its version"),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter the date it takes effect, like 2026-11-01."),
  category: z.enum(CATEGORIES, { message: "Choose what kind of document it is." }),
  summary: text(10, 600, "a one-line summary of what it covers"),
  reviewNote: z.string().trim().max(400, "Keep the warning under 400 characters.").optional().default(""),
});
export type KnowledgeMeta = z.input<typeof metaSchema>;

const sectionSchema = z.object({
  sectionRef: text(1, 40, "the section's reference"),
  heading: text(1, 160, "the section's heading"),
  text: text(1, 20000, "the section's text"),
});

function parseMeta(raw: unknown) {
  const r = metaSchema.safeParse(raw);
  if (!r.success) {
    const fieldErrors: Record<string, string> = {};
    for (const i of r.error.issues) fieldErrors[String(i.path[0])] ??= i.message;
    throw new AppError("Some details are missing or need a fix. Check the marked fields.", "VALIDATION", fieldErrors);
  }
  return r.data;
}

function metaData(m: z.output<typeof metaSchema>) {
  return {
    title: m.title,
    docNumber: m.docNumber,
    issuingBody: m.issuingBody,
    jurisdiction: m.jurisdiction,
    version: m.version,
    effectiveFrom: istInputToUtc(`${m.effectiveFrom}T00:00`)!,
    category: m.category,
    summary: m.summary,
    reviewNote: m.reviewNote || null,
  };
}

async function loadDoc(db: Db | Tx, id: string) {
  const d = await db.knowledgeDocument.findUnique({ where: { id }, include: { sections: { orderBy: { sortOrder: "asc" } } } });
  if (!d) throw notFoundError("document");
  return d;
}

const audit = (tx: Tx, user: SessionUser, action: string, id: string, summary: string, detail?: Record<string, unknown>) =>
  recordAudit(tx, { caseId: null, actorId: user.id, action, objectType: "KnowledgeDocument", objectId: id, summary, detail });

export async function listKnowledge(db: Db, user: SessionUser, opts: { status?: string; q?: string } = {}) {
  assertDeveloper(user);
  const docs = await db.knowledgeDocument.findMany({ include: { _count: { select: { sections: true } } }, orderBy: [{ updatedAt: "desc" }] });
  const byId = new Map(docs.map((d) => [d.id, d]));
  const q = opts.q?.trim().toLowerCase();
  const rows = docs
    .filter((d) => !opts.status || opts.status === "ALL" || d.status === opts.status)
    .filter((d) => !q || `${d.title} ${d.docNumber} ${d.issuingBody}`.toLowerCase().includes(q))
    .map((d) => ({
      id: d.id,
      title: d.title,
      docNumber: d.docNumber,
      issuingBody: d.issuingBody,
      category: d.category as KnowledgeCategory,
      version: d.version,
      effectiveFrom: d.effectiveFrom.toISOString(),
      status: d.status,
      sections: d._count.sections,
      updatedAt: d.updatedAt.toISOString(),
      isSynthetic: d.isSynthetic,
      fileName: d.fileName,
      replaces: d.replacesId ? (byId.get(d.replacesId)?.title ?? null) : null,
      supersededBy: d.supersededById ? (byId.get(d.supersededById)?.version ?? null) : null,
    }));
  const count = (s: string) => docs.filter((d) => d.status === s).length;
  return { rows, counts: { ALL: docs.length, DRAFT: count("DRAFT"), CURRENT: count("CURRENT"), SUPERSEDED: count("SUPERSEDED"), WITHDRAWN: count("WITHDRAWN") } };
}

/** One document with its sections. Officers can open published documents only; the developer sees drafts and history. */
export async function getKnowledgeDocument(db: Db, user: SessionUser, id: string) {
  const d = await loadDoc(db, id);
  const dev = canManageKnowledge(user);
  if (!dev && d.status !== "CURRENT" && d.status !== "SUPERSEDED") throw notFoundError("document");
  const [successor, replaces, history] = await Promise.all([
    d.supersededById ? db.knowledgeDocument.findUnique({ where: { id: d.supersededById }, select: { id: true, title: true, version: true, effectiveFrom: true } }) : null,
    d.replacesId ? db.knowledgeDocument.findUnique({ where: { id: d.replacesId }, select: { id: true, title: true, version: true, status: true } }) : null,
    dev ? db.auditEvent.findMany({ where: { objectType: "KnowledgeDocument", objectId: id }, orderBy: { at: "desc" }, take: 50 }) : [],
  ]);
  const actors = dev ? await db.user.findMany({ where: { id: { in: history.map((h) => h.actorId).filter((x): x is string => !!x) } }, select: { id: true, displayName: true } }) : [];
  return {
    id: d.id,
    title: d.title,
    docNumber: d.docNumber,
    issuingBody: d.issuingBody,
    jurisdiction: d.jurisdiction,
    version: d.version,
    effectiveFrom: d.effectiveFrom.toISOString(),
    category: d.category as KnowledgeCategory,
    status: d.status,
    summary: d.summary,
    reviewNote: d.reviewNote,
    isSynthetic: d.isSynthetic,
    fileName: dev ? d.fileName : null,
    hasOriginal: dev && !!d.storageKey,
    sha256: dev ? d.sha256 : null,
    readNote: dev ? d.readNote : null,
    retiredReason: d.retiredReason,
    publishedAt: d.publishedAt?.toISOString() ?? null,
    successor: successor ? { id: successor.id, title: successor.title, version: successor.version } : null,
    replaces,
    sections: d.sections.map((s) => ({ id: s.id, sectionRef: s.sectionRef, heading: s.heading, text: s.text })),
    history: history.map((h) => ({ id: h.id, at: h.at.toISOString(), action: h.action, summary: h.summary, by: actors.find((a) => a.id === h.actorId)?.displayName ?? "System" })),
  };
}
export type KnowledgeDocumentView = Awaited<ReturnType<typeof getKnowledgeDocument>>;

/** Reads an uploaded file, splits it into sections and keeps it as a draft for the developer to check. */
export async function uploadKnowledgeDocument(db: Db, user: SessionUser, input: { fileName: string; buffer: Buffer; meta: unknown; replacesId?: string | null }) {
  assertDeveloper(user);
  const meta = parseMeta(input.meta);
  const read = await readTextDocument(input.fileName, input.buffer);
  const sections = splitIntoSections(read.blocks);
  if (!sections.length) throw new AppError("No readable text was found in the file. If it is a scan, ask for the issued text version, or type it into a .txt or .docx file.");
  if (input.replacesId) {
    const old = await loadDoc(db, input.replacesId);
    if (old.status !== "CURRENT") throw new AppError("Only a current document can be replaced by a new version.", "PRECONDITION");
  }
  const stored = storeFile(input.buffer, input.fileName, { area: KNOWLEDGE_AREA });
  const at = now();
  return db.$transaction(async (tx) => {
    const d = await tx.knowledgeDocument.create({
      data: {
        ...metaData(meta),
        status: "DRAFT",
        isSynthetic: false,
        fileName: input.fileName.slice(0, 200),
        storageKey: stored.storageKey,
        sha256: stored.sha256,
        readNote: `${read.readNote}; ${sections.length} ${sections.length === 1 ? "section" : "sections"} found`,
        replacesId: input.replacesId ?? null,
        createdById: user.id,
        createdAt: at,
        updatedAt: at,
        sections: { create: sections.map((s, i) => ({ sectionRef: s.sectionRef, heading: s.heading, text: s.text, topicsJson: JSON.stringify(s.topics), sortOrder: i })) },
      },
    });
    await audit(tx, user, "knowledge.uploaded", d.id, `Uploaded “${meta.title}” (${input.fileName}) as a draft: ${sections.length} sections`, { sha256: stored.sha256, fileName: input.fileName, replacesId: input.replacesId ?? null });
    return { id: d.id, sections: sections.length };
  });
}

/** Edits a draft's details and sections. Published documents are changed by starting a new version. */
export async function updateKnowledgeDraft(db: Db, user: SessionUser, id: string, input: { meta?: unknown; sections?: unknown }) {
  assertDeveloper(user);
  const d = await loadDoc(db, id);
  if (d.status !== "DRAFT") throw new AppError("Only a draft can be edited. Start a new version to change a published document.", "PRECONDITION");
  const meta = input.meta === undefined ? null : parseMeta(input.meta);
  let sections: z.output<typeof sectionSchema>[] | null = null;
  if (input.sections !== undefined) {
    const r = z.array(sectionSchema).min(1, "Keep at least one section.").safeParse(input.sections);
    if (!r.success) {
      const first = r.error.issues[0]!;
      const n = typeof first.path[0] === "number" ? ` (section ${first.path[0] + 1})` : "";
      throw new AppError(`${first.message}${n}`, "VALIDATION");
    }
    sections = r.data;
    const refs = new Set<string>();
    for (const s of sections) {
      if (refs.has(s.sectionRef)) throw new AppError(`Two sections share the reference “${s.sectionRef}”. Give each section its own reference.`, "VALIDATION");
      refs.add(s.sectionRef);
    }
  }
  await db.$transaction(async (tx) => {
    if (meta) await tx.knowledgeDocument.update({ where: { id }, data: { ...metaData(meta), updatedAt: now() } });
    if (sections) {
      await tx.knowledgeSection.deleteMany({ where: { documentId: id } });
      await tx.knowledgeSection.createMany({ data: sections.map((s, i) => ({ documentId: id, sectionRef: s.sectionRef, heading: s.heading, text: s.text, topicsJson: JSON.stringify([s.heading.toLowerCase().slice(0, 80)]), sortOrder: i })) });
      await tx.knowledgeDocument.update({ where: { id }, data: { updatedAt: now() } });
    }
    await audit(tx, user, "knowledge.draft_edited", id, `Edited the draft “${meta?.title ?? d.title}”${sections ? `: ${sections.length} sections` : ""}`);
  });
}

export async function publishKnowledgeDocument(db: Db, user: SessionUser, id: string) {
  assertDeveloper(user);
  const at = now();
  await db.$transaction(async (tx) => {
    const d = await loadDoc(tx, id);
    if (d.status !== "DRAFT") throw new AppError("This document is already published.", "CONFLICT");
    if (!d.sections.length) throw new AppError("Add at least one section before publishing.", "PRECONDITION");
    // The details are checked again: a draft saved before a rule changed must still be complete.
    parseMeta({ ...d, effectiveFrom: d.effectiveFrom.toISOString().slice(0, 10), reviewNote: d.reviewNote ?? "" });
    await tx.knowledgeDocument.update({ where: { id }, data: { status: "CURRENT", publishedAt: at, publishedById: user.id, updatedAt: at } });
    let replaced = "";
    if (d.replacesId) {
      const old = await tx.knowledgeDocument.findUnique({ where: { id: d.replacesId } });
      if (old && old.status === "CURRENT") {
        await tx.knowledgeDocument.update({ where: { id: old.id }, data: { status: "SUPERSEDED", supersededById: id, updatedAt: at } });
        await audit(tx, user, "knowledge.superseded", old.id, `“${old.title}” ${old.version} superseded by ${d.version}`, { by: id });
        replaced = `; it supersedes ${old.version}`;
      }
    }
    await audit(tx, user, "knowledge.published", id, `Published “${d.title}” ${d.version}: ${d.sections.length} sections${replaced}`);
  });
}

/** Starts a draft copy of a published document; publishing it supersedes the current one. */
export async function startNewVersion(db: Db, user: SessionUser, id: string) {
  assertDeveloper(user);
  const d = await loadDoc(db, id);
  if (d.status !== "CURRENT") throw new AppError("Only a current document can get a new version.", "PRECONDITION");
  const open = await db.knowledgeDocument.findFirst({ where: { replacesId: id, status: "DRAFT" } });
  if (open) return { id: open.id, existing: true };
  const at = now();
  return db.$transaction(async (tx) => {
    const n = await tx.knowledgeDocument.create({
      data: {
        title: d.title,
        docNumber: d.docNumber,
        issuingBody: d.issuingBody,
        jurisdiction: d.jurisdiction,
        version: `${d.version} (new)`,
        effectiveFrom: d.effectiveFrom,
        category: d.category,
        summary: d.summary,
        reviewNote: d.reviewNote,
        status: "DRAFT",
        isSynthetic: d.isSynthetic,
        replacesId: d.id,
        createdById: user.id,
        createdAt: at,
        updatedAt: at,
        sections: { create: d.sections.map((s) => ({ sectionRef: s.sectionRef, heading: s.heading, text: s.text, topicsJson: s.topicsJson, sortOrder: s.sortOrder })) },
      },
    });
    await audit(tx, user, "knowledge.version_started", n.id, `Started a new version of “${d.title}” ${d.version}`, { replacesId: d.id });
    return { id: n.id, existing: false };
  });
}

export async function retireKnowledgeDocument(db: Db, user: SessionUser, id: string, reason: string) {
  assertDeveloper(user);
  const why = reason.trim();
  if (why.length < 10) throw new AppError("Say why it is retired, in a sentence (at least 10 characters).", "VALIDATION", { reason: "Say why it is retired." });
  await db.$transaction(async (tx) => {
    const d = await loadDoc(tx, id);
    if (d.status !== "CURRENT") throw new AppError("Only a current document can be retired.", "PRECONDITION");
    await tx.knowledgeDocument.update({ where: { id }, data: { status: "WITHDRAWN", retiredReason: why, updatedAt: now() } });
    await audit(tx, user, "knowledge.retired", id, `Retired “${d.title}” ${d.version}: ${why}`);
  });
}

export async function restoreKnowledgeDocument(db: Db, user: SessionUser, id: string) {
  assertDeveloper(user);
  await db.$transaction(async (tx) => {
    const d = await loadDoc(tx, id);
    if (d.status !== "WITHDRAWN") throw new AppError("Only a retired document can be restored.", "PRECONDITION");
    await tx.knowledgeDocument.update({ where: { id }, data: { status: "CURRENT", retiredReason: null, updatedAt: now() } });
    await audit(tx, user, "knowledge.restored", id, `Restored “${d.title}” ${d.version} to current`);
  });
}

export async function deleteKnowledgeDraft(db: Db, user: SessionUser, id: string) {
  assertDeveloper(user);
  await db.$transaction(async (tx) => {
    const d = await loadDoc(tx, id);
    if (d.status !== "DRAFT") throw new AppError("Only a draft can be deleted. Retire a published document instead.", "PRECONDITION");
    await tx.knowledgeDocument.delete({ where: { id } });
    await audit(tx, user, "knowledge.draft_deleted", id, `Deleted the draft “${d.title}” ${d.version}`);
  });
}

/** The uploaded original, for the developer to check against the sections. */
export async function readKnowledgeOriginal(db: Db, user: SessionUser, id: string) {
  assertDeveloper(user);
  const d = await loadDoc(db, id);
  if (!d.storageKey || !d.fileName) throw notFoundError("original file");
  return { fileName: d.fileName, buffer: readStoredFile(d.storageKey) };
}

// ───────────────────────────── bulk import of a prepared knowledge base (Markdown with front-matter) ─────────────

/** The small YAML subset the prepared documents use: `key: value`, `key: "value"`, `key: [a, "b"]`, and `- item` lists. */
export function parseFrontMatter(md: string): { meta: Record<string, string | string[]>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(md);
  if (!m) return { meta: {}, body: md };
  const meta: Record<string, string | string[]> = {};
  let listKey: string | null = null;
  const unq = (v: string) => v.trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
  for (const line of m[1]!.split(/\r?\n/)) {
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && listKey) {
      (meta[listKey] as string[]).push(unq(item[1]!));
      continue;
    }
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, k, v] = kv;
    if (!v) {
      meta[k!] = [];
      listKey = k!;
    } else if (/^\[.*\]$/.test(v.trim())) {
      meta[k!] = [...v.trim().slice(1, -1).matchAll(/"([^"]*)"|'([^']*)'|([^,]+)/g)].map((x) => (x[1] ?? x[2] ?? x[3] ?? "").trim()).filter(Boolean);
      listKey = null;
    } else {
      meta[k!] = unq(v);
      listKey = null;
    }
  }
  return { meta, body: md.slice(m[0].length) };
}

const str = (v: string | string[] | undefined) => (Array.isArray(v) ? v.join(", ") : (v ?? ""));

/** Reads one prepared Markdown document into the details and sections the library keeps. */
export function prepareMarkdownDocument(fileName: string, md: string) {
  const { meta, body } = parseFrontMatter(md);
  const title = (str(meta.title) || /^#\s+(.+)$/m.exec(body)?.[1] || fileName.replace(/\.md$/, "")).trim();
  const ids = Array.isArray(meta.document_ids) ? meta.document_ids : meta.document_ids ? [str(meta.document_ids)] : [];
  const dated = ids.map((x) => /dated\s+(\d{2})[./-](\d{2})[./-](\d{4})/i.exec(x)).find(Boolean);
  const source = str(meta.source_file) || fileName.replace(/\.md$/, "");
  const fileType = str(meta.file_type);
  const kind = `${title} ${str(meta.content_type)}`;
  // Training videos and help pages are guides, whatever their descriptions mention.
  const category: KnowledgeCategory = /\.(mp4|mov|avi|html?|png|jpe?g)$/i.test(source)
    ? "OTHER"
    : /\b(BNS|BNSS|BSA|IPC|CrPC|IT Act|Sanhita|Adhiniyam)\b.*\b(Act|section)\b/i.test(title)
    ? "LAW"
    : /circular|SOP|standard operating/i.test(kind)
      ? /circular/i.test(kind) && !/SOP/i.test(title) ? "CIRCULAR" : "SOP"
      : /LEARs?|subscriber information|response analysis|Play Store|Android device/i.test(kind)
        ? "PROVIDER"
        : "OTHER";
  const cautions: string[] = [];
  if (/mp4|video/i.test(fileType) || /machine-translated|whisper/i.test(str(meta.language))) cautions.push("Transcribed from a training video; narration machine-translated and approximate.");
  if (/scanned|image-only|OCR/i.test(fileType)) cautions.push("Transcribed from scanned pages.");
  if (meta.supersedes) cautions.push(`States that it supersedes: ${str(meta.supersedes)}. Check which earlier instructions still apply.`);
  if (cautions.length) cautions.push("Check the issued original before relying on a detail.");
  const tags = (Array.isArray(meta.tags) ? meta.tags : []).map((t) => t.toLowerCase()).slice(0, 40);
  // Sections follow the document's own headings, numbered §1, §2 … in reading order; quotation marks and list
  // markers are kept out of the text.
  const lines = body.split(/\r?\n/).map((text) => ({ text: text.replace(/^\s*>\s?/, "").replace(/^\s*[-*]\s+/, "• ") }));
  const sections = splitIntoSections(lines, { headingsOnly: true })
    .filter((s) => s.text.trim().length >= 20)
    .map((s, i) => ({ ...s, sectionRef: `§${i + 1}`, topics: [s.topics[0] ?? s.heading.toLowerCase(), ...tags] }));
  return {
    meta: {
      title: title.slice(0, 200),
      docNumber: (ids[0]?.replace(/\s+dated.*$/i, "").replace(/\s*\(.*\)$/, "") || source).slice(0, 80),
      issuingBody: (str(meta.issuing_authority) || str(meta.producer) || (/html/i.test(fileType) ? "CrimeOS help centre" : "Telangana Cyber Security Bureau")).slice(0, 160),
      jurisdiction: "Telangana",
      version: dated ? `${dated[1]}.${dated[2]}.${dated[3]}` : "As provided",
      effectiveFrom: dated ? `${dated[3]}-${dated[2]}-${dated[1]}` : str(meta.generated).slice(0, 10) || new Date().toISOString().slice(0, 10),
      category,
      summary: (str(meta.content_type) || title).slice(0, 600).padEnd(10, "."),
      reviewNote: cautions.join(" ").slice(0, 400),
    },
    source,
    sections,
  };
}

/**
 * Imports a folder of prepared Markdown documents as published knowledge (the developer's bulk import). A document
 * already imported unchanged is skipped; a changed one is published as a new version that supersedes the old one.
 * Optionally retires the illustrative library the demonstration starts with.
 */
export async function importKnowledgeFolder(db: Db, user: SessionUser, files: { fileName: string; buffer: Buffer }[], opts: { retireIllustrative?: boolean; resection?: boolean } = {}) {
  assertDeveloper(user);
  const result = { imported: [] as string[], updated: [] as string[], unchanged: [] as string[], skipped: [] as { file: string; why: string }[], retired: [] as string[] };
  for (const f of files.sort((a, b) => a.fileName.localeCompare(b.fileName))) {
    if (!/\.md$/i.test(f.fileName) || /^00\s*-\s*INDEX/i.test(f.fileName)) {
      result.skipped.push({ file: f.fileName, why: /INDEX/i.test(f.fileName) ? "the folder's index, not a document" : "not a Markdown document" });
      continue;
    }
    const p = prepareMarkdownDocument(f.fileName, f.buffer.toString("utf8"));
    if (!p.sections.length) {
      result.skipped.push({ file: f.fileName, why: "no readable sections" });
      continue;
    }
    const meta = parseMeta(p.meta);
    const stored = storeFile(f.buffer, f.fileName, { area: KNOWLEDGE_AREA });
    const previous = await db.knowledgeDocument.findFirst({ where: { fileName: f.fileName, status: { in: ["CURRENT", "DRAFT"] } }, orderBy: { createdAt: "desc" } });
    if (previous?.sha256 === stored.sha256) {
      if (opts.resection && previous.status === "CURRENT") {
        await db.$transaction(async (tx) => {
          await tx.knowledgeSection.deleteMany({ where: { documentId: previous.id } });
          await tx.knowledgeSection.createMany({ data: p.sections.map((s, i) => ({ documentId: previous.id, sectionRef: s.sectionRef, heading: s.heading, text: s.text, topicsJson: JSON.stringify(s.topics), sortOrder: i })) });
          await tx.knowledgeDocument.update({ where: { id: previous.id }, data: { ...metaData(meta), readNote: `Imported from the prepared knowledge base (${p.source}); ${p.sections.length} sections`, updatedAt: now() } });
          await audit(tx, user, "knowledge.resectioned", previous.id, `Re-read “${meta.title}” into ${p.sections.length} sections (same file, unchanged)`);
        });
        result.updated.push(f.fileName);
      } else result.unchanged.push(f.fileName);
      continue;
    }
    const at = now();
    await db.$transaction(async (tx) => {
      const d = await tx.knowledgeDocument.create({
        data: {
          ...metaData(meta),
          status: "CURRENT",
          isSynthetic: false,
          fileName: f.fileName,
          storageKey: stored.storageKey,
          sha256: stored.sha256,
          readNote: `Imported from the prepared knowledge base (${p.source}); ${p.sections.length} sections`,
          replacesId: previous?.status === "CURRENT" ? previous.id : null,
          createdById: user.id,
          publishedById: user.id,
          publishedAt: at,
          createdAt: at,
          updatedAt: at,
          sections: { create: p.sections.map((s, i) => ({ sectionRef: s.sectionRef, heading: s.heading, text: s.text, topicsJson: JSON.stringify(s.topics), sortOrder: i })) },
        },
      });
      if (previous?.status === "CURRENT") {
        await tx.knowledgeDocument.update({ where: { id: previous.id }, data: { status: "SUPERSEDED", supersededById: d.id, updatedAt: at } });
        await audit(tx, user, "knowledge.superseded", previous.id, `“${previous.title}” superseded by the re-imported version`, { by: d.id });
      }
      await audit(tx, user, "knowledge.imported", d.id, `Imported and published “${meta.title}” (${f.fileName}): ${p.sections.length} sections`, { sha256: stored.sha256 });
    });
    (previous ? result.updated : result.imported).push(f.fileName);
  }
  if (opts.retireIllustrative) {
    const illustrative = await db.knowledgeDocument.findMany({ where: { isSynthetic: true, status: "CURRENT" } });
    for (const d of illustrative) {
      await db.$transaction(async (tx) => {
        await tx.knowledgeDocument.update({ where: { id: d.id }, data: { status: "WITHDRAWN", retiredReason: "Illustrative demonstration document, replaced by the station's knowledge base.", updatedAt: now() } });
        await audit(tx, user, "knowledge.retired", d.id, `Retired the illustrative “${d.title}”: replaced by the station's knowledge base`);
      });
      result.retired.push(d.title);
    }
  }
  return result;
}
