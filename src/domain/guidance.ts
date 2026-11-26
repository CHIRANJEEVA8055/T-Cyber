/**
 * Local retrieval over the approved-document library. Answers only ever quote the library: when nothing in it
 * covers a question the answer says so, and when current documents differ both are shown without choosing.
 */

export interface LibrarySection {
  id: string;
  sectionRef: string;
  heading: string;
  text: string;
  topics: string[];
}

export interface LibraryDocument {
  id: string;
  title: string;
  docNumber: string;
  issuingBody: string;
  jurisdiction: string;
  version: string;
  effectiveFrom: string;
  status: string; // CURRENT | SUPERSEDED | WITHDRAWN
  supersededById: string | null;
  /** SOP | CIRCULAR | LAW | PROVIDER | OTHER; only instructions (SOP, circular, law) can conflict with each other. */
  category?: string;
  sections: LibrarySection[];
}

export interface Passage {
  documentId: string;
  documentTitle: string;
  docNumber: string;
  issuingBody: string;
  jurisdiction: string;
  version: string;
  effectiveFrom: string;
  status: string;
  sectionId: string;
  sectionRef: string;
  heading: string;
  text: string;
  score: number;
  /** The plain count of matching words (topics 3, heading 2, text 1): the evidence a passage must have to be used. */
  raw?: number;
  /** How much of the question (by word weight) the passage matches, 0–1. Words the library never uses count against it. */
  coverage?: number;
  supersededBy: { documentId: string; version: string; effectiveFrom: string } | null;
}

export interface GuidanceResult {
  kind: "ANSWER" | "CONFLICT" | "INSUFFICIENT";
  summary: string;
  passages: Passage[];
  /** Matching sections of superseded versions, shown for history only. */
  superseded: Passage[];
}

const STOP = new Set(
  "a an the is are was were be been to of in on for with by at and or what when which who whom whose how why do does did i we you it its this that these those should shall can could would will may might must my our your me us has have had not no nor about from as if there their they them any some into before after up out than then so such very just also please tell under over two three get got need needs want know give explain describe define mean meaning simple words line lines brief briefly".split(" "),
);
/** Topics too broad to signal that two documents address the same specific rule. */
const BROAD_TOPICS = new Set(["follow-up", "provider", "evidence", "hold", "disclosure", "telecom", "scope", "subscriber", "identity"]);
const MIN_SCORE = 4;
/** A passage answers only if it matches at least this share of the question (by word weight). */
const MIN_COVERAGE = 0.5;
/** Headings every prepared document has; two documents sharing one do not address the same rule. */
const GENERIC_HEADINGS = /^(?:introduction|source description|structured summary|key facts for retrieval|full text|summary|overview|contents|case summary|page \d+)/i;

/** Forms the suffix rules cannot reach. */
const IRREGULAR: Record<string, string> = { frozen: "freez", froze: "freez", unfrozen: "unfreez", fund: "money", funds: "money", cash: "money" };

function stem(w: string): string {
  const irregular = IRREGULAR[w];
  if (irregular) return irregular;
  let s = w;
  if (s.length > 4 && s.endsWith("ies")) s = `${s.slice(0, -3)}y`;
  else if (s.length > 5 && s.endsWith("ing")) s = s.slice(0, -3);
  else if (s.length > 4 && s.endsWith("ed")) s = s.slice(0, -2);
  else if (s.length > 3 && s.endsWith("s") && !s.endsWith("ss")) s = s.slice(0, -1);
  // "freeze" and "freezing", "notice" and "noticed" meet at "freez", "notic".
  if (s.length > 4 && s.endsWith("e")) s = s.slice(0, -1);
  return s;
}

/** Whether two words are one typing slip apart (one letter added, dropped, changed, or two swapped). */
function oneSlip(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1 || a === b) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1) || (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2));
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

export function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !STOP.has(w))
      .map(stem),
  );
}

/**
 * Every section scored against the question. A word counts most in the section's subject (its first topic), then in
 * its heading and its document's title, then in its text and the document's tags. Words that few sections contain
 * (specific ones like "unfreeze" or "WhatsApp") count for more than words most sections contain ("bank", "account").
 */
