/**
 * How the case's acts and sections are shown: the section first, then its act ("318(4) BNS", "66D IT Act").
 *
 * Only the order changes. The sections are those the FIR states or an officer typed, and every section keeps its
 * exact wording ("66-D" stays "66-D"). T-CYBER never adds, drops or corrects a section. Text this reader cannot be
 * sure of (an act with no section, a section with no act, anything else) is shown exactly as it was written.
 *
 *   "BNS 318(4), IT Act 66C, 66D"         → "318(4) BNS, 66C IT Act, 66D IT Act"
 *   "IT Act 66-C, 66-D; BNS 318(4), 319(2)" → "66-C IT Act, 66-D IT Act, 318(4) BNS, 319(2) BNS"
 *   "u/s 318(4) r/w 3(5) BNS"             → "318(4) r/w 3(5) BNS"
 */

export interface StatedSection {
  /** As written, e.g. "318(4)" or "318(4) r/w 3(5)". */
  section: string;
  /** As written, e.g. "BNS" or "IT Act". */
  act: string;
}

// One section number: 318, 318(4), 66D, 66-D, 66A(b), 120B.
const NUM = String.raw`\d{1,4}[A-Za-z]{0,2}(?:-[A-Za-z]{1,2})?(?:\(\s*[0-9A-Za-z]{1,4}\s*\))*`;
// Sections joined by "read with": 318(4) r/w 3(5).
const NUMS = String.raw`${NUM}(?:\s+(?:r\/w|read\s+with)\s+${NUM})*`;
// An act's name: letters, dots, ampersands and spaces, optionally "of 2000" or ", 2000" is not allowed (the comma splits).
const ACT = String.raw`[A-Za-z][A-Za-z.&'’\- ]*?[A-Za-z.]`;
const LEAD = String.raw`(?:(?:u\s*\/\s*s\.?|u\s*\/\s*sec\.?|sec(?:tion)?s?\.?|s\.)\s*)?`;

const BARE = new RegExp(String.raw`^${LEAD}(${NUMS})$`, "i");
const ACT_FIRST = new RegExp(String.raw`^(${ACT})\s+${LEAD}(${NUMS})$`, "i");
const ACT_LAST = new RegExp(String.raw`^${LEAD}(${NUMS})\s+(?:of\s+(?:the\s+)?)?(${ACT})$`, "i");
// A word that is a section keyword, not an act ("Sec 420" read as act "Sec" would be wrong).
const NOT_ACT = /^(?:u\s*\/\s*s\.?|sec(?:tion)?s?\.?|s\.|r\/w|read with|and|of|the)$/i;

const tidy = (s: string) => s.replace(/\s+/g, " ").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")").trim();

/**
 * The stated sections with their acts, in the order written, or null when the text cannot be read with certainty.
 * Lists are split at commas, semicolons, "and" and "&"; a bare number belongs to the act before it ("BNS 318(4),
 * 319(2)") or, when no act came before, to the act after it ("318(4), 319(2) BNS").
 */
export function readSections(text: string | null | undefined): StatedSection[] | null {
  const src = tidy(text ?? "");
  if (!src) return null;
  const parts = src
    .split(/\s*(?:[,;]|\band\b|&)\s*/i)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.length) return null;
  const out: StatedSection[] = [];
  let act: string | null = null; // the last act written before the section (act-first lists)
  let pending: string[] = []; // bare numbers waiting for an act written after them (act-last lists)
  for (const part of parts) {
    let m = BARE.exec(part);
    if (m) {
      if (act) out.push({ section: tidy(m[1]!), act });
      else pending.push(tidy(m[1]!));
      continue;
    }
    m = ACT_FIRST.exec(part);
    if (m && !NOT_ACT.test(m[1]!.trim())) {
      if (pending.length) return null; // "318(4), IT Act 66D": the 318(4) has no act
      act = tidy(m[1]!);
      out.push({ section: tidy(m[2]!), act });
      continue;
    }
    m = ACT_LAST.exec(part);
    if (m && !NOT_ACT.test(m[2]!.trim())) {
      const a = tidy(m[2]!);
      for (const p of pending) out.push({ section: p, act: a });
      pending = [];
      out.push({ section: tidy(m[1]!), act: a });
      act = null; // in an act-last list the next bare numbers wait for their own act
      continue;
    }
    return null;
  }
  if (pending.length) return null;
  return out.length ? out : null;
}

/** The sections as shown everywhere: each section first, then its act. Unreadable text comes back as written. */
export function formatSections(text: string | null | undefined): string {
  const list = readSections(text);
  if (!list) return tidy(text ?? "");
  return list.map((s) => `${s.section} ${s.act}`).join(", ");
}

/** Each stated section on its own ("318(4) BNS"), or the whole text as one item when it cannot be read. */
export function sectionItems(text: string | null | undefined): string[] {
  const list = readSections(text);
  if (list) return list.map((s) => `${s.section} ${s.act}`);
  const t = tidy(text ?? "");
  return t ? [t] : [];
}
