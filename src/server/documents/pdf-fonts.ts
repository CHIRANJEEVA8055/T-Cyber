import { inflateSync } from "node:zlib";

/**
 * Repairs the text layer of PDFs whose fonts leave some glyphs without a character, so the text reads as printed.
 *
 * FIR copies printed from the CCTNS web page with a browser's "Save as PDF" embed Roboto, Arial and Times subsets
 * whose ToUnicode maps give some glyphs no character (U+0000): Roboto's alternate digit forms in particular. Every
 * text extractor then drops those digits ("FIR No. 436/2026" for 1436, "30- 0-2026" for 30-10-2026). The glyphs
 * themselves are intact, so each unmapped glyph is identified by its outline: compared, after normalising size and
 * position, with glyphs whose character is known (in the same document, or the reference outlines kept here for
 * the fonts these copies use). Only a close match is accepted; anything uncertain is left unmapped and reported, never
 * guessed. The corrected maps are written as a standard PDF incremental update, so the original bytes are untouched.
 */

// ───────────────────────────── a small PDF object reader (classic xref tables and object streams) ─────────────────

type PdfObj = { num: number; start: number; end: number; body: string };

function findObjects(buf: Buffer): Map<number, PdfObj> {
  const s = buf.toString("latin1");
  const objs = new Map<number, PdfObj>();
  const re = /(?:^|[\r\n\s])(\d+)\s+(\d+)\s+obj\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const num = Number(m[1]);
    const start = m.index + m[0].length;
    const end = s.indexOf("endobj", start);
    if (end < 0) break;
    // The last definition wins, as in an incremental update.
    objs.set(num, { num, start, end, body: s.slice(start, Math.min(end, start + 4000)) });
    re.lastIndex = end;
  }
  return objs;
}

function streamData(buf: Buffer, objs: Map<number, PdfObj>, num: number): Buffer | null {
  const o = objs.get(num);
  if (!o) return null;
  const s = buf.toString("latin1", o.start, o.end);
  const si = s.search(/\bstream\r?\n/);
  if (si < 0) return null;
  const dict = s.slice(0, si);
  let p = o.start + si + 6;
  if (buf[p] === 0x0d) p++;
  if (buf[p] === 0x0a) p++;
  const lm = /\/Length\s+(\d+)(\s+\d+\s+R)?/.exec(dict);
  let len = lm ? Number(lm[1]) : -1;
  if (lm?.[2]) len = Number(/^\s*(\d+)/.exec(objs.get(len)?.body ?? "")?.[1] ?? -1);
  if (len < 0) len = buf.indexOf("endstream", p) - p;
  const raw = buf.subarray(p, p + len);
  if (/\/FlateDecode/.test(dict)) {
    try {
      return inflateSync(raw);
    } catch {
      return null;
    }
  }
  return /\/Filter/.test(dict) ? null : raw;
}

