import { extractFromLines, extractFromTable, parseCsv } from "@/domain/extraction";
import { now } from "../clock";
import type { Db, Tx } from "../db";
import type { SessionUser } from "../auth/session";
import { loadCaseForUser } from "../auth/access";
import { recordAudit } from "../audit";
import { AppError, notFoundError } from "../errors";
import { parseDocument, type ParsedDocument } from "../documents/parse";
import { readStoredFile, storeFile, validateUpload } from "../storage";

export const EVIDENCE_CATEGORIES = [
  "FIR_COPY",
  "COMPLAINT",
  "TRANSACTION_RECORD",
  "BANK_RESPONSE",
  "TELECOM_RESPONSE",
  "PROVIDER_RESPONSE",
  "EMAIL_MESSAGE",
  "SCREENSHOT",
  "OTHER",
] as const;

export interface EvidenceUpload {
  fileName: string;
  buffer: Buffer;
  title?: string;
  category: string;
  sourceDescription: string;
  receivedAt: Date;
  responseId?: string | null;
  parentId?: string | null;
  derivation?: string;
  isSynthetic?: boolean;
}

export interface PreparedEvidence {
  upload: EvidenceUpload;
  mimeType: string;
  storageKey: string;
  sha256: string;
  sizeBytes: number;
  parsed: ParsedDocument;
}

/** Validates, stores and parses an original. Runs outside any DB transaction. */
export async function prepareEvidence(upload: EvidenceUpload): Promise<PreparedEvidence> {
  const { mimeType } = validateUpload(upload.fileName, upload.buffer);
  const stored = storeFile(upload.buffer, upload.fileName);
  const parsed = await parseDocument(upload.buffer, mimeType);
  return { upload, mimeType, ...stored, parsed };
}

export async function insertEvidenceTx(tx: Tx, actorId: string, caseId: string, p: PreparedEvidence) {
  const u = p.upload;
  if (!(EVIDENCE_CATEGORIES as readonly string[]).includes(u.category)) throw new AppError("Choose an evidence category.", "VALIDATION", { category: "Choose a category." });
  const item = await tx.evidenceItem.create({
    data: {
      caseId,
      title: (u.title ?? u.fileName).trim().slice(0, 200),
      category: u.category,
      derivation: u.derivation ?? "ORIGINAL",
      parentId: u.parentId ?? null,
      fileName: u.fileName.slice(0, 200),
      mimeType: p.mimeType,
      sizeBytes: p.sizeBytes,
      sha256: p.sha256,
      storageKey: p.storageKey,
      pageCount: p.parsed.pageCount,
      sourceDescription: u.sourceDescription.trim() || "Not stated",
      receivedAt: u.receivedAt,
      uploadedById: actorId,
      uploadedAt: now(),
      responseId: u.responseId ?? null,
      processingStatus: p.parsed.status,
      processingNote: p.parsed.note,
      isSynthetic: u.isSynthetic ?? false,
    },
  });
  if (p.parsed.segments.length > 0) {
    await tx.evidenceSegment.createMany({
      data: p.parsed.segments.map((s) => ({ evidenceId: item.id, caseId, page: s.page, row: s.row, line: s.line, text: s.text, method: s.method })),
    });
  }
  const parseOutcome = ["TEXT_EXTRACTED", "TABLE_PARSED"].includes(p.parsed.status) ? "OK" : p.parsed.status === "FAILED" ? "FAILED" : "WARNING";
  const at = now();
  await tx.processingEvent.createMany({
    data: [
      { at, evidenceId: item.id, step: "RECEIVED", outcome: "OK", detail: `Received ${u.fileName} (${p.mimeType}, ${p.sizeBytes} bytes). Source: ${u.sourceDescription}`, actorId },
      { at, evidenceId: item.id, step: "HASHED", outcome: "OK", detail: `SHA-256 computed on the original bytes: ${p.sha256}` },
      { at, evidenceId: item.id, step: "STORED", outcome: "OK", detail: "Original stored outside the public web root; available only through authorised download." },
      {
        at,
        evidenceId: item.id,
        step: "PARSED",
        outcome: parseOutcome,
        detail:
          p.parsed.status === "TEXT_EXTRACTED"
            ? `Text extracted: ${p.parsed.segments.length} lines${p.parsed.pageCount ? ` across ${p.parsed.pageCount} page(s)` : ""}.`
            : p.parsed.status === "TABLE_PARSED"
              ? `Table parsed: ${p.parsed.segments.length} rows including the header.`
              : (p.parsed.note ?? p.parsed.status),
      },
    ],
  });
  return item;
}

