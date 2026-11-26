import { parseRupeesToMinor } from "../money";
import type { SourceLine } from "./index";

/**
 * Reads the FIR form that CCTNS prints ("FIRST INFORMATION REPORT (Under section 173 … BNSS)", items 1 to 15), as the
 * Telangana Police CCTNS produces it and a browser saves it to PDF. The form's table columns come out of the text
 * layer as fragments ("Residenc" / "y,"), its labels and values share lines, and long values (URLs, phone numbers)
 * wrap. Each item is read from its own labels; the complaint text (item 12) is read as one joined passage so that
 * wrapped values come out whole, and every value keeps the page and line it was read from. Rules only: nothing is
 * inferred that the copy does not state.
 */

export interface At {
  page: number | null;
  line: number | null;
}
export interface Valued<T = string> extends At {
  value: T;
}

export interface CctnsPerson {
  name: Valued | null;
  relative: Valued | null;
  age: Valued<number> | null;
  occupation: Valued | null;
  mobile: Valued | null;
  email: Valued | null;
  address: Valued | null;
}

export interface CctnsAccused {
  serial: number;
  /** As entered in item 7(a): often the identifiers themselves, or a description ("Suspect bank account holders"). */
  text: Valued;
  gender: string | null;
  phone: string | null;
  email: string | null;
}

export interface CctnsOfficer {
  name: string;
  rank: string | null;
  number: string | null;
  unit: string | null;
  at: At;
}

export interface CctnsFir {
  district: Valued | null;
  policeStation: Valued | null;
  fir: Valued<{ number: number; year: number }> | null;
  firDate: Valued | null;
  /** "318(4), 319(2), 336(3), 338, 340(2) r/w 3(5) BNS; 66-D IT Act" */
  sections: Valued | null;
  acts: { act: string; sections: string[] }[];
  occurrenceFrom: Valued | null;
  occurrenceTo: Valued | null;
  occurrencePriorTo: boolean;
  received: Valued | null;
  gdEntry: Valued | null;
  infoType: Valued | null;
  place: Valued | null;
  distance: Valued | null;
  complainant: CctnsPerson;
  accused: CctnsAccused[];
  delayReason: Valued | null;
  property: Valued | null;
  totalValue: Valued<{ text: string; minor: bigint }> | null;
  /** Item 12, from "Brief facts…" to "Hence the FIR.", joined; the lines it came from, for tracing values back. */
  narrative: { text: string; lines: SourceLine[]; offsets: number[] } | null;
  registeredBy: CctnsOfficer | null;
  investigatingOfficer: CctnsOfficer | null;
  officerInCharge: CctnsOfficer | null;
}

const at = (l: SourceLine): At => ({ page: l.page, line: l.line });
const val = <T>(value: T, l: SourceLine): Valued<T> => ({ value, ...at(l) });
const clean = (s: string) => s.replace(/\s+/g, " ").trim();

/** True when the copy is the CCTNS FIR form. */
export function isCctnsFir(lines: readonly SourceLine[]): boolean {
  const head = lines.slice(0, 40).map((l) => l.text).join("\n");
  return /FIRST INFORMATION REPORT/i.test(head) && /1\.\s*District\b/i.test(head) && /FIR No\./i.test(head) && /2\.\s*Acts?\s*&\s*Section/i.test(head);
}

/** "DD-MM-YYYY[ HH:MM[:SS]]" as the form prints it → "YYYY-MM-DDTHH:MM" (IST wall time), or null. */
export function formDateTime(s: string): string | null {
  const m = /\b(\d{2})[-/](\d{2})[-/](\d{4})(?:\s+(\d{1,2}):(\d{2})(?::\d{2})?)?/.exec(s);
  if (!m) return null;
  const [, d, mo, y, h, mi] = m;
  if (Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > 31) return null;
  return `${y}-${mo}-${d}T${h ? h.padStart(2, "0") : "00"}:${mi ?? "00"}`;
}