export function scorePassages(question: string, library: LibraryDocument[]): Passage[] {
  const byId = new Map(library.map((d) => [d.id, d]));
  const rows = library.flatMap((d) => {
    const title = tokens(d.title);
    return d.sections.map((s) => ({ d, s, title, subject: tokens(s.topics[0] ?? ""), tags: tokens(s.topics.slice(1).join(" ")), heading: tokens(s.heading), text: tokens(s.text) }));
  });
  // A word the library never uses, one typing slip from one it does ("acount"), is read as that word.
  const vocab = new Map<string, number>();
  for (const r of rows) for (const set of [r.subject, r.tags, r.heading, r.text, r.title]) for (const t of set) vocab.set(t, (vocab.get(t) ?? 0) + 1);
  const q = new Set(
    [...tokens(question)].map((t) => {
      if (vocab.has(t) || t.length < 5) return t;
      let best: string | null = null;
      for (const [v, c] of vocab) if (v[0] === t[0] && oneSlip(t, v) && (!best || c > vocab.get(best)!)) best = v;
      return best ?? t;
    }),
  );
  const n = rows.length || 1;
  const weight = new Map<string, number>();
  const idfs: number[] = [];
  for (const t of q) {
    const df = rows.filter((r) => r.subject.has(t) || r.heading.has(t) || r.text.has(t) || r.title.has(t)).length;
    const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
    weight.set(t, idf);
    if (df) idfs.push(idf);
  }
  const mean = idfs.length ? idfs.reduce((a, b) => a + b, 0) / idfs.length : 1;
  for (const [t, w] of weight) weight.set(t, Math.min(1.8, Math.max(0.4, w / (mean || 1))));
  const whole = [...weight.values()].reduce((a, b) => a + b, 0) || 1;
  const out: Passage[] = [];
  for (const r of rows) {
    const d = r.d;
    const s = r.s;
    const successor = d.supersededById ? byId.get(d.supersededById) : undefined;
    let score = 0;
    let raw = 0;
    let covered = 0;
    for (const t of q) {
      score += (weight.get(t) ?? 1) * ((r.subject.has(t) ? 3 : 0) + (r.heading.has(t) ? 2 : 0) + (r.title.has(t) ? 1.5 : 0) + (r.text.has(t) ? 1 : 0) + (r.tags.has(t) ? 0.5 : 0));
      raw += (r.subject.has(t) || r.tags.has(t) ? 3 : 0) + (r.heading.has(t) ? 2 : 0) + (r.text.has(t) ? 1 : 0);
      if (r.subject.has(t) || r.tags.has(t) || r.heading.has(t) || r.text.has(t) || r.title.has(t)) covered += weight.get(t) ?? 1;
    }
    out.push({
      documentId: d.id,
      documentTitle: d.title,
      docNumber: d.docNumber,
      issuingBody: d.issuingBody,
      jurisdiction: d.jurisdiction,
      version: d.version,
      effectiveFrom: d.effectiveFrom,
      status: d.status,
      sectionId: s.id,
      sectionRef: s.sectionRef,
      heading: s.heading,
      text: s.text,
      score: Math.round(score * 10) / 10,
      raw,
      coverage: Math.round((covered / whole) * 100) / 100,
      supersededBy: successor ? { documentId: successor.id, version: successor.version, effectiveFrom: successor.effectiveFrom } : null,
    });
  }
  return out.sort((a, b) => b.score - a.score || (b.raw ?? 0) - (a.raw ?? 0));
}

