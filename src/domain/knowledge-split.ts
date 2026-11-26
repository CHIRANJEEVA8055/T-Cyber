/**
 * Splits the text of an uploaded procedure document into the sections the assistant cites. Rules only: numbered
 * clauses (1., 2.1), the law's own headings (Section 63, Rule 5, Annexure A), Markdown and Word heading levels, and
 * short capitalised headings. A file without headings is cut into parts at paragraph breaks, never mid-sentence.
 * Page numbers and running headers repeated on most pages are dropped. The developer checks the result before
 * publishing, so a wrong split is corrected by a person, not guessed at answer time.
 */

export interface TextBlock {
  text: string;
  page?: number | null;
  /** 1 to 6 when the file itself marks the line as a heading (Word heading style). */
  headingLevel?: number | null;
}

export interface SplitSection {
  sectionRef: string;
  heading: string;
  text: string;
  page: number | null;
  topics: string[];
}

const MAX_SECTION = 2400;
const PART_TARGET = 1200;

const PAGE_NUMBER = /^(?:page\s*)?[-–—]?\s*\d{1,4}\s*(?:of\s*\d{1,4})?\s*[-–—]?$/i;

const LEGAL = /^(section|sec\.?|rule|article|art\.|chapter|part|annexure|annex|appendix|schedule|clause|regulation|reg\.|form)\s+([0-9]{1,4}[A-Z]?|[IVXLC]{1,6}|[A-Z])\b\s*([.:\-–—]?)\s*(.*)$/i;
const LEGAL_REF: Record<string, string> = { section: "s.", "sec.": "s.", sec: "s.", rule: "Rule", article: "Art.", "art.": "Art.", chapter: "Ch.", part: "Part", annexure: "Annexure", annex: "Annexure", appendix: "Appendix", schedule: "Schedule", clause: "Cl.", regulation: "Reg.", "reg.": "Reg.", form: "Form" };
const NUMBERED = /^(\d{1,3}(?:\.\d{1,3}){0,4})[.)]?\s+(.+)$/;
const MARKDOWN = /^(#{1,6})\s+(.+?)\s*#*$/;

type Heading = { ref: string | null; heading: string; body?: string };

const clean = (t: string) =>
  t
    .replace(/ /g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\*\*|__|`/g, "")
    .trim();

const endsSentence = (t: string) => /[.;:,!?)"”’]$/.test(t);
const startsUpper = (t: string) => /^[A-Z(“"'‘]/.test(t);

function firstWords(text: string, max = 60): string {
  const sentence = text.split(/(?<=[.;:])\s/)[0] ?? text;
  if (sentence.length <= max) return sentence.replace(/[.;:]$/, "");
  const cut = sentence.slice(0, max);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 20 ? cut.lastIndexOf(" ") : max).trim()}…`;
}

function asHeading(b: TextBlock): Heading | null {
  const t = b.text;
  const md = MARKDOWN.exec(t);
  if (md) return { ...numberedRef(md[2]!), ref: numberedRef(md[2]!).ref };
  if (b.headingLevel) return numberedRef(t);
  const legal = LEGAL.exec(t);
  if (legal) {
    const [, kind, num, sep, rest = ""] = legal;
    const ref = `${LEGAL_REF[kind!.toLowerCase()] ?? kind} ${num}`;
    const restOk = rest.length <= 100 && (sep !== "" || rest === "" || (startsUpper(rest) && !/[.;,]$/.test(rest)));
    if (restOk && t.length <= 120) return { ref, heading: rest || ref };
  }
  const num = NUMBERED.exec(t);
  if (num) {
    const [, n, rest] = num;
    if (rest!.length <= 90 && startsUpper(rest!) && !/[.;,]$/.test(rest!)) return { ref: `§${n}`, heading: rest!.replace(/:$/, "") };
    // A long numbered clause carries its own text: a section of its own, named by its first words.
    if (rest!.length > 90) return { ref: `§${n}`, heading: firstWords(rest!), body: rest };
    return null;
  }
  // A short line in capitals with no closing punctuation reads as a heading.
  const letters = t.replace(/[^A-Za-z]/g, "");
  if (t.length <= 80 && letters.length >= 4 && letters === letters.toUpperCase() && t.split(/\s+/).length >= 2 && !endsSentence(t)) return { ref: null, heading: titleCase(t) };
  return null;
}

/** A heading that carries its own number ("3.2 Holds") keeps it as the reference. */
function numberedRef(t: string): Heading {
  const num = NUMBERED.exec(t);
  if (num && num[2]!.length <= 90) return { ref: `§${num[1]}`, heading: num[2]!.replace(/:$/, "") };
  const legal = LEGAL.exec(t);
  if (legal && legal[4]!.length <= 100) {
    const ref = `${LEGAL_REF[legal[1]!.toLowerCase()] ?? legal[1]} ${legal[2]}`;
    return { ref, heading: legal[4] || ref };
  }
  return { ref: null, heading: t };
}

function titleCase(t: string): string {
  return t.toLowerCase().replace(/(^|\s|[-(])([a-z])/g, (_, p: string, c: string) => p + c.toUpperCase());
}

/** Lines repeated on at least half the pages (running headers and footers) when there are three pages or more. */
function runningLines(blocks: TextBlock[]): Set<string> {
  const pages = new Set(blocks.map((b) => b.page).filter((p): p is number => typeof p === "number"));
  if (pages.size < 3) return new Set();
  const seen = new Map<string, Set<number>>();
  for (const b of blocks) {
    if (typeof b.page !== "number") continue;
    const k = clean(b.text);
    if (!k || k.length > 120) continue;
    seen.set(k, (seen.get(k) ?? new Set()).add(b.page));
  }
  return new Set([...seen.entries()].filter(([, ps]) => ps.size >= Math.max(3, Math.ceil(pages.size / 2))).map(([k]) => k));
}

interface Draft {
  ref: string | null;
  heading: string;
  paras: string[];
  page: number | null;
  intro?: boolean;
}

function appendText(d: Draft, text: string, newPara: boolean) {
  if (newPara || !d.paras.length) {
    d.paras.push(text);
    return;
  }
  const last = d.paras[d.paras.length - 1]!;
  // A word broken across lines ("acknow-" / "ledgement") is joined back together.
  if (/[A-Za-z]-$/.test(last) && /^[a-z]/.test(text)) d.paras[d.paras.length - 1] = last.slice(0, -1) + text;
  else d.paras[d.paras.length - 1] = `${last} ${text}`;
}

/** Cuts text into pieces of about `target` characters at paragraph breaks, else at sentence ends. */
function chunk(paras: string[], target: number): string[] {
  const units: string[] = [];
  for (const p of paras) {
    if (p.length <= target * 1.5) units.push(p);
    else {
      let buf = "";
      for (const s of p.split(/(?<=[.!?;])\s+/)) {
        if (buf && buf.length + s.length + 1 > target) {
          units.push(buf);
          buf = s;
        } else buf = buf ? `${buf} ${s}` : s;
      }
      if (buf) units.push(buf);
    }
  }
  const out: string[] = [];
  let cur = "";
  for (const u of units) {
    if (cur && cur.length + u.length + 1 > target) {
      out.push(cur);
      cur = u;
    } else cur = cur ? `${cur}\n\n${u}` : u;
  }
  if (cur) out.push(cur);
  return out;
}

export function splitIntoSections(blocks: TextBlock[], opts: { headingsOnly?: boolean } = {}): SplitSection[] {
  const running = runningLines(blocks);
  const drafts: Draft[] = [];
  let cur: Draft | null = null;
  let breakBefore = false;
  let unnumbered = 0;

  for (const b of blocks) {
    const text = clean(b.text);
    if (!text) {
      breakBefore = true;
      continue;
    }
    if (PAGE_NUMBER.test(text) || running.has(text)) continue;
    // Prepared Markdown marks its own headings; its numbered lists and quoted capitals are text.
    const h = opts.headingsOnly ? (MARKDOWN.test(text) || b.headingLevel ? asHeading({ ...b, text }) : null) : asHeading({ ...b, text });
    if (h) {
      cur = { ref: h.ref, heading: h.heading, paras: h.body ? [h.body] : [], page: b.page ?? null };
      if (!h.ref) cur.ref = `Part ${++unnumbered}`;
      drafts.push(cur);
      breakBefore = false;
      continue;
    }
    if (!cur) {
      cur = { ref: "Intro", heading: "Introduction", paras: [], page: b.page ?? null, intro: true };
      drafts.push(cur);
    }
    appendText(cur, text, breakBefore);
    breakBefore = false;
  }

  const kept = drafts.filter((d) => d.paras.join("").trim());
  if (!kept.length) return [];

  // No headings at all: the whole text is cut into parts.
  if (kept.length === 1 && kept[0]!.intro) {
    return chunk(kept[0]!.paras, PART_TARGET).map((t, i) => section(`Part ${i + 1}`, firstWords(t), t, kept[0]!.page));
  }

  const out: SplitSection[] = [];
  const used = new Map<string, number>();
  for (const d of kept) {
    const pieces = d.paras.join("\n\n").length > MAX_SECTION ? chunk(d.paras, PART_TARGET) : [d.paras.join("\n\n")];
    pieces.forEach((t, i) => {
      let ref = i ? `${d.ref} (part ${i + 1})` : d.ref!;
      const n = used.get(ref) ?? 0;
      used.set(ref, n + 1);
      if (n) ref = `${ref} (${n + 1})`;
      out.push(section(ref, d.heading, t, d.page));
    });
  }
  return out;
}

function section(sectionRef: string, heading: string, text: string, page: number | null): SplitSection {
  return { sectionRef, heading: heading.slice(0, 160), text: text.trim(), page, topics: [heading.toLowerCase().slice(0, 80)] };
}