const ACT_NAMES: [RegExp, string][] = [
  [/^BNSS?$/i, "BNS"],
  [/^BNSS$/i, "BNSS"],
  [/^ITA[- ]?2000[- ]?2008$|^IT\s*Act/i, "IT Act"],
  [/^IPC$/i, "IPC"],
  [/^BSA$/i, "BSA"],
  [/^POCSO/i, "POCSO Act"],
  [/^DPA|^Dowry/i, "Dowry Prohibition Act"],
];

/** "318(4),319(2),r/w 3(5) BNS, 66-D ITA-2000-2008," → acts with their sections, in the order stated. */
export function parseActs(raw: string): { act: string; sections: string[] }[] {
  const out: { act: string; sections: string[] }[] = [];
  const re = /((?:(?:r\/w\s*)?[0-9]+[A-Z]?(?:-[A-Z])?(?:\(\s*[0-9a-z]+\s*\))*\s*,?\s*)+)\s*([A-Za-z][A-Za-z0-9-]*(?:\s*Act)?)/g;
  for (const m of raw.matchAll(re)) {
    const actRaw = m[2]!.replace(/[,.]$/, "");
    const act = ACT_NAMES.find(([r]) => r.test(actRaw))?.[1] ?? actRaw;
    const sections = m[1]!
      .split(",")
      .map((s) => clean(s).replace(/^r\/w\s*/i, "r/w "))
      .filter((s) => /\d/.test(s));
    if (sections.length) out.push({ act, sections });
  }
  return out;
}

export function sectionsText(acts: { act: string; sections: string[] }[]): string {
  return acts.map((a) => `${a.act} ${a.sections.join(", ").replace(/, r\/w /g, " r/w ")}`).join("; ");
}

/** Joins column fragments the form splits ("Residenc" + "y," → "Residency,"). */
function joinFragments(parts: string[]): string {
  let out = "";
  for (const p of parts.map((x) => x.trim()).filter(Boolean)) {
    if (!out) out = p;
    else if (/[a-z]$/.test(out) && /^[a-z]/.test(p)) out += p;
    else out += ` ${p}`;
  }
  return out;
}

