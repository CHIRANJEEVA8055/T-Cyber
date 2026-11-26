import path from "node:path";
import type { TextBlock } from "@/domain/knowledge-split";
import { AppError } from "../errors";
import { MAX_UPLOAD_BYTES, validateUpload } from "../storage";
import { parseDocument } from "./parse";
import { readDocxBlocks } from "./docx-read";

export { readDocxBlocks };

/**
 * Reads the text of a document someone uploads to ask about or to add to the knowledge base: PDF text layers, Word
 * (.docx), plain text, Markdown, email (.eml) and CSV. Everything is read on this computer. Nothing in the file is
 * ever executed or followed: its text is data. Scanned PDFs have no text layer and are refused with the reason.
 */

export const READABLE_EXTENSIONS = [".pdf", ".docx", ".txt", ".md", ".eml", ".csv"] as const;

export interface ReadDocument {
  mimeType: string;
  blocks: TextBlock[];
  pageCount: number | null;
  readNote: string;
}

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";


function decodeQuotedPrintable(t: string): string {
  const bytes = t.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
  return Buffer.from(bytes, "latin1").toString("utf8");
}

/** The readable part of an email: its subject, sender and date, then the plain-text body. */
export function readEmailBlocks(raw: string): TextBlock[] {
  const split = raw.search(/\r?\n\r?\n/);
  const head = split >= 0 ? raw.slice(0, split) : raw;
  let body = split >= 0 ? raw.slice(split).replace(/^\s+/, "") : "";
  const header = (name: string) => new RegExp(`^${name}:\\s*(.*(?:\\r?\\n[ \\t].*)*)`, "im").exec(head)?.[1]?.replace(/\r?\n[ \t]+/g, " ").trim() ?? "";
  const type = header("Content-Type");
  const boundary = /boundary="?([^";]+)"?/i.exec(type)?.[1];
  let encoding = header("Content-Transfer-Encoding");
  if (boundary) {
    const parts = body.split(`--${boundary}`);
    const plain = parts.find((p) => /content-type:\s*text\/plain/i.test(p)) ?? parts.find((p) => /content-type:\s*text\//i.test(p)) ?? "";
    const at = plain.search(/\r?\n\r?\n/);
    encoding = /content-transfer-encoding:\s*([\w-]+)/i.exec(plain.slice(0, at))?.[1] ?? "";
    body = at >= 0 ? plain.slice(at).trim() : plain.trim();
  }
  if (/quoted-printable/i.test(encoding)) body = decodeQuotedPrintable(body);
  else if (/base64/i.test(encoding)) body = Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
  if (/text\/html/i.test(type) && !boundary) body = body.replace(/<[^>]+>/g, " ");
  const blocks: TextBlock[] = [];
  for (const [label, name] of [["Subject", "Subject"], ["From", "From"], ["Date", "Date"]] as const) {
    const v = header(name);
    if (v) blocks.push({ text: `${label}: ${v}` });
  }
  blocks.push({ text: "" });
  for (const line of body.split(/\r?\n/)) blocks.push({ text: line });
  return blocks;
}

export async function readTextDocument(fileName: string, buffer: Buffer): Promise<ReadDocument> {
  const ext = path.extname(fileName).toLowerCase();
  if (!(READABLE_EXTENSIONS as readonly string[]).includes(ext)) {
    throw new AppError(`Files of type "${ext || "unknown"}" cannot be read here. Use a PDF, Word (.docx), text (.txt), Markdown (.md), email (.eml) or CSV file.`);
  }
  if (buffer.length === 0) throw new AppError("The file is empty. Choose the document again.");
  if (buffer.length > MAX_UPLOAD_BYTES) throw new AppError(`The file is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB. Upload a smaller copy or split the document.`);
  if (ext === ".md") {
    if (buffer.subarray(0, 4096).includes(0)) throw new AppError("The file is not readable text, so it cannot be read as Markdown.");
    return { mimeType: "text/markdown", blocks: buffer.toString("utf8").split(/\r?\n/).map((text) => ({ text })), pageCount: null, readNote: "Read from the Markdown text" };
  }
  const { mimeType } = validateUpload(fileName, buffer);
  if (mimeType === DOCX) return { mimeType, blocks: readDocxBlocks(buffer), pageCount: null, readNote: "Read from the Word document" };
  if (mimeType === "message/rfc822") return { mimeType, blocks: readEmailBlocks(buffer.toString("utf8")), pageCount: null, readNote: "Read from the email's text" };
  const parsed = await parseDocument(buffer, mimeType);
  if (parsed.status !== "TEXT_EXTRACTED" && parsed.status !== "TABLE_PARSED") throw new AppError(parsed.note ?? "The file's text could not be read.");
  const blocks: TextBlock[] = [];
  let lastPage: number | null = null;
  for (const s of parsed.segments) {
    if (s.page !== lastPage && lastPage !== null) blocks.push({ text: "", page: s.page });
    lastPage = s.page;
    blocks.push({ text: s.text, page: s.page });
  }
  const note =
    mimeType === "application/pdf"
      ? `Read from the PDF's text layer, ${parsed.pageCount} ${parsed.pageCount === 1 ? "page" : "pages"}`
      : mimeType === "text/csv"
        ? `Read from the CSV, ${parsed.segments.length} rows`
        : "Read from the plain text";
  return { mimeType, blocks, pageCount: parsed.pageCount, readNote: note };
}
