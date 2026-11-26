import { buildZip } from "./zip";

/**
 * A small Word (.docx) writer for documents the assistant prepares: titles, headings, paragraphs, bullet points,
 * quotations and small print. It writes the minimum WordprocessingML that Word, LibreOffice and Google Docs open.
 * Text is escaped; nothing in it is interpreted.
 */

export type DocBlock = {
  kind: "title" | "heading" | "subheading" | "para" | "bullet" | "quote" | "small";
  text: string;
  /** Letters: centred letterhead lines, a right-aligned date. */
  align?: "center" | "right" | "both";
  bold?: boolean;
  /** Font size in points. */
  size?: number;
  /** Text colour as hex ("B42318"). */
  color?: string;
  /** Left indent in points. */
  indent?: number;
};

const esc = (t: string) =>
  t
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // Characters XML 1.0 does not allow are dropped.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");

const STYLE: Record<DocBlock["kind"], string | null> = { title: "Title", heading: "Heading1", subheading: "Heading2", para: null, bullet: "ListBullet", quote: "Quote", small: "Small" };

function paragraph(b: DocBlock): string {
  const style = STYLE[b.kind];
  const pProps = [style ? `<w:pStyle w:val="${style}"/>` : "", b.indent ? `<w:ind w:left="${Math.round(b.indent * 20)}"/>` : "", b.align ? `<w:jc w:val="${b.align}"/>` : ""].join("");
  const pPr = pProps ? `<w:pPr>${pProps}</w:pPr>` : "";
  const rProps = [b.bold ? "<w:b/>" : "", b.color ? `<w:color w:val="${b.color.replace(/[^0-9a-f]/gi, "").slice(0, 6)}"/>` : "", b.size ? `<w:sz w:val="${Math.round(b.size * 2)}"/>` : ""].join("");
  const rPr = rProps ? `<w:rPr>${rProps}</w:rPr>` : "";
  const runs = b.text
    .split("\n")
    .map((line, i) => `${i ? `<w:r>${rPr}<w:br/></w:r>` : ""}<w:r>${rPr}<w:t xml:space="preserve">${esc(b.kind === "bullet" ? `• ${line}` : line)}</w:t></w:r>`)
    .join("");
  return `<w:p>${pPr}${runs}</w:p>`;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="160" w:after="60"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListBullet"><w:name w:val="List Bullet"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="360" w:hanging="240"/><w:spacing w:after="60"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="480"/></w:pPr><w:rPr><w:i/><w:color w:val="444444"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Small"><w:name w:val="Small"/><w:basedOn w:val="Normal"/><w:rPr><w:sz w:val="18"/><w:color w:val="555555"/></w:rPr></w:style>
</w:styles>`;

export function buildDocx(blocks: DocBlock[], meta: { title: string; author: string; created: Date }): Buffer {
  const body = blocks.map(paragraph).join("");
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const iso = meta.created.toISOString().replace(/\.\d{3}Z$/, "Z");
  const now = meta.created;
  const files = [
    {
      name: "[Content_Types].xml",
      text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`,
    },
    {
      name: "_rels/.rels",
      text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`,
    },
    {
      name: "word/_rels/document.xml.rels",
      text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    },
    { name: "word/document.xml", text: document },
    { name: "word/styles.xml", text: STYLES },
    {
      name: "docProps/core.xml",
      text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(meta.title)}</dc:title><dc:creator>${esc(meta.author)}</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${iso}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${iso}</dcterms:modified></cp:coreProperties>`,
    },
  ];
  return buildZip(files.map((f) => ({ name: f.name, data: Buffer.from(f.text, "utf8"), modified: now })));
}