/** Runs RULES_V1 on a stored original. Never invents candidates for unsupported or empty documents. */
export async function runExtractionTx(tx: Tx, actorId: string | null, evidenceId: string) {
  const ev = await tx.evidenceItem.findUniqueOrThrow({ where: { id: evidenceId } });
  const unsupported = !["TEXT_EXTRACTED", "TABLE_PARSED"].includes(ev.processingStatus);
  let candidates: ReturnType<typeof extractFromLines> = [];
  let note: string | null = null;
  if (unsupported) {
    note = ev.processingNote ?? "This document type is not supported for extraction.";
  } else if (ev.processingStatus === "TABLE_PARSED") {
    const table = extractFromTable(parseCsv(readStoredFile(ev.storageKey).toString("utf8")));
    candidates = table.candidates;
    note = table.note;
  } else {
    const segments = await tx.evidenceSegment.findMany({ where: { evidenceId }, orderBy: [{ page: "asc" }, { line: "asc" }] });
    candidates = extractFromLines(segments.map((s) => ({ page: s.page, line: s.line, row: s.row, text: s.text })));
  }
  const status = unsupported ? "NOT_SUPPORTED" : candidates.length === 0 ? "NOTHING_FOUND" : "COMPLETED";
  const run = await tx.extractionRun.create({
    data: {
      caseId: ev.caseId,
      evidenceId,
      method: "RULES_V1",
      createdAt: now(),
      status,
      note: note ?? (status === "NOTHING_FOUND" ? "No identifiers, amounts or references were recognised. Review the document manually." : null),
      createdById: actorId,
    },
  });
  if (candidates.length > 0) {
    await tx.extractionCandidate.createMany({
      data: candidates.map((c) => ({
        caseId: ev.caseId,
        runId: run.id,
        evidenceId,
        field: c.field,
        originalValue: c.originalValue,
        normalizedValue: c.normalizedValue,
        structuredJson: c.structured ? JSON.stringify(c.structured) : null,
        roleHint: c.roleHint,
        roleHintBasis: c.roleHintBasis,
        uncertainty: c.uncertainty,
        uncertaintyNote: c.uncertaintyNote,
        page: c.page,
        row: c.row,
        line: c.line,
        charStart: c.charStart,
        charEnd: c.charEnd,
        excerpt: c.excerpt,
      })),
    });
  }
  await tx.processingEvent.create({
    data: {
      at: now(),
      evidenceId,
      step: "EXTRACTION_RUN",
      outcome: status === "COMPLETED" ? "OK" : "WARNING",
      detail:
        status === "COMPLETED"
          ? `Rule-based extraction (RULES_V1) proposed ${candidates.length} candidates for officer review.`
          : status === "NOTHING_FOUND"
            ? "Rule-based extraction found nothing to propose."
            : `Extraction not run: ${note}`,
      actorId,
    },
  });
  if (candidates.length > 0) {
    await tx.evidenceItem.update({ where: { id: evidenceId }, data: { reviewStatus: "IN_REVIEW" } });
  }
  return run;
}

/** UI entry point: authorised upload of a new original to a case. */
export async function uploadEvidence(db: Db, user: SessionUser, caseId: string, upload: EvidenceUpload, opts: { runExtraction: boolean }) {
  await loadCaseForUser(db, user, caseId, "write");
  const prepared = await prepareEvidence(upload);
  return db.$transaction(async (tx) => {
    await loadCaseForUser(tx, user, caseId, "write");
    const item = await insertEvidenceTx(tx, user.id, caseId, prepared);
    if (opts.runExtraction) await runExtractionTx(tx, user.id, item.id);
    await recordAudit(tx, {
      caseId,
      actorId: user.id,
      action: "evidence.uploaded",
      objectType: "EvidenceItem",
      objectId: item.id,
      summary: `Evidence added: ${item.title} (${item.processingStatus.replace(/_/g, " ").toLowerCase()})`,
      detail: { sha256: item.sha256, sizeBytes: item.sizeBytes },
    });
    return item;
  });
}

export async function getEvidenceForDownload(db: Db, user: SessionUser, evidenceId: string) {
  const ev = await db.evidenceItem.findUnique({ where: { id: evidenceId } });
  if (!ev) throw notFoundError("evidence item");
  await loadCaseForUser(db, user, ev.caseId, "read");
  return ev;
}
