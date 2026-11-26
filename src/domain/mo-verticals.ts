/**
 * The station's investigation verticals ("Type of MOs", data/MO.docx, also in the knowledge base as MO.docx.md) and
 * how a complaint is placed in one.
 *
 * The facts decide: each vertical and each kind of fraud under it has plain signs (an OTP shared, a franchise fee, a
 * nude video call), and the vertical with the most distinct signs in the complaint is the one shown, with the signs it
 * rests on. Only when the facts show none does a stated section decide, and then only a section whose own title names
 * a class (IT Act 66C is "identity theft"); cheating and personation sections (BNS 318, 319; IT Act 66D) are in almost
 * every fraud FIR and say nothing about the MO. Nothing here adds or suggests a section.
 */

export type MoKey = "INVESTMENT" | "ADVERTISEMENT" | "JOB" | "BUSINESS" | "OTP" | "SOCIAL_MEDIA" | "MISC";
type Sign = readonly [RegExp, string];
interface Vertical {
  key: MoKey;
  label: string;
  /** What the MO table lists under the vertical, as written there. */
  covers: string;
  /** Signs of the vertical as a whole, which point to no one kind under it. */
  signs: readonly Sign[];
  kinds: readonly { label: string; signs: readonly Sign[] }[];
}

export const MO_VERTICALS: readonly Vertical[] = [
  {
    key: "INVESTMENT",
    label: "Investment Frauds",
    covers: "Investment, part-time, work-from-home and trading frauds",
    signs: [
      [/\binvest(?:ment|ments|ed|ing|or|ors)?\b/i, "investment"],
      [/\b(?:high|assured|guaranteed|daily|good) (?:returns|profits?)\b|\breturns? on (?:the )?investment\b|\bprofits? (?:were |was )?shown\b/i, "promised returns"],
      [/\b(?:could not|unable to|not able to|cannot) withdraw|\bwithdraw(?:al)? (?:was )?(?:blocked|refused|denied)|\b(?:tax|fee|charges?) (?:to|before|for) withdraw/i, "withdrawal refused"],
    ],
    kinds: [
      {
        label: "Trading",
        signs: [
          [/\btrading\b|\btrader\b/i, "trading"],
          [/\bshare market|\bstock(?:s| market)?\b|\bequity\b|\bnifty\b|\bsensex\b/i, "share market"],
          [/\bIPO\b|\bblock trades?\b|\bupper circuit\b|\binstitutional account\b|\bOTC\b/i, "IPO / block trades"],
          [/\bcrypto|\bUSDT\b|\bbitcoin\b|\bforex\b/i, "crypto / forex"],
          [/\bdemat\b/i, "demat"],
        ],
      },
      {
        label: "Part Time / Work From Home",
        signs: [
          [/\bpart[- ]?time\b/i, "part-time work"],
          [/\bwork(?:ing)? from home\b|\bWFH\b/i, "work from home"],
          [/\bprepaid tasks?\b|\btask groups?\b|\b(?:complete|completing|simple|online) tasks?\b|\bmerchant tasks?\b/i, "prepaid tasks"],
          [/\b(?:liking|like|subscrib\w*|rating|rate|review\w*) (?:youtube |the |hotel |google )?(?:videos?|hotels?|products?|restaurants?|channels?|maps?)\b|\bcommission for\b/i, "paid for likes or ratings"],
        ],
      },
    ],
  },
  {
    key: "ADVERTISEMENT",
    label: "Advertisement Fraud",
    covers: "OLX and marketing frauds",
    signs: [],
    kinds: [
      {
        label: "OLX",
        signs: [
          [/\bOLX\b|\bquikr\b|\bmarketplace\b|\bcar ?dekho\b|\bcars24\b/i, "OLX / marketplace"],
          [/\b(?:army|military|CISF|BSF|CRPF|defen[cs]e) (?:officer|personnel|man|jawan)\b|\bposing as an? (?:army|military)/i, "seller posing as army personnel"],
          [/\bsecond[- ]hand\b|\bused (?:car|bike|scooter|furniture|phone)\b|\bput (?:up )?for sale\b|\bselling (?:his|her|a|an) (?:car|bike|scooter|phone|sofa)/i, "item for sale"],
        ],
      },
      {
        label: "Marketing",
        signs: [
          [/\badvertis\w*|\b(?:posted|placed|saw) an? ad\b|\bsponsored (?:ad|post)\b/i, "advertisement"],
          [/\bmarketing\b|\bpromotion (?:of|for) (?:his|her|their|the) (?:business|product|shop)/i, "marketing"],
        ],
      },
    ],
  },
  {
    key: "JOB",
    label: "Job Frauds",
    covers: "Job frauds",
    signs: [
      [/\bjob offer\b|\boffer letter\b|\bappointment letter\b|\bjoining letter\b/i, "job offer"],
      [/\brecruit\w*|\bvacanc(?:y|ies)\b|\bhiring\b/i, "recruitment"],
      [/\b(?:registration|training|processing|security|uniform|interview) (?:fee|charges?|deposit)\b/i, "fee for the job"],
      [/\binterview\b/i, "interview"],
      [/\bjob portal\b|\bnaukri\b|\bplacement\b|\bjob consultancy\b/i, "job portal"],
    ],
    kinds: [],
  },
  {
    key: "BUSINESS",
    label: "Business Frauds",
    covers: "Business and franchise frauds",
    signs: [],
    kinds: [
      { label: "Franchise", signs: [[/\bfranchis\w*/i, "franchise"], [/\bdealership\b|\bdistributorship\b|\bdealer ?ship\b|\bauthori[sz]ed dealer\b/i, "dealership"]] },
      {
        label: "Business",
        signs: [
          [/\bbulk order\b|\bsupply order\b|\bpurchase order\b|\braw materials?\b|\btender\b/i, "business order"],
          [/\bbusiness (?:deal|partner|partnership|proposal|loan)\b|\bjoint venture\b/i, "business deal"],
        ],
      },
    ],
  },
  {
    key: "OTP",
    label: "OTP Frauds",
    covers: "OTP, customer-care, KYC, reward-points and APK-file frauds",
    signs: [],
    kinds: [
      { label: "OTP", signs: [[/\bOTPs?\b|\bone[- ]time password/i, "OTP shared"]] },
      { label: "Customer Care", signs: [[/\bcustomer (?:care|support|service)\b|\bhelpline number\b|\btoll[- ]free\b/i, "customer care"], [/\brefund (?:process|request|of (?:the|his|her) (?:order|amount))\b/i, "refund offered"]] },
      { label: "KYC", signs: [[/\bKYC\b/i, "KYC update"], [/\b(?:account|card|SIM|PAN) (?:will be |would be )?(?:blocked|suspended|deactivated)\b|\bPAN (?:update|link)/i, "account to be blocked"]] },
      { label: "Reward Points", signs: [[/\breward points?\b|\bcredit card points\b|\bloyalty points\b/i, "reward points"], [/\bredeem\w*/i, "redeem"]] },
      {
        label: "APK File",
        signs: [
          [/\.apk\b|\bAPK\b/i, "APK file"],
          [/\banydesk\b|\bteamviewer\b|\bquick ?support\b|\bscreen[- ]?shar\w*|\bremote access\b/i, "remote-access app"],
        ],
      },
    ],
  },
  {
    key: "SOCIAL_MEDIA",
    label: "Social Media Frauds",
    covers: "Phishing, emails, sextortion / honey trap, dating, WhatsApp DP, hacking, data theft, identity theft, ransomware, political and communal cases",
    signs: [
      [/\babusive\b|\bobscene\b|\bvulgar\b|\bfilthy\b|\bdefamatory\b|\btroll\w*|\bderogatory\b/i, "abusive or obscene posts"],
      [/\b(?:instagram|facebook|twitter|youtube|snapchat|social media) (?:account|page|profile|post|posts|handle|id)\b/i, "social-media account"],
    ],
    kinds: [
      { label: "Phishing", signs: [[/\bphishing\b/i, "phishing"], [/\bfake (?:link|website|web ?page|login page)\b|\bclicked (?:on )?(?:a|the|that) link\b|\bmalicious link\b/i, "fake link"]] },
      {
        label: "Emails",
        signs: [
          [/\bspoof\w*/i, "spoofed email"],
          [/\blook-?alike\b|\bsimilar(?:-looking)? (?:domain|e-?mail)/i, "look-alike address"],
          [/\bfake e-?mails?\b|\be-?mail (?:id |account )?(?:was |had been )?(?:hacked|compromised)/i, "fake email"],
          [/\baccount details (?:had been |have been |were |was )?changed|\bchanged (?:the )?(?:bank )?account details|\bnew (?:bank )?account details\b/i, "bank details changed by email"],
          [/\bbusiness email\b/i, "business email"],
        ],
      },
      {
        label: "Sextortion / Honey Trap",
        signs: [
          [/\bsextort\w*|\bhoney ?trap/i, "sextortion"],
          [/\bnude\b|\bnaked\b|\bintimate\b|\bobscene video\b/i, "nude video"],
          [/\bvideo call/i, "video call"],
          [/\bmorph\w*/i, "morphed images"],
        ],
      },
      { label: "Dating", signs: [[/\bdating\b|\btinder\b|\bbumble\b|\bhinge\b|\bhappn\b/i, "dating app"], [/\bbefriend\w*|\bfriendship\b|\bromantic\b/i, "friendship online"]] },
      {
        label: "WhatsApp DP",
        signs: [
          [/\bdisplay picture\b|\bDP\b|\bprofile (?:picture|photo)\b/i, "display picture"],
          [/\b(?:collector|commissioner|MLA|MP|minister|director|CEO|MD|chairman|boss|superior|senior officer)'?s? (?:photo|picture|name|image)\b/i, "a senior's photo"],
          [/\bgift cards?\b|\bvouchers?\b/i, "gift cards asked for"],
        ],
      },
      {
        label: "Hacking",
        signs: [
          [/\bhack\w*/i, "hacked"],
          [/\b(?:changed|reset) (?:the |his |her )?password\b|\brecovery (?:e-?mail|number|phone)\b|\bunauthori[sz]ed (?:access|login)/i, "account taken over"],
        ],
      },
      { label: "Data Theft", signs: [[/\bdata theft\b|\bdata (?:was |were )?(?:stolen|leaked)\b|\b(?:customer|client) (?:data|database)\b/i, "data stolen"]] },
      {
        label: "Identity Theft",
        signs: [
          [/\bidentity theft\b|\bfake (?:profile|account|id)s? (?:in|with|using) (?:the )?(?:his|her|my|complainant'?s?) (?:name|photos?)|\busing (?:his|her|my) (?:photos?|name|identity)\b/i, "fake profile in the complainant's name"],
          [/\b(?:aadhaar|PAN|documents?) (?:was |were )?misused\b|\bmisused (?:his|her|my) (?:aadhaar|PAN|documents?)/i, "documents misused"],
        ],
      },
      { label: "Ransomware", signs: [[/\bransomware\b|\bransom note\b/i, "ransomware"], [/\bencrypt\w*|\bdecrypt\w*/i, "files encrypted"]] },
      {
        label: "Political and Communal",
        signs: [
          [/\bcommunal\b|\breligio\w*|\bcaste\b|\bhurt\w* (?:the )?(?:religious )?sentiments/i, "communal content"],
          [/\bpolitical\b|\bpolitician\b|\bparty leader\b/i, "political content"],
        ],
      },
    ],
  },
  {
    key: "MISC",
    label: "Miscellaneous",
    covers: "Lottery, insurance, gift, loan, loan-app, matrimonial and visa frauds",
    signs: [],
    kinds: [
      { label: "Lottery", signs: [[/\blotter(?:y|ies)\b/i, "lottery"], [/\blucky draw\b|\bKBC\b|\bkaun banega\b|\bwon (?:a|the) (?:prize|car|draw)\b|\bprize money\b/i, "prize won"]] },
      { label: "Insurance", signs: [[/\binsurance\b|\bpolicy (?:bonus|maturity|lapsed?|renewal)\b|\bIRDA/i, "insurance policy"]] },
      { label: "Gift", signs: [[/\bgift (?:parcel|package|box)\b|\bsent (?:him |her )?(?:a|an expensive) gift\b|\b(?:customs|clearance) (?:duty|charges?|fee) (?:on|for) (?:the )?(?:gift|parcel)\b/i, "gift parcel"]] },
      { label: "Loan", signs: [[/\bloans?\b/i, "loan"]] },
      {
        label: "Loan App",
        signs: [
          [/\bloan app\w*|\blending app\w*/i, "loan app"],
          [/\binstant loan\b|\bquick loan\b|\bpre-?approved loan\b/i, "instant loan"],
          [/\brepay\w*|\brecovery agents?\b|\b(?:sent|shared) to (?:her|his|their|the complainant'?s?) contacts\b/i, "harassment to repay"],
        ],
      },
      { label: "Matrimonial", signs: [[/\bmatrimon\w*|\bshaadi\b/i, "matrimonial site"], [/\b(?:promise[sd]? (?:of )?|proposal of |to )marr(?:y|iage)\b|\bmarriage proposal\b/i, "promise of marriage"]] },
      { label: "Visa", signs: [[/\bvisa\b/i, "visa"], [/\bwork permit\b|\bimmigration\b/i, "work permit"]] },
    ],
  },
] as const;

/** Frauds the MO table does not name, filed under Miscellaneous with the sign that placed them there. */
const UNLISTED: readonly Sign[] = [
  [/\bdigital arrest\b/i, "digital arrest"],
  [/\bcourier\b|\bparcel\b.*\b(?:drugs|narcotics|customs)\b/i, "courier-parcel scam"],
];

export interface MoClass {
  vertical: { key: MoKey; label: string } | null;
  /** The kind of fraud under the vertical, as the MO table names it; null when the facts show only the vertical. */
  subtype: string | null;
  /**
   * OFFICER: chosen on the case; FIR: stated in the FIR; MODEL: decided by the local model from the brief and facts;
   * FACTS / SECTIONS: read by the rules; DEFAULT: nothing pointed elsewhere, so Miscellaneous; NONE: not classified.
   */
  basis: "OFFICER" | "FIR" | "MODEL" | "FACTS" | "SECTIONS" | "DEFAULT" | "NONE";
  /** For a stored decision: what decided it, in one sentence. */
  reason?: string | null;
  /** The signs in the complaint (or the stated section) that placed it. */
  signs: string[];
}

// ───────────────────────────── stated sections ─────────────────────────────────────────────────────────────────

const ACT = /\b(BNSS|BNS|IPC|Cr\.?P\.?C|BSA|I\.?T\.?\s*Act(?:,?\s*2000)?|ITA(?:[-\s]?\d{4})*|Information Technology Act(?:,?\s*2000)?|BUDS\s*Act|Banning of Unregulated Deposit Schemes Act(?:,?\s*2019)?)\b/gi;
const SECTION = /\b\d{1,3}(?:-?[A-Z])?(?:\(\s*\w{1,3}\s*\))*/g;

function actOf(raw: string): string {
  if (/^BNSS$/i.test(raw)) return "BNSS";
  if (/^BNS$/i.test(raw)) return "BNS";
  if (/^IPC$/i.test(raw)) return "IPC";
  if (/^I\.?T|^ITA|^Information/i.test(raw)) return "IT";
  if (/BUDS|Unregulated/i.test(raw)) return "BUDS";
  return raw.toUpperCase();
}

/** "318(4),319(2) BNS, 66-D ITA-2000-2008" and "BNS 318(4); IT Act 66D" → [{act:"BNS", section:"318"}, …]. */
export function statedSections(text: string): { act: string; section: string }[] {
  type Tok = { at: number; act?: string; section?: string };
  const toks: Tok[] = [];
  const actSpans: [number, number][] = [];
  for (const m of text.matchAll(ACT)) {
    toks.push({ at: m.index, act: actOf(m[1]!) });
    actSpans.push([m.index, m.index + m[0].length]);
  }
  for (const m of text.matchAll(SECTION)) {
    if (actSpans.some(([a, b]) => m.index >= a && m.index < b)) continue; // the year in "ITA-2000-2008"
    toks.push({ at: m.index, section: m[0].replace(/\(.*$/, "").replace(/-/g, "").toUpperCase() });
  }
  toks.sort((a, b) => a.at - b.at);
  const out: { act: string; section: string }[] = [];
  const actFirst = toks[0]?.act !== undefined;
  if (actFirst) {
    let act = "";
    for (const t of toks) {
      if (t.act) act = t.act;
      else if (act) out.push({ act, section: t.section! });
    }
  } else {
    let pending: string[] = [];
    for (const t of toks) {
      if (t.section) pending.push(t.section);
      else {
        for (const s of pending) out.push({ act: t.act!, section: s });
        pending = [];
      }
    }
  }
  // An act named without sections (the BUDS Act) still counts.
  for (const t of toks) if (t.act === "BUDS" && !out.some((o) => o.act === "BUDS")) out.push({ act: "BUDS", section: "" });
  return out;
}

const SECTION_CLASS: readonly { act: string; sections: readonly string[]; key: MoKey; subtype: string | null; title: string }[] = [
  { act: "IT", sections: ["66C"], key: "SOCIAL_MEDIA", subtype: "Identity Theft", title: "identity theft" },
  { act: "IT", sections: ["66", "43"], key: "SOCIAL_MEDIA", subtype: "Hacking", title: "computer-related offences" },
  { act: "IT", sections: ["66E", "67", "67A"], key: "SOCIAL_MEDIA", subtype: null, title: "private or obscene material online" },
  { act: "BNS", sections: ["196", "299"], key: "SOCIAL_MEDIA", subtype: "Political and Communal", title: "enmity between groups / religious feelings" },
  { act: "IPC", sections: ["153A", "295A"], key: "SOCIAL_MEDIA", subtype: "Political and Communal", title: "enmity between groups / religious feelings" },
  { act: "BUDS", sections: [""], key: "INVESTMENT", subtype: null, title: "unregulated deposit schemes" },
];

/** The vertical a stated section points to by its own title, or null (cheating and personation sections do not). */
export function sectionVertical(sections: string): { key: MoKey; subtype: string | null; sign: string } | null {
  for (const s of statedSections(sections)) {
    const hit = SECTION_CLASS.find((c) => c.act === s.act && c.sections.includes(s.section));
    if (hit) return { key: hit.key, subtype: hit.subtype, sign: `${s.act === "IT" ? "IT Act" : s.act === "BUDS" ? "BUDS Act" : s.act}${s.section ? ` ${s.section}` : ""} (${hit.title})` };
  }
  return null;
}

// ───────────────────────────── classification ──────────────────────────────────────────────────────────────────

export function classifyMo(input: { facts: string; sections?: string | null }): MoClass {
  const text = input.facts ?? "";
  let best: { v: Vertical; score: number; subtype: string | null; signs: string[] } | null = null;
  for (const v of MO_VERTICALS) {
    const general = v.signs.filter(([re]) => re.test(text)).map(([, s]) => s);
    const kinds = v.kinds.map((k) => ({ label: k.label, signs: k.signs.filter(([re]) => re.test(text)).map(([, s]) => s) }));
    const topKind = kinds.reduce<(typeof kinds)[number] | null>((a, k) => (k.signs.length > (a?.signs.length ?? 0) ? k : a), null);
    const signs = [...new Set([...(topKind?.signs ?? []), ...kinds.filter((k) => k !== topKind).flatMap((k) => k.signs), ...general])];
    const score = signs.length;
    // Ties go to the vertical listed first in the MO table.
    if (score > 0 && (!best || score > best.score)) best = { v, score, subtype: topKind?.label ?? null, signs };
  }
  if (best) return { vertical: { key: best.v.key, label: best.v.label }, subtype: best.subtype, basis: "FACTS", signs: best.signs };
  const unlisted = UNLISTED.filter(([re]) => re.test(text)).map(([, s]) => s);
  if (unlisted.length) return { vertical: { key: "MISC", label: "Miscellaneous" }, subtype: null, basis: "FACTS", signs: unlisted };
  const bySection = input.sections ? sectionVertical(input.sections) : null;
  if (bySection) {
    const v = MO_VERTICALS.find((x) => x.key === bySection.key)!;
    return { vertical: { key: v.key, label: v.label }, subtype: bySection.subtype, basis: "SECTIONS", signs: [bySection.sign] };
  }
  return { vertical: null, subtype: null, basis: "NONE", signs: [] };
}

export function verticalByKey(key: string | null | undefined): Vertical | null {
  return MO_VERTICALS.find((v) => v.key === key) ?? null;
}

const STORED = ["OFFICER", "FIR", "MODEL", "FACTS", "SECTIONS", "DEFAULT"] as const;

/**
 * A case's vertical: as decided when the FIR was read (stated in it, or by the local model), or as an officer set it.
 * A case not classified yet is read from its facts by the rules until it is.
 */
export function caseMo(c: { moVertical?: string | null; moSubtype?: string | null; moBasis?: string | null; moReason?: string | null; narrative?: string | null; legalSections?: string | null }): MoClass {
  const set = verticalByKey(c.moVertical);
  if (set) {
    const basis = (STORED as readonly string[]).includes(c.moBasis ?? "") ? (c.moBasis as MoClass["basis"]) : "OFFICER";
    return { vertical: { key: set.key, label: set.label }, subtype: set.kinds.some((k) => k.label === c.moSubtype) ? c.moSubtype! : null, basis, signs: [], reason: c.moReason ?? null };
  }
  return classifyMo({ facts: c.narrative ?? "", sections: c.legalSections });
}

/** How a vertical was decided, in a few words ("classified by the local model", "as the FIR states it"). */
export function moBasisText(c: MoClass): string {
  switch (c.basis) {
    case "OFFICER":
      return "set by an officer";
    case "FIR":
      return "as the FIR states it";
    case "MODEL":
      return "classified by the local model";
    case "SECTIONS":
      return c.reason ? "read by the rules from the stated sections" : `from the stated ${c.signs[0]}`;
    case "FACTS":
      return c.reason ? "read by the rules from the facts" : `read from the facts (${c.signs.slice(0, 2).join(", ")})`;
    case "DEFAULT":
      return "nothing in the FIR pointed elsewhere";
    default:
      return "not classified yet";
  }
}

/** One line for a case page or brief: "Investment Frauds · Trading — from the facts: trading, IPO / block trades". */
export function moLine(c: MoClass): string {
  if (!c.vertical) return "Not clear from the FIR: choose the vertical";
  const head = `${c.vertical.label}${c.subtype ? ` · ${c.subtype}` : ""}`;
  if (c.basis === "OFFICER") return `${head}, set by the officer`;
  if (c.reason) return `${head}, ${moBasisText(c)}: ${c.reason}`;
  return c.basis === "SECTIONS" ? `${head}, from the stated section ${c.signs[0]}` : `${head}, from the facts: ${c.signs.slice(0, 3).join(", ")}`;
}

// ───────────────────────────── what the FIR states about its MO ─────────────────────────────────────────────────

const STATED = /^\s*(?:\d+[.)]\s*)?((?:sub[- ]?)?category(?: of (?:the )?(?:complaint|crime|offence|fraud))?|modus operandi|m\.\s?o\.|type of (?:fraud|crime|offence|cyber ?crime)|nature of (?:fraud|crime|offence)|fraud type|crime type)\s*[:\-–]\s*(\S.{1,200})$/i;

/** The MO or category the FIR states in its own words ("Category: …", "Modus Operandi: …"), or null when it states none. */
export function findStatedMo(text: string): { lines: string[]; text: string } | null {
  const hits = text
    .split(/\r?\n/)
    .map((l) => ({ line: l.trim(), m: STATED.exec(l) }))
    .filter((x): x is { line: string; m: RegExpExecArray } => !!x.m && !/^(?:nil|none|not (?:known|stated)|-+)$/i.test(x.m[2]!.trim()));
  return hits.length ? { lines: hits.map((h) => h.line), text: hits.map((h) => h.m[2]!.trim()).join("; ") } : null;
}
