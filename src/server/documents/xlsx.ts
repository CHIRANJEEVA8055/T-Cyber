import { readZip } from "./zip";

/**
 * Reads the cell text of an Excel workbook (.xlsx): each sheet's rows as arrays of strings, in column order. Shared
 * strings, inline strings and plain numbers are read; formulas give their cached value. Nothing is evaluated.
 */
const dec = (t: string) =>
  t
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");

const colIndex = (ref: string) => [...ref].reduce((n, c) => n * 26 + (c.charCodeAt(0) - 64), 0) - 1;

/** Number formats that show a date: the built-in ones (14–22, 45–47) and custom codes with day, month or year parts. */
function dateStyles(stylesXml: string): Set<number> {
  const custom = new Map<number, string>();
  for (const m of stylesXml.matchAll(/<numFmt\b[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g)) custom.set(Number(m[1]), dec(m[2]!));
  const isDate = (id: number) => {
    if ((id >= 14 && id <= 22) || (id >= 45 && id <= 47)) return true;
    const code = (custom.get(id) ?? "").replace(/"[^"]*"|\[[^\]]*\]|\\./g, "");
    return /[dy]/i.test(code) || (/m/i.test(code) && /[hs]/i.test(code) === false && /[dy]/i.test(code));
  };
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml)?.[1] ?? "";
  const out = new Set<number>();
  [...xfs.matchAll(/<xf\b([^>]*)\/?>/g)].forEach((m, i) => {
    const id = Number(/numFmtId="(\d+)"/.exec(m[1]!)?.[1] ?? "0");
    if (isDate(id)) out.add(i);
  });
  return out;
}

/** An Excel date serial (days since 30 Dec 1899) as the wall-clock text it shows: "03-10-2026" or "03-10-2026 14:02:11". */
function serialDate(serial: number): string {
  const ms = Math.round((serial - 25569) * 86400) * 1000;
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  const date = `${p(d.getUTCDate())}-${p(d.getUTCMonth() + 1)}-${d.getUTCFullYear()}`;
  return serial % 1 === 0 ? date : `${date} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

export function readXlsx(buffer: Buffer): { name: string; rows: string[][] }[] {
  const files = readZip(buffer);
  const file = (n: string) => files.find((f) => f.name === n)?.data.toString("utf8") ?? "";
  const dates = dateStyles(file("xl/styles.xml"));
  const strings = [...file("xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => dec([...m[1]!.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join("")));
  const rels = file("xl/_rels/workbook.xml.rels");
  const target = (rid: string) => new RegExp(`Id="${rid}"[^>]*Target="([^"]+)"|Target="([^"]+)"[^>]*Id="${rid}"`).exec(rels);
  const sheets: { name: string; rows: string[][] }[] = [];
  for (const m of file("xl/workbook.xml").matchAll(/<sheet [^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)) {
    const t = target(m[2]!);
    const path = `xl/${(t?.[1] ?? t?.[2] ?? "").replace(/^\/?xl\//, "")}`;
    const xml = file(path);
    const rows: string[][] = [];
    for (const r of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const row: string[] = [];
      for (const c of r[1]!.matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[2]!;
        const inner = c[3] ?? "";
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        const style = Number(/\bs="(\d+)"/.exec(attrs)?.[1] ?? "-1");
        const text = /t="s"/.test(attrs)
          ? (strings[Number(v)] ?? "")
          : /t="inlineStr"/.test(attrs)
            ? dec([...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join(""))
            : v !== undefined && dates.has(style) && /^\d+(\.\d+)?$/.test(v) && Number(v) > 0
              ? serialDate(Number(v))
              : dec(v ?? "");
        row[colIndex(c[1]!)] = text;
      }
      rows.push(Array.from(row, (x) => x ?? ""));
    }
    sheets.push({ name: dec(m[1]!), rows });
  }
  return sheets;
}