/** Lines of running text joined; a URL or word broken at the line end ("…/avinc/" + "register/839417") is rejoined. */
export function joinWrapped(parts: string[]): string {
  let text = "";
  for (const p of parts.map((x) => x.trim()).filter(Boolean)) {
    const tight = /(?:https?:\/\/|\/|-|[?&=])$/.test(text) && /^[\w./#?&=%-]/.test(p) && !/^(?:and|or|the|to|of)\b/i.test(p);
    text += text ? (tight ? "" : " ") : "";
    text += p;
  }
  return clean(text);
}

function findLine(lines: readonly SourceLine[], re: RegExp, from = 0, to = lines.length): number {
  for (let i = from; i < to; i++) if (re.test(lines[i]!.text)) return i;
  return -1;
}

export function parseCctnsFir(lines: readonly SourceLine[]): CctnsFir | null {
  if (!isCctnsFir(lines)) return null;
  const L = lines.map((l) => ({ ...l, text: clean(l.text) }));
  const idx = (re: RegExp, from = 0, to = L.length) => findLine(L, re, from, to);
  const item = (n: number, label: RegExp) => idx(new RegExp(`^${n}\\.\\s*${label.source}`, "i"));

  const r: CctnsFir = {
    district: null,
    policeStation: null,
    fir: null,
    firDate: null,
    sections: null,
    acts: [],
    occurrenceFrom: null,
    occurrenceTo: null,
    occurrencePriorTo: false,
    received: null,
    gdEntry: null,
    infoType: null,
    place: null,
    distance: null,
    complainant: { name: null, relative: null, age: null, occupation: null, mobile: null, email: null, address: null },
    accused: [],
    delayReason: null,
    property: null,
    totalValue: null,
    narrative: null,
    registeredBy: null,
    investigatingOfficer: null,
    officerInCharge: null,
  };

  // 1. District, P.S., Year, FIR No., Date — the P.S. name can wrap onto the next lines.
  const i1 = item(1, /District/);
  const i2 = item(2, /Acts?\s*&\s*Section/);
  if (i1 >= 0) {
    const l = L[i1]!;
    const m = /District\s+(.+?)\s+P\.S\.\s+(.*?)\s+Year\s+(\d{4})\s+FIR No\.?\s*(\d{1,6})\s*\/\s*(\d{4})\s+Date\s+(\d{2}-\d{2}-\d{4})/i.exec(l.text);
    if (m) {
      r.district = val(m[1]!, l);
      const wrapped = L.slice(i1 + 1, i2 > i1 ? i2 : i1 + 1).map((x) => x.text);
      r.policeStation = val(clean(`${m[2]} ${joinFragments(wrapped)}`), l);
      r.fir = val({ number: Number(m[4]), year: Number(m[5]) }, l);
      r.firDate = val(m[6]!, l);
    } else {
      const f = /FIR No\.?\s*(\d{1,6})\s*\/\s*(\d{4})/i.exec(l.text);
      if (f) r.fir = val({ number: Number(f[1]), year: Number(f[2]) }, l);
    }
  }

  // 2. Acts & Sections, possibly continued on the next lines.
  if (i2 >= 0) {
    const i3 = item(3, /a\)/) >= 0 ? item(3, /a\)/) : idx(/^3\./, i2 + 1);
    const text = clean([L[i2]!.text.replace(/^2\.\s*Acts?\s*&\s*Section\(?s?\)?\s*:?/i, ""), ...L.slice(i2 + 1, i3 > i2 ? i3 : i2 + 1).map((x) => x.text)].join(" "));
    r.acts = parseActs(text);
    if (r.acts.length) r.sections = val(sectionsText(r.acts), L[i2]!);
  }

  // 3. Occurrence: "Date & Time From …" / "Date & Time To [Prior To] …"; received at the P.S.; GD entry.
  const iFrom = idx(/Date & Time From/i);
  if (iFrom >= 0) {
    const t = formDateTime(L[iFrom]!.text.replace(/^.*?Date & Time From/i, ""));
    if (t) r.occurrenceFrom = val(t, L[iFrom]!);
  }
  const iTo = idx(/Date & Time To/i);
  if (iTo >= 0) {
    const rest = L[iTo]!.text.replace(/^.*?Date & Time To/i, "");
    r.occurrencePriorTo = /Prior To/i.test(rest);
    const t = formDateTime(rest);
    if (t) r.occurrenceTo = val(t, L[iTo]!);
  }
  const iRec = idx(/Information Received at P\.S\./i);
  if (iRec >= 0) {
    const t = formDateTime(L[iRec]!.text);
    if (t) r.received = val(t, L[iRec]!);
  }
  const iGd = idx(/General Diary Reference/i);
  if (iGd >= 0) {
    const m = /Entry No\.?\s*(\d+)/i.exec(L[iGd]!.text);
    if (m) r.gdEntry = val(m[1]!, L[iGd]!);
  }
  const i4 = item(4, /Type of Information/);
  if (i4 >= 0) {
    const v = L[i4]!.text.replace(/^4\.\s*Type of Information\s*:?/i, "").trim();
    if (v) r.infoType = val(v, L[i4]!);
  }

  // 5. Place of occurrence.
  const iDist = idx(/Distance and Direction From P\.S\./i);
  if (iDist >= 0) {
    const v = L[iDist]!.text.replace(/^.*?From P\.S\.\s*:?/i, "").replace(/\s*Beat No\.?.*$/i, "").trim();
    if (v) r.distance = val(v, L[iDist]!);
  }
  const iPlace = idx(/^b\)\s*Address\s+Place/i);
  if (iPlace >= 0) {
    // The address can continue on the lines before "Area/Mandal".
    const iArea = idx(/^Area\/Mandal/i, iPlace + 1, iPlace + 4);
    const v = clean([L[iPlace]!.text.replace(/^b\)\s*Address\s+Place\s*/i, ""), ...(iArea > iPlace ? L.slice(iPlace + 1, iArea).map((x) => x.text) : [])].join(" "));
    const areaLine = iArea > iPlace ? iArea : iPlace + 1;
    const area = /Area\/Mandal\s*(.*?)\s*Street\/Village\s*(.*)$/i.exec(L[areaLine]?.text ?? "");
    const city = /City\/District\s+(.*?)\s+State\s+(.*?)(?:\s+PIN\s*(\d{6})?)?$/i.exec(L[areaLine + 1]?.text ?? "");
    const parts = [v, area?.[2], area?.[1], city?.[1], city?.[2], city?.[3]].map((x) => clean(x ?? "")).filter(Boolean);
    const unique = parts.filter((p, i) => parts.findIndex((q) => q.toLowerCase() === p.toLowerCase()) === i);
    if (unique.length) r.place = val(unique.join(", "), L[iPlace]!);
  }

  // 6. Complainant / Informant.
  const i6 = item(6, /Complainant/);
  const i7 = item(7, /Details of known/);
  if (i6 >= 0) {
    const end = i7 > i6 ? i7 : Math.min(L.length, i6 + 20);
    const get = (re: RegExp) => {
      const i = idx(re, i6, end);
      return i >= 0 ? { l: L[i]!, i } : null;
    };
    const name = get(/^a\)\s*Name\b/i);
    if (name) {
      const v = name.l.text.replace(/^a\)\s*Name\s*/i, "").trim();
      if (v) r.complainant.name = val(v, name.l);
    }
    const rel = get(/^b\)\s*Father'?s/i);
    if (rel) {
      const v = rel.l.text.replace(/^b\)\s*Father'?s\s*\/\s*Husband'?s\s*Name\s*/i, "").trim();
      if (v) r.complainant.relative = val(v, rel.l);
    }
    const age = get(/^c\)\s*Date\/Year of Birth/i);
    const a = age && /Age\s+(\d{1,3})\s*Years?/i.exec(age.l.text);
    if (age && a) r.complainant.age = val(Number(a[1]), age.l);
    const occ = get(/^g\)\s*Occupation/i);
    if (occ) {
      const o = /Occupation\s+(.*?)\s*(?:Mobile No\.?|$)/i.exec(occ.l.text)?.[1]?.trim();
      if (o) r.complainant.occupation = val(o, occ.l);
      const mob = /Mobile No\.?\s*([+\d][\d\s-]{8,16}\d)/i.exec(occ.l.text)?.[1];
      if (mob) r.complainant.mobile = val(mob.replace(/[\s-]/g, ""), occ.l);
    }
    const addr = get(/^h\)\s*Address/i);
    if (addr && occ) {
      // The house-number column wraps into the lines between (g) and (h); the rest of (h) holds area and street.
      const fragments = L.slice(occ.i + 1, addr.i).map((x) => x.text);
      const m = /^h\)\s*Address\s+House No\s*(.*?)\s*Area\/Mandal\s*(.*?)\s*Street\/Village\s*(.*)$/i.exec(addr.l.text);
      const city = /City\/District\s+(.*?)\s+State\s+(.*?)(?:\s+PIN\s*(\d{6})?)?$/i.exec(L[addr.i + 1]?.text ?? "");
      const house = joinFragments([...fragments, m?.[1] ?? ""]);
      const parts = [house, m?.[3], m?.[2], city?.[1], city?.[2], city?.[3]].map((x) => clean(x ?? "")).filter(Boolean);
      const unique = parts.filter((p, i) => parts.findIndex((q) => q.toLowerCase() === p.toLowerCase()) === i);
      if (unique.length) r.complainant.address = val(unique.join(", "), addr.l);
    }
  }

  // 7. Accused: one block per "Serial No :", each with (a) Name … (i) Email.
  const iPhys = idx(/Physical features, deformities/i);
  const i8 = item(8, /Reasons for delay/);
  if (i7 >= 0) {
    const end = [iPhys, i8].filter((x) => x > i7).sort((a, b) => a - b)[0] ?? L.length;
    for (let i = i7 + 1; i < end; i++) {
      const s = /^Serial No\s*:\s*(\d+)?/i.exec(L[i]!.text);
      if (!s) continue;
      const iA = idx(/^a\)\s*Name\b/i, i, end);
      const iB = idx(/^b\)\s*Father'?s/i, iA >= 0 ? iA : i, end);
      if (iA < 0) continue;
      const text = joinWrapped([L[iA]!.text.replace(/^a\)\s*Name\s*/i, ""), ...L.slice(iA + 1, iB > iA ? iB : iA + 1).map((x) => x.text)]);
      const blockEnd = idx(/^Serial No\s*:/i, iA + 1, end);
      const block = L.slice(iA, blockEnd > 0 ? blockEnd : end).map((x) => x.text);
      const gender = /Gender\s+(Male|Female|Other|Transgender)/i.exec(block.join(" "))?.[1] ?? null;
      const phone = /Cell No\s*([+\d][\d\s-]{8,16}\d)/i.exec(block.join(" "))?.[1] ?? null;
      const email = /^i\)\s*Email\s*(\S+@\S+)/im.exec(block.join("\n"))?.[1] ?? null;
      if (text) r.accused.push({ serial: Number(s[1] ?? r.accused.length + 1), text: val(text, L[iA]!), gender, phone, email });
    }
  }

  // 8–10: delay, property, total value.
  const i9 = item(9, /Particulars of properties/);
  const i10 = item(10, /Total value/);
  const i11 = item(11, /Inquest/);
  if (i8 >= 0) {
    const v = clean(L.slice(i8 + 1, i9 > i8 ? i9 : i8 + 2).map((x) => x.text).join(" "));
    if (v) r.delayReason = val(v, L[i8 + 1] ?? L[i8]!);
  }
  if (i9 >= 0) {
    const v = clean(L.slice(i9 + 1, i10 > i9 ? i10 : i9 + 2).map((x) => x.text).join(" "));
    if (v) r.property = val(v, L[i9 + 1] ?? L[i9]!);
  }
  if (i10 >= 0) {
    const raw = /Total value of property stolen\s*:?\s*(?:Rs\.?\s*)?([\d,]+(?:\.\d{1,2})?)/i.exec(L[i10]!.text)?.[1];
    const p = raw ? parseRupeesToMinor(raw) : null;
    if (raw && p?.ok && p.value > 0n) r.totalValue = val({ text: raw, minor: p.value }, L[i10]!);
  }

  // 12. Contents of the complaint: the statement itself, from "Brief facts" (or the first line after the court
  // heading) to "Hence the FIR."; then the registration note with the registering and investigating officers.
  const i12 = item(12, /Contents of the complaint/);
  const i13 = item(13, /Action taken/);
  if (i12 >= 0) {
    const end = i13 > i12 ? i13 : (i11 > i12 ? i11 : L.length);
    let s = idx(/Brief facts|^It is (?:submitted|stated)|^The complainant/i, i12 + 1, end);
    if (s < 0) s = idx(/^Honou?red Sir/i, i12 + 1, end) + 1 || i12 + 1;
    let e = idx(/^Hence(?: the| this)? FIR\.?/i, s, end);
    if (e < 0) e = idx(/^\(ORIGINAL COMPLAINT|^Received on\b|^-{6,}/i, s, end);
    if (e < 0) e = end;
    const body = L.slice(s, e).filter((l) => l.text && !/^IN THE COURT OF|^Honou?red Sir/i.test(l.text));
    if (body.length) {
      const offsets: number[] = [];
      let text = "";
      for (const l of body) {
        // A word or URL broken at the line end is rejoined: "https://" + "redb026.com", "aero-" + "technologyy".
        const joinTight = /(?:https?:\/\/|\/|[?&=]|[A-Za-z]-)$/.test(text) && /^[\w./#?&=%-]/.test(l.text) && !/^(?:and|or|the|to|of|for|with)\b/i.test(l.text);
        if (text) text += joinTight ? "" : " ";
        offsets.push(text.length);
        text += l.text;
      }
      r.narrative = { text, lines: body, offsets };
    }
    const reg = idx(/registered a case in Cr\.?\s*No/i, i12, end);
    if (reg >= 0) {
      const joined = clean(L.slice(reg, Math.min(end, reg + 4)).map((x) => x.text).join(" "));
      const by = /As per the above Content,\s*(?:I\.\s*)?(.*?)\s*,\s*((?:SI|Sub[- ]Inspector|Inspector|ASI|HC)(?: of Police)?)\s*,\s*registered a case/i.exec(joined);
      if (by) r.registeredBy = { name: clean(by[1]!), rank: clean(by[2]!), number: null, unit: null, at: at(L[reg]!) };
      const to = /handed over to\s*(?:Sri\.?|Smt\.?)?\s*(.*?)\s+for investigation/i.exec(joined)?.[1];
      if (to) {
        const m = /^(.*?),\s*((?:Sub[- ]Inspector|Inspector|SI|ASI|DSP|ACP)(?: of Police)?)\s*(?:,\s*(.*))?$/i.exec(to);
        r.investigatingOfficer = { name: clean(m?.[1] ?? to), rank: m?.[2] ? clean(m[2]) : null, number: null, unit: m?.[3] ? clean(m[3]) : null, at: at(L[reg]!) };
      }
    }
  }

  // 13. Action taken: the investigating officer's full name, rank and number.
  if (i13 >= 0) {
    const block = L.slice(i13, Math.min(L.length, i13 + 8));
    const nm = block.find((l) => /took up the investigation or Name\s+/i.test(l.text));
    const rk = block.find((l) => /Rank:\s*/i.test(l.text));
    const full = nm ? clean(nm.text.replace(/^.*?or Name\s+/i, "")) : null;
    const rank = rk ? /Rank:\s*(.*?)\s*No\.?\s*(\d+)?\s*$/i.exec(rk.text) : null;
    // The name column wraps: "ANKAMPALLY" / "GANGADHAR" before "2) Directed …".
    const iNm = nm ? L.indexOf(nm) : -1;
    const more = iNm >= 0 ? L.slice(iNm + 1, Math.min(L.length, iNm + 3)).filter((l, k, arr) => arr.slice(0, k + 1).every((x) => /^[A-Z][A-Z .]+$/.test(x.text))).map((l) => l.text) : [];
    if (full) {
      r.investigatingOfficer = {
        name: clean([full, ...more].join(" ")),
        rank: rank?.[1] ? clean(rank[1]) : (r.investigatingOfficer?.rank ?? null),
        number: rank?.[2] ?? null,
        unit: r.investigatingOfficer?.unit ?? null,
        at: at(nm!),
      };
    }
  }

  // 14. Officer in charge of the police station.
  const i14 = item(14, /Signature/);
  if (i14 >= 0) {
    const block = L.slice(i14, Math.min(L.length, i14 + 6));
    const nm = block.find((l) => /^Name\s+\S/i.test(l.text));
    const rk = block.find((l) => /^Rank\s+/i.test(l.text));
    const rank = rk ? /^Rank\s+(.*?)\s+No\.?\s*(\d+)?/i.exec(rk.text) : null;
    if (nm) r.officerInCharge = { name: clean(nm.text.replace(/^Name\s+/i, "")), rank: rank?.[1] ?? null, number: rank?.[2] ?? null, unit: r.policeStation?.value ?? null, at: at(nm) };
  }
  return r;
}

/** The page and line a character of the joined narrative came from. */
export function narrativeSource(n: NonNullable<CctnsFir["narrative"]>, offset: number): At {
  let i = 0;
  while (i + 1 < n.offsets.length && n.offsets[i + 1]! <= offset) i++;
  const l = n.lines[i]!;
  return { page: l.page, line: l.line };
}