export function answerFromLibrary(question: string, library: LibraryDocument[]): GuidanceResult {
  const scored = scorePassages(question, library);
  // The plain word count and the share of the question matched decide whether a passage can answer at all (a passage
  // that shares only "Hyderabad" with "the weather in Hyderabad today" cannot); the weighted score ranks them.
  const enough = (p: Passage) => (p.raw ?? p.score) >= MIN_SCORE && (p.coverage ?? 1) >= MIN_COVERAGE;
  const top = scored.find(enough)?.score ?? 0;
  const relevant = scored.filter((p) => enough(p) && p.score >= top * 0.6);
  const current = relevant.filter((p) => p.status === "CURRENT");
  const superseded = relevant.filter((p) => p.status === "SUPERSEDED");

  if (!current.length) {
    return {
      kind: "INSUFFICIENT",
      summary: superseded.length
        ? "Only a superseded version in the library addresses this, so it is no longer in force. The assistant does not answer from general knowledge; ask your supervisor or consult the official source."
        : "The approved library does not cover this, so the assistant cannot answer it from the approved sources. It does not answer from general knowledge; ask your supervisor or consult the official source.",
      passages: [],
      superseded,
    };
  }

  // A section's first topic is its subject. Two documents conflict only when they set a rule on the same subject;
  // passages that merely mention the same thing (an acknowledgement, a bank) do not.
  const subjectOf = (p: Passage) => library.find((d) => d.id === p.documentId)?.sections.find((s) => s.id === p.sectionId)?.topics[0];
  const instruction = (p: Passage) => ["SOP", "CIRCULAR", "LAW", undefined].includes(library.find((d) => d.id === p.documentId)?.category);
  const first = current[0]!;
  const subject = subjectOf(first);
  const generic = !subject || BROAD_TOPICS.has(subject) || GENERIC_HEADINGS.test(subject);
  const rival = !generic && instruction(first) ? current.find((p) => p.documentId !== first.documentId && instruction(p) && subjectOf(p) === subject) : undefined;
  if (rival) {
    return {
      kind: "CONFLICT",
      summary: "Current documents in the library differ on this. The assistant does not decide which applies; read both and check with your supervisor before acting.",
      passages: [first, rival],
      superseded,
    };
  }
  return {
    kind: "ANSWER",
    summary: `${first.documentTitle}, ${first.sectionRef} (version ${first.version}) addresses this. The passage is quoted below; nothing has been added to it.`,
    passages: current.slice(0, 3),
    superseded,
  };
}

/**
 * Police shorthand and slips in a question, written out so they meet the library's words: "MO" is the modus
 * operandi; "IPS" beside BNS or a section is the IPC (not IP addresses); asking for a classification or the sections
 * is asking for the offence and its provisions.
 */
export function expandQuestion(question: string): string {
  const q = question;
  const extra: string[] = [];
  if (/\bm\.?\s?o\.?\b|\bmo-?wise\b/i.test(q)) extra.push("modus operandi");
  const legal = /\b(?:bns|bnss|bsa|ipc|crpc|sections?|act|classification|classifications|punishment|offen[cs]e)\b/i.test(q);
  let text = q;
  if (legal) {
    text = text.replace(/\bips\b/gi, "ipc");
    extra.push("offence section act punishment");
  }
  if (/\b(?:types?|kinds?|categories)\b/i.test(q) && /\bcyber ?crimes?\b/i.test(q)) extra.push("modus operandi fraud");
  return extra.length ? `${text} ${extra.join(" ")}` : text;
}

/** Documents about operating the CrimeOS software: right for questions about it, not for how to investigate. */
const SOFTWARE_DOC = /crimeos|crime os/i;
const ASKS_SOFTWARE = /\b(?:crimeos|crime os|handle type|case entry|log ?in|sign ?up|otp|password|screen|button|unit and police station)\b/i;

/**
 * The passages a written answer is based on: the best ones across documents (at most `perDoc` from one document, so
 * one long document cannot crowd out the rest), with software how-tos held back unless the question is about them.
 */
export function rankForAnswer(question: string, library: LibraryDocument[], opts: { limit?: number; perDoc?: number } = {}): Passage[] {
  const limit = opts.limit ?? 10;
  const perDoc = opts.perDoc ?? 3;
  const asksSoftware = ASKS_SOFTWARE.test(question);
  const scored = scorePassages(expandQuestion(question), library.filter((d) => d.status === "CURRENT"))
    .filter((p) => (p.raw ?? 0) >= 1)
    .map((p) => ({ ...p, score: !asksSoftware && SOFTWARE_DOC.test(p.documentTitle) ? Math.round(p.score * 4) / 10 : p.score }))
    .sort((a, b) => b.score - a.score || (b.raw ?? 0) - (a.raw ?? 0));
  const out: Passage[] = [];
  const count = new Map<string, number>();
  for (const p of scored) {
    if (out.length >= limit) break;
    const n = count.get(p.documentId) ?? 0;
    if (n >= perDoc) continue;
    count.set(p.documentId, n + 1);
    out.push(p);
  }
  return out;
}
