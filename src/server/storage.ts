import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AppError } from "./errors";

/**
 * Evidence originals live in STORAGE_DIR (default ./data/storage), which is never served
 * statically. Files are only retrievable through the authorised download route.
 * Storage keys are generated on the server; user-supplied names are never used as paths.
 */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

// Uploaded originals and the configuration file live at runtime-configured paths, not in the build, so these
// calls are excluded from Turbopack's output-file tracing (otherwise the whole project would be traced).
export function storageRoot(): string {
  return path.resolve(/*turbopackIgnore: true*/ process.env.STORAGE_DIR ?? "./data/storage");
}

interface AllowedType {
  ext: string[];
  mime: string;
  magic?: (b: Buffer) => boolean;
  text?: boolean;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const ALLOWED: AllowedType[] = [
  { ext: [".pdf"], mime: "application/pdf", magic: (b) => b.subarray(0, 5).toString("latin1") === "%PDF-" },
  { ext: [".png"], mime: "image/png", magic: (b) => b.subarray(0, 8).equals(PNG_SIGNATURE) },
  { ext: [".jpg", ".jpeg"], mime: "image/jpeg", magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: [".txt"], mime: "text/plain", text: true },
  { ext: [".csv"], mime: "text/csv", text: true },
  { ext: [".eml"], mime: "message/rfc822", text: true },
  {
    ext: [".docx"],
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    magic: (b) => b[0] === 0x50 && b[1] === 0x4b,
  },
  {
    ext: [".xlsx"],
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    magic: (b) => b[0] === 0x50 && b[1] === 0x4b,
  },
];

export const ACCEPTED_EXTENSIONS = ALLOWED.flatMap((a) => a.ext);

function looksLikeText(b: Buffer): boolean {
  const sample = b.subarray(0, 4096);
  for (const byte of sample) if (byte === 0) return false;
  return true;
}

/** Validates name, size and content; returns the canonical MIME type. Throws AppError with an officer-facing message. */
export function validateUpload(fileName: string, buffer: Buffer): { mimeType: string } {
  if (buffer.length === 0) throw new AppError("The file is empty. Choose the original document and upload it again.");
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw new AppError(`The file is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB. Upload a smaller copy or split the document.`);
  }
  const ext = path.extname(fileName).toLowerCase();
  const type = ALLOWED.find((a) => a.ext.includes(ext));
  if (!type) {
    throw new AppError(
      `Files of type "${ext || "unknown"}" are not accepted. Accepted types: PDF, CSV, TXT, EML, PNG, JPG, DOCX, XLSX.`,
    );
  }
  if (type.magic && !type.magic(buffer)) {
    throw new AppError(`The file content does not match its ${ext} extension. Check that this is the original file.`);
  }
  if (type.text && !looksLikeText(buffer)) {
    throw new AppError(`The file is not readable text, so it cannot be stored as ${ext}.`);
  }
  return { mimeType: type.mime };
}

export function sha256(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

export function resolveStoragePath(storageKey: string): string {
  const root = storageRoot();
  const full = path.resolve(root, storageKey);
  if (!full.startsWith(root + path.sep)) throw new AppError("Invalid storage location.", "FORBIDDEN");
  return full;
}

/** Knowledge-base originals live in their own folder, which a demonstration-data reset leaves alone. */
export const KNOWLEDGE_AREA = "knowledge";

export function storeFile(buffer: Buffer, fileName: string, opts: { area?: typeof KNOWLEDGE_AREA } = {}): { storageKey: string; sha256: string; sizeBytes: number } {
  const ext = path.extname(fileName).toLowerCase().replace(/[^.a-z0-9]/g, "");
  const now = new Date();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const key = `${opts.area ? `${opts.area}/` : ""}${now.getUTCFullYear()}/${month}/${crypto.randomUUID()}${ext}`;
  const full = resolveStoragePath(key);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, buffer, { mode: 0o600, flag: "wx" });
  return { storageKey: key, sha256: sha256(buffer), sizeBytes: buffer.length };
}

export function readStoredFile(storageKey: string): Buffer {
  return fs.readFileSync(/*turbopackIgnore: true*/ resolveStoragePath(storageKey));
}