const ref = (dict: string, key: string) => {
  const m = new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R`).exec(dict);
  return m ? Number(m[1]) : null;
};

// ───────────────────────────── TrueType outlines ───────────────────────────────────────────────────────────────

type Pt = [number, number];
type Outline = Pt[][];

function ttTables(f: Buffer): Map<string, { off: number; len: number }> {
  const t = new Map<string, { off: number; len: number }>();
  const n = f.readUInt16BE(4);
  for (let i = 0; i < n; i++) {
    const r = 12 + i * 16;
    t.set(f.toString("latin1", r, r + 4), { off: f.readUInt32BE(r + 8), len: f.readUInt32BE(r + 12) });
  }
  return t;
}

/** Glyph id → outline (simple glyphs; composite glyphs are flattened one level). */
export function readOutlines(f: Buffer): { unitsPerEm: number; numGlyphs: number; glyph: (gid: number) => Outline | null; advance: (gid: number) => number } {
  const t = ttTables(f);
  const hhea = t.get("hhea"),
    hmtx = t.get("hmtx");
  const nMetrics = hhea ? f.readUInt16BE(hhea.off + 34) : 0;
  const advance = (gid: number) => (hmtx && nMetrics ? f.readUInt16BE(hmtx.off + Math.min(gid, nMetrics - 1) * 4) : 0);
  const head = t.get("head"),
    loca = t.get("loca"),
    glyf = t.get("glyf"),
    maxp = t.get("maxp");
  if (!head || !loca || !glyf || !maxp) return { unitsPerEm: 1000, numGlyphs: 0, glyph: () => null, advance };
  const unitsPerEm = f.readUInt16BE(head.off + 18);
  const longLoca = f.readInt16BE(head.off + 50) === 1;
  const numGlyphs = f.readUInt16BE(maxp.off + 4);
  const at = (g: number) => (longLoca ? f.readUInt32BE(loca.off + g * 4) : f.readUInt16BE(loca.off + g * 2) * 2);
  const glyph = (gid: number, depth = 0): Outline | null => {
    if (gid < 0 || gid >= numGlyphs || depth > 2) return null;
    const a = at(gid),
      b = at(gid + 1);
    if (b <= a) return null;
    let p = glyf.off + a;
    const nc = f.readInt16BE(p);
    p += 10;
    if (nc < 0) {
      // Composite: its parts, offset by their x/y arguments.
      const out: Outline = [];
      for (let more = true; more; ) {
        const flags = f.readUInt16BE(p);
        const sub = f.readUInt16BE(p + 2);
        p += 4;
        let dx = 0,
          dy = 0;
        if (flags & 1) {
          dx = f.readInt16BE(p);
          dy = f.readInt16BE(p + 2);
          p += 4;
        } else {
          dx = f.readInt8(p);
          dy = f.readInt8(p + 1);
          p += 2;
        }
        if (flags & 8) p += 2;
        else if (flags & 0x40) p += 4;
        else if (flags & 0x80) p += 8;
        for (const c of glyph(sub, depth + 1) ?? []) out.push(c.map(([x, y]) => [x + dx, y + dy] as Pt));
        more = !!(flags & 0x20);
      }
      return out;
    }
    const ends: number[] = [];
    for (let i = 0; i < nc; i++) ends.push(f.readUInt16BE(p + i * 2));
    p += nc * 2;
    const nPts = nc ? ends[nc - 1]! + 1 : 0;
    p += 2 + f.readUInt16BE(p);
    const flags: number[] = [];
    while (flags.length < nPts) {
      const fl = f[p++]!;
      flags.push(fl);
      if (fl & 8) {
        const r = f[p++]!;
        for (let i = 0; i < r; i++) flags.push(fl);
      }
    }
    const xs: number[] = [],
      ys: number[] = [];
    let v = 0;
    for (const fl of flags) {
      if (fl & 2) v += fl & 16 ? f[p++]! : -f[p++]!;
      else if (!(fl & 16)) {
        v += f.readInt16BE(p);
        p += 2;
      }
      xs.push(v);
    }
    v = 0;
    for (const fl of flags) {
      if (fl & 4) v += fl & 32 ? f[p++]! : -f[p++]!;
      else if (!(fl & 32)) {
        v += f.readInt16BE(p);
        p += 2;
      }
      ys.push(v);
    }
    const out: Outline = [];
    let s0 = 0;
    for (const e of ends) {
      out.push(xs.slice(s0, e + 1).map((x, i) => [x, ys[s0 + i]!] as Pt));
      s0 = e + 1;
    }
    return out;
  };
  return { unitsPerEm, numGlyphs, glyph, advance };
}

/** A glyph's shape, independent of size and position: a filled 24×32 grid, its proportions, and its holes. */
export interface Shape {
  grid: Uint8Array;
  aspect: number;
  contours: number;
  /** Bounding boxes of the inner contours (holes), as fractions of the glyph's box, top to bottom. */
  holes: [number, number, number, number][];
}

const area = (c: Pt[]) => {
  let a = 0;
  for (let i = 0, j = c.length - 1; i < c.length; j = i++) a += (c[j]![0] + c[i]![0]) * (c[j]![1] - c[i]![1]);
  return a / 2;
};

export function shapeOf(o: Outline): Shape | null {
  const contours = o.filter((c) => c.length >= 3);
  const pts = contours.flat();
  if (pts.length < 3) return null;
  const minX = Math.min(...pts.map((p) => p[0])),
    maxX = Math.max(...pts.map((p) => p[0]));
  const minY = Math.min(...pts.map((p) => p[1])),
    maxY = Math.max(...pts.map((p) => p[1]));
  const w = maxX - minX || 1,
    h = maxY - minY || 1;
  const W = 24,
    H = 32;
  const grid = new Uint8Array(W * H);
  for (let gy = 0; gy < H; gy++) {
    const y = maxY - ((gy + 0.5) / H) * h;
    for (let gx = 0; gx < W; gx++) {
      const x = minX + ((gx + 0.5) / W) * w;
      let inside = false;
      for (const c of contours) {
        for (let i = 0, j = c.length - 1; i < c.length; j = i++) {
          const [xi, yi] = c[i]!,
            [xj, yj] = c[j]!;
          if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-9) + xi) inside = !inside;
        }
      }
      grid[gy * W + gx] = inside ? 1 : 0;
    }
  }
  // A hole winds the other way from the outer contour it sits in.
  const outerSign = Math.sign(area(contours.reduce((a, b) => (Math.abs(area(b)) > Math.abs(area(a)) ? b : a))));
  const holes = contours
    .filter((c) => Math.sign(area(c)) !== outerSign && Math.abs(area(c)) > w * h * 0.004)
    .map((c) => {
      const xs = c.map((p) => p[0]),
        ys = c.map((p) => p[1]);
      return [(Math.min(...xs) - minX) / w, (maxY - Math.max(...ys)) / h, (Math.max(...xs) - minX) / w, (maxY - Math.min(...ys)) / h] as [number, number, number, number];
    })
    .sort((a, b) => a[1] - b[1]);
  return { grid, aspect: w / h, contours: contours.length, holes };
}

/** How unlike two shapes are (0 = identical). Infinity when their holes differ in number: no digit gains or loses a hole. */
export function unlike(a: Shape, b: Shape): number {
  if (a.holes.length !== b.holes.length) return Infinity;
  let cells = 0;
  for (let i = 0; i < a.grid.length; i++) if (a.grid[i] !== b.grid[i]) cells++;
  let holes = 0;
  a.holes.forEach((ha, i) => {
    const hb = b.holes[i]!;
    holes += (Math.abs(ha[0] - hb[0]) + Math.abs(ha[1] - hb[1]) + Math.abs(ha[2] - hb[2]) + Math.abs(ha[3] - hb[3])) / 4;
  });
  return cells / a.grid.length + 0.25 * Math.abs(Math.log(a.aspect / b.aspect)) + 0.5 * holes;
}

/** Two outlines placed side by side, as a ligature draws them. */
function joined(parts: { o: Outline; adv: number }[]): Outline {
  const out: Outline = [];
  let x = 0;
  for (const p of parts) {
    for (const c of p.o) out.push(c.map(([px, py]) => [px + x, py] as Pt));
    x += p.adv;
  }
  return out;
}

// ───────────────────────────── ToUnicode maps ──────────────────────────────────────────────────────────────────

function parseToUnicode(cmap: string): Map<number, string> {
  const map = new Map<number, string>();
  const hexStr = (h: string) => {
    let out = "";
    for (let i = 0; i + 4 <= h.length; i += 4) out += String.fromCharCode(parseInt(h.slice(i, i + 4), 16));
    return out;
  };
  for (const b of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) for (const e of b[1]!.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g)) map.set(parseInt(e[1]!, 16), hexStr(e[2]!));
  for (const b of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const e of b[1]!.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<([0-9A-Fa-f]*)>|\[([^\]]*)\])/g)) {
      const lo = parseInt(e[1]!, 16),
        hi = parseInt(e[2]!, 16);
      if (e[4] !== undefined) {
        const base = hexStr(e[4]!);
        for (let c = lo; c <= hi && c - lo < 65536; c++) map.set(c, base ? base.slice(0, -1) + String.fromCharCode(base.charCodeAt(base.length - 1) + (c - lo)) : "");
      } else {
        const items = [...e[5]!.matchAll(/<([0-9A-Fa-f]*)>/g)].map((x) => hexStr(x[1]!));
        items.forEach((u, i) => map.set(lo + i, u));
      }
    }
  }
  return map;
}

function writeToUnicode(map: Map<number, string>): string {
  const hex = (n: number) => n.toString(16).toUpperCase().padStart(4, "0");
  const entries = [...map.entries()].filter(([, u]) => u).sort((a, b) => a[0] - b[0]);
  const chunks: string[] = [];
  for (let i = 0; i < entries.length; i += 100) {
    const part = entries.slice(i, i + 100);
    chunks.push(`${part.length} beginbfchar\n${part.map(([c, u]) => `<${hex(c)}> <${[...u].map((ch) => hex(ch.charCodeAt(0))).join("")}>`).join("\n")}\nendbfchar`);
  }
  return `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n${chunks.join("\n")}\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`;
}

// ───────────────────────────── identifying glyphs ─────────────────────────────────────────────────────────────

/** Glyphs the font program holds an outline for that the ToUnicode map does not list at all. */
function missingCodes(f: { map: Map<number, string>; outlines: ReturnType<typeof readOutlines> }): number[] {
  const out: number[] = [];
  for (let g = 1; g < Math.min(f.outlines.numGlyphs, 65535); g++) if (!f.map.has(g) && f.outlines.glyph(g)) out.push(g);
  return out;
}

/** A glyph's grid as text, for checking a match by eye. */
export function asciiGlyph(grid: Uint8Array): string {
  const rows: string[] = [];
  for (let y = 0; y < 32; y += 2) {
    let r = "";
    for (let x = 0; x < 24; x++) r += grid[y * 24 + x] || grid[(y + 1) * 24 + x] ? "#" : ".";
    rows.push(r);
  }
  return rows.join("\n");
}

/** Accept a match only when it is close and clearly closer than the next-best character. */
const MAX_UNLIKE = 0.2;
const MIN_LEAD = 0.05;
const LIGATURES = ["fi", "fl", "ff", "ffi", "ffl"];

export interface FontRepairReport {
  fonts: number;
  unmapped: number;
  repaired: { font: string; code: number; char: string; difference: number }[];
  unresolved: { font: string; code: number }[];
}

type Ref = { char: string; shape: Shape; family: string; ligature: boolean };

function rankFor(shape: Shape, family: string, refs: Ref[]) {
  const best = new Map<string, number>();
  for (const r of refs) {
    // A ligature is compared on its picture only: its parts may merge or keep their own holes.
    const d = r.ligature ? unlikeLoose(shape, r.shape) : unlike(shape, r.shape) - (r.family === family ? 0.01 : 0);
    if (d < (best.get(r.char) ?? Infinity)) best.set(r.char, d);
  }
  return [...best.entries()].sort((a, b) => a[1] - b[1]);
}

/** The character for a glyph, from how it ranks against the references; null when it is not clear. */
function decide(ranked: [string, number][]): string | null {
  const [c1, d1] = ranked[0] ?? ["", Infinity];
  const d2 = ranked[1]?.[1] ?? Infinity;
  if (d1 > MAX_UNLIKE) return null;
  if (d2 - d1 >= MIN_LEAD) return c1;
  // Ligatures differ from each other only at the top of a stroke ("fi" and "fl"): a smaller lead is enough there,
  // as long as nothing that is not a ligature comes close.
  const isLig = (c: string) => LIGATURES.includes(c);
  if (isLig(c1) && isLig(ranked[1]?.[0] ?? "") && d1 <= 0.12 && d2 - d1 >= 0.012) {
    const nextOther = ranked.find(([c]) => !isLig(c))?.[1] ?? Infinity;
    if (nextOther - d1 >= 0.1) return c1;
  }
  return null;
}

function unlikeLoose(a: Shape, b: Shape): number {
  let cells = 0;
  for (let i = 0; i < a.grid.length; i++) if (a.grid[i] !== b.grid[i]) cells++;
  return cells / a.grid.length + 0.25 * Math.abs(Math.log(a.aspect / b.aspect));
}

/**
 * Finds glyphs that the PDF's ToUnicode maps give no character (or leave out) and identifies them by shape against
 * the glyphs in the same document whose characters are known. Returns the repaired PDF (an incremental update) or
 * null when there is nothing to repair.
 */
export function repairPdfText(pdf: Buffer, debug?: (line: string) => void): { pdf: Buffer | null; report: FontRepairReport } {
  const report: FontRepairReport = { fonts: 0, unmapped: 0, repaired: [], unresolved: [] };
  let objs: Map<number, PdfObj>;
  try {
    objs = findObjects(pdf);
  } catch {
    return { pdf: null, report };
  }
  type F = { num: number; base: string; family: string; toUnicodeNum: number; map: Map<number, string>; outlines: ReturnType<typeof readOutlines> };
  const fonts: F[] = [];
  for (const o of objs.values()) {
    if (!/\/Subtype\s*\/Type0/.test(o.body)) continue;
    const base = /\/BaseFont\s*\/([^\s/<>[\]]+)/.exec(o.body)?.[1] ?? "";
    const tu = ref(o.body, "ToUnicode");
    const desc = /\/DescendantFonts\s*\[\s*(\d+)\s+\d+\s+R/.exec(o.body)?.[1];
    if (tu === null || !desc) continue;
    const cid = objs.get(Number(desc));
    if (!cid || !/\/CIDFontType2/.test(cid.body)) continue;
    // Only Identity CID→glyph maps: then a character code is the glyph number.
    if (/\/CIDToGIDMap\s+\d+\s+\d+\s+R/.test(cid.body)) continue;
    const fd = ref(cid.body, "FontDescriptor");
    const ff = fd !== null ? ref(objs.get(fd)?.body ?? "", "FontFile2") : null;
    const fontFile = ff !== null ? streamData(pdf, objs, ff) : null;
    const cmap = streamData(pdf, objs, tu);
    if (!fontFile || !cmap) continue;
    try {
      fonts.push({ num: o.num, base, family: base.replace(/^[A-Z]{6}\+/, ""), toUnicodeNum: tu, map: parseToUnicode(cmap.toString("latin1")), outlines: readOutlines(fontFile) });
    } catch {
      /* a font that cannot be read is left as it is */
    }
  }
  report.fonts = fonts.length;

  // References: every glyph in the document whose character is known, and the ligatures each font can form.
  const refs: Ref[] = [];
  for (const f of fonts) {
    const known = new Map<string, number>();
    for (const [code, u] of f.map) {
      if (!u || u === "\u0000" || [...u].length !== 1 || /\s/.test(u)) continue;
      known.set(u, code);
      const o = f.outlines.glyph(code);
      const shape = o ? shapeOf(o) : null;
      if (shape) refs.push({ char: u, shape, family: f.family, ligature: false });
    }
    for (const lig of LIGATURES) {
      const codes = [...lig].map((c) => known.get(c));
      if (codes.some((c) => c === undefined)) continue;
      const parts = codes.map((c) => ({ o: f.outlines.glyph(c!) ?? [], adv: f.outlines.advance(c!) }));
      const shape = shapeOf(joined(parts));
      if (shape) refs.push({ char: lig, shape, family: f.family, ligature: true });
    }
  }

  const candidates = (f: F) => [...[...f.map.entries()].filter(([, u]) => !u || u === "\u0000").map(([c]) => c), ...missingCodes(f)];

  // 1. Each glyph on its own shape.
  type Row = { f: F; code: number; shape: Shape | null; ranked: [string, number][]; char: string | null; how: string };
  const rows: Row[] = [];
  for (const f of fonts)
    for (const code of candidates(f)) {
      const o = f.outlines.glyph(code);
      const shape = o ? shapeOf(o) : null;
      const ranked = shape ? rankFor(shape, f.family, refs) : [];
      rows.push({ f, code, shape, ranked, char: decide(ranked), how: "shape" });
    }
  // Where a glyph sits in its font is evidence too. Subsets keep the original glyph numbers, so every copy of a font
  // in the document, and its other weights, number their glyphs alike.
  const isDigit = (c: string | null) => !!c && /^\d$/.test(c);
  const near = (r: Row, c: string, slack: number) => {
    const best = r.ranked[0]?.[1] ?? Infinity;
    const hit = r.ranked.slice(0, 5).find(([x]) => x === c);
    return !!hit && hit[1] <= Math.min(best + slack, 0.32);
  };
  const confident = new Map<Row, string>(rows.filter((r) => r.char).map((r) => [r, r.char!]));
  const byFamily = (fam: string) => rows.filter((r) => r.f.family === fam);
  const base = (fam: string) => fam.replace(/[-,]?(Bold|Regular|Italic|Medium|Light|Semibold|Black)?(MT|PSMT)?$/i, "").replace(/PS-?$/i, "");
  for (let pass = 0; pass < 2; pass++) {
    // 2. Runs: alternate digit forms that sit in ten consecutive glyphs, 0 to 9, confirmed by at least three
    //    members and contradicted by none.
    for (const fam of new Set(rows.map((r) => r.f.family))) {
      const fr = byFamily(fam);
      const votes = new Map<number, number>();
      for (const r of fr) if (isDigit(confident.get(r) ?? null)) votes.set(r.code - Number(confident.get(r)), (votes.get(r.code - Number(confident.get(r))) ?? 0) + 1);
      for (const [b, n] of votes) {
        if (n < 3) continue;
        const inRun = fr.filter((r) => r.code >= b && r.code <= b + 9);
        if (inRun.some((r) => isDigit(confident.get(r) ?? null) && Number(confident.get(r)) !== r.code - b)) continue;
        for (const r of inRun) if (!isDigit(r.char) && near(r, String(r.code - b), 0.2)) Object.assign(r, { char: String(r.code - b), how: "run" });
      }
    }
    // 3. The same glyph number already identified in another weight of the font.
    for (const r of rows) {
      if (r.char) continue;
      const twin = rows.find((x) => x !== r && confident.has(x) && x.code === r.code && base(x.f.family) === base(r.f.family));
      if (twin && near(r, confident.get(twin)!, 0.15)) Object.assign(r, { char: confident.get(twin)!, how: "weight" });
    }
    // 4. Digit blocks: a glyph among identified digits (three within six numbers either side) is a digit.
    for (const r of rows) {
      if (isDigit(r.char)) continue;
      const fr = byFamily(r.f.family).filter((x) => x !== r && Math.abs(x.code - r.code) <= 6);
      if (fr.filter((x) => isDigit(x.char)).length < 3 || fr.some((x) => x.char && !isDigit(x.char) && x.how === "shape" && !LIGATURES.includes(x.char) && x.char !== "." && x.char !== "/")) continue;
      const d = r.ranked.slice(0, 5).find(([c]) => isDigit(c));
      if (d && d[1] <= 0.32 && (!r.char || near(r, d[0], 0.15))) Object.assign(r, { char: d[0], how: "digits" });
    }
    // 5. Identical outlines read the same.
    for (const r of rows) {
      if (r.char || !r.shape) continue;
      const twin = rows.find((x) => x.char && x.shape && x.f.family === r.f.family && unlike(r.shape!, x.shape) < 0.01);
      if (twin) Object.assign(r, { char: twin.char, how: "twin" });
    }
    for (const r of rows) if (r.char) confident.set(r, r.char);
  }

  const changed: F[] = [];
  for (const f of fonts) {
    let touched = false;
    for (const r of rows.filter((x) => x.f === f)) {
      report.unmapped++;
      if (debug) {
        debug(`${f.family} ${r.code.toString(16)} ${f.map.has(r.code) ? "Z" : "L"} → ${r.char ?? "?"}${r.how !== "shape" ? ` (${r.how})` : ""}  [${r.ranked.slice(0, 4).map(([c, d]) => `${c}:${Number.isFinite(d) ? d.toFixed(3) : "∞"}`).join(" ")}]`);
        if (r.shape && process.env.T_CYBER_GLYPHS) debug(asciiGlyph(r.shape.grid));
      }
      if (!r.char) {
        report.unresolved.push({ font: f.family, code: r.code });
        continue;
      }
      f.map.set(r.code, r.char);
      report.repaired.push({ font: f.family, code: r.code, char: r.char, difference: Number((r.ranked.find(([c]) => c === r.char)?.[1] ?? 0).toFixed(3)) });
      touched = true;
    }
    if (touched) changed.push(f);
  }
  if (!changed.length) return { pdf: null, report };

  // Incremental update: new versions of the changed ToUnicode streams, a cross-reference section for them, and a
  // trailer that points back to the original one.
  const tail = pdf.toString("latin1", Math.max(0, pdf.length - 2048));
  const prev = Number(/startxref\s+(\d+)/.exec(tail.slice(tail.lastIndexOf("startxref")))?.[1] ?? NaN);
  const lastTrailer = pdf.toString("latin1").lastIndexOf("trailer");
  const trailer = lastTrailer >= 0 ? pdf.toString("latin1", lastTrailer, lastTrailer + 2000) : "";
  const root = /\/Root\s+(\d+\s+\d+\s+R)/.exec(trailer)?.[1];
  const size = Number(/\/Size\s+(\d+)/.exec(trailer)?.[1] ?? NaN);
  if (!root || !Number.isFinite(prev) || !Number.isFinite(size)) return { pdf: null, report };
  const parts: Buffer[] = [pdf, Buffer.from("\n", "latin1")];
  let offset = pdf.length + 1;
  const xref: { num: number; off: number }[] = [];
  for (const f of changed) {
    const body = Buffer.from(writeToUnicode(f.map), "latin1");
    const head = Buffer.from(`${f.toUnicodeNum} 0 obj\n<< /Length ${body.length} >>\nstream\n`, "latin1");
    const foot = Buffer.from("\nendstream\nendobj\n", "latin1");
    xref.push({ num: f.toUnicodeNum, off: offset });
    parts.push(head, body, foot);
    offset += head.length + body.length + foot.length;
  }
  const xrefAt = offset;
  const lines = ["xref"];
  for (const x of xref.sort((a, b) => a.num - b.num)) lines.push(`${x.num} 1`, `${String(x.off).padStart(10, "0")} 00000 n `);
  lines.push("trailer", `<< /Size ${size} /Root ${root} /Prev ${prev} >>`, "startxref", String(xrefAt), "%%EOF", "");
  parts.push(Buffer.from(lines.join("\n"), "latin1"));
  return { pdf: Buffer.concat(parts), report };
}
