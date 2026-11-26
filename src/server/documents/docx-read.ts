import type { TextBlock } from "@/domain/knowledge-split";
import { AppError } from "../errors";
import { readZip } from "./zip";

/** Reads a Word (.docx) file's paragraphs. Kept apart from read-text.ts so the document parser can use it too. */
function decodeXml(t: string): string {
  return t
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}

/** Word paragraphs in order, with heading levels from the paragraph style (Heading 1-6, Title). */
export function readDocxBlocks(buffer: Buffer): TextBlock[] {
  let entries: { name: string; data: Buffer }[];
  try {
    entries = readZip(buffer);
  } catch {
    throw new AppError("This Word file could not be opened. It may be damaged or saved in an older format. Save it again as .docx, or as PDF, and upload that.");
  }
  const body = entries.find((e) => e.name === "word/document.xml");
  if (!body) throw new AppError("This file has no Word document body. Save it again as .docx, or as PDF, and upload that.");
  const xml = body.data.toString("utf8");
  const blocks: TextBlock[] = [];
  for (const m of xml.matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)) {
    const p = m[0];
    const style = /<w:pStyle w:val="([^"]+)"/.exec(p)?.[1] ?? "";
    const level = /^heading\s?([1-6])$/i.exec(style)?.[1] ?? (/^title$/i.test(style) ? "1" : null);
    let text = "";
    for (const r of p.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\/>/g)) text += r[1] !== undefined ? r[1] : r[0].startsWith("<w:tab") ? " " : "\n";
    text = decodeXml(text);
    for (const line of text.split("\n")) if (line.trim()) blocks.push({ text: line, headingLevel: level ? Number(level) : null });
    blocks.push({ text: "" });
  }
  return blocks;
}
