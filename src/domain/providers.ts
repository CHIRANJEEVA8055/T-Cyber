/**
 * Who holds the records about an identifier: the bank behind an IFSC, the company that runs a mail service or a
 * platform. Used to route requests for real (non-demonstration) cases through the nodal officer list. Only facts that
 * are certain are encoded: a company domain's mail host, an unknown IFSC code or an unknown platform return nothing,
 * and the officer records it instead of the assistant guessing.
 */

/** The first four letters of an IFSC identify the bank (RBI's bank codes). Only codes known with certainty. */
const IFSC_BANKS: Record<string, string> = {
  SBIN: "State Bank of India",
  HDFC: "HDFC Bank",
  ICIC: "ICICI Bank",
  UTIB: "Axis Bank",
  KKBK: "Kotak Mahindra Bank",
  PUNB: "Punjab National Bank",
  BARB: "Bank of Baroda",
  CNRB: "Canara Bank",
  UBIN: "Union Bank of India",
  IDIB: "Indian Bank",
  IOBA: "Indian Overseas Bank",
  BKID: "Bank of India",
  MAHB: "Bank of Maharashtra",
  UCBA: "UCO Bank",
  CBIN: "Central Bank of India",
  PSIB: "Punjab & Sind Bank",
  YESB: "Yes Bank",
  INDB: "IndusInd Bank",
  IDFB: "IDFC First Bank",
  IBKL: "IDBI Bank",
  FDRL: "Federal Bank",
  RATN: "RBL Bank",
  DCBL: "DCB Bank",
  KARB: "Karnataka Bank",
  KVBL: "Karur Vysya Bank",
  CIUB: "City Union Bank",
  SIBL: "South Indian Bank",
  TMBL: "Tamilnad Mercantile Bank",
  DLXB: "Dhanlaxmi Bank",
  JAKA: "Jammu & Kashmir Bank",
  BDBL: "Bandhan Bank",
  CSBK: "CSB Bank",
  AUBL: "AU Small Finance Bank",
  ESFB: "Equitas Small Finance Bank",
  UJVN: "Ujjivan Small Finance Bank",
  JSFB: "Jana Small Finance Bank",
  SURY: "Suryoday Small Finance Bank",
  UTKS: "Utkarsh Small Finance Bank",
  ESMF: "ESAF Small Finance Bank",
  FINO: "Fino Payments Bank",
  AIRP: "Airtel Payments Bank",
  PYTM: "Paytm Payments Bank",
  IPOS: "India Post Payments Bank",
  JIOP: "Jio Payments Bank",
  NSPB: "NSDL Payments Bank",
  DBSS: "DBS Bank India",
  SCBL: "Standard Chartered Bank",
  CITI: "Citibank",
  HSBC: "HSBC",
  DEUT: "Deutsche Bank",
  SVCB: "SVC Co-operative Bank",
  COSB: "Cosmos Co-operative Bank",
  SRCB: "Saraswat Co-operative Bank",
  TJSB: "TJSB Sahakari Bank",
  APGB: "Andhra Pragathi Grameena Bank",
  APGV: "Andhra Pradesh Grameena Vikas Bank",
};

/** The bank an IFSC (four letters, a zero, six characters) belongs to, or null when the code is unknown. */
export function bankFromIfsc(ifsc: string | null | undefined): string | null {
  const v = (ifsc ?? "").trim().toUpperCase();
  if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(v)) return null;
  return IFSC_BANKS[v.slice(0, 4)] ?? null;
}

/**
 * A provider that answers law-enforcement requests, with the names it goes by on the nodal officer list (most specific
 * first), the kinds of entry to prefer there, and the email domains its own addresses use (to skip mistyped ones).
 */
export interface Provider {
  name: string;
  keys: string[];
  types: string[];
  domains: string[];
}

const MAIL = ["Email Platforms", "Website", "Social Media Provider", "OTT", "TSP"];
const SOCIAL = ["Social Media Provider", "Social Media Platforms", "Messenging Platforms", "OTT", "Website", "TSP"];

export const PROVIDERS = {
  google: { name: "Google", keys: ["google india", "google", "google for yt duo hangout messaging services"], types: MAIL, domains: ["google.com"] },
  microsoft: { name: "Microsoft", keys: ["microsoft india", "hotmail microsoft corporation", "hotmail microsoft", "microsoft"], types: MAIL, domains: ["microsoft.com"] },
  yahoo: { name: "Yahoo", keys: ["yahoo india", "yahoo"], types: MAIL, domains: ["yahoo-inc.com", "yahooinc.com", "oath.com", "yahoo.com"] },
  rediff: { name: "Rediff", keys: ["rediffmail", "rediff"], types: MAIL, domains: ["rediff.co.in", "rediff.com"] },
  twitter: { name: "X (Twitter)", keys: ["twitter", "x corp"], types: SOCIAL, domains: ["twitter.com", "x.com"] },
  telegram: { name: "Telegram", keys: ["telegram"], types: SOCIAL, domains: ["telegram.org"] },
  whatsapp: { name: "WhatsApp", keys: ["whatsapp"], types: SOCIAL, domains: ["whatsapp.com", "fb.com", "meta.com"] },
  facebook: { name: "Facebook (Meta)", keys: ["facebook", "1 instagram and messenger"], types: SOCIAL, domains: ["fb.com", "meta.com"] },
  instagram: { name: "Instagram (Meta)", keys: ["instagram", "1 instagram and messenger"], types: SOCIAL, domains: ["fb.com", "meta.com"] },
  npci: { name: "NPCI", keys: ["npci"], types: ["ISP", "Bank", "Government Bodies", "Other"], domains: ["npci.org.in"] },
  godaddy: { name: "GoDaddy", keys: ["godaddy"], types: ["Domain Registrars", "Website"], domains: ["godaddy.com"] },
  hostinger: { name: "Hostinger", keys: ["hostinger"], types: ["Domain Registrars", "Website"], domains: ["hostinger.com"] },
  mailcom: { name: "mail.com", keys: ["mail com", "mailcom"], types: MAIL, domains: ["mail.com"] },
} satisfies Record<string, Provider>;

/** The key a provider's name is matched by on the nodal list: "Ujjivan Small Finance\nBank Ltd." → "ujjivan small finance bank". */
export function nodalKey(name: string): string {
  return name
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\b(ltd|limited|pvt|private|inc|llp|the|co)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** A bank as a provider: looked up on the nodal list by its name, preferring the bank entries. */
export function bankProvider(bank: string): Provider {
  const key = nodalKey(bank);
  const and = nodalKey(bank.replace(/&/g, " and "));
  return { name: bank, keys: [...new Set([key, and])], types: ["Bank", "Credit card", "Wallet & PPI"], domains: [] };
}

const MAIL_DOMAINS: Record<string, keyof typeof PROVIDERS> = {
  "gmail.com": "google",
  "googlemail.com": "google",
  "yahoo.com": "yahoo",
  "yahoo.co.in": "yahoo",
  "yahoo.in": "yahoo",
  "ymail.com": "yahoo",
  "rocketmail.com": "yahoo",
  "outlook.com": "microsoft",
  "outlook.in": "microsoft",
  "hotmail.com": "microsoft",
  "hotmail.co.in": "microsoft",
  "live.com": "microsoft",
  "live.in": "microsoft",
  "msn.com": "microsoft",
  "rediffmail.com": "rediff",
  "mail.com": "mailcom",
};

/** The provider of a public mail service; null for a company's own domain or a service not on the list. */
export function emailProvider(address: string): Provider | null {
  const m = /@([a-z0-9.-]+\.[a-z]{2,})\s*$/i.exec(address.trim());
  if (!m) return null;
  const key = MAIL_DOMAINS[m[1]!.toLowerCase()];
  return key ? PROVIDERS[key] : null;
}

/** The company that runs a platform named in the case ("X (Twitter)", "Telegram", "WhatsApp"). */
export function platformProvider(platform: string | null | undefined): Provider | null {
  const p = (platform ?? "").toLowerCase();
  if (!p) return null;
  if (/whats\s*app/.test(p)) return PROVIDERS.whatsapp;
  if (/telegram/.test(p)) return PROVIDERS.telegram;
  if (/twitter|^x\b|x \(/.test(p)) return PROVIDERS.twitter;
  if (/instagram/.test(p)) return PROVIDERS.instagram;
  if (/facebook|messenger/.test(p)) return PROVIDERS.facebook;
  if (/youtube|google/.test(p)) return PROVIDERS.google;
  return null;
}

/** A provider by a name the officer typed ("GoDaddy", "HDFC Bank", "Telegram"). */
export function providerByName(name: string): Provider {
  const known = Object.values(PROVIDERS).find((p) => p.name.toLowerCase() === name.trim().toLowerCase() || p.keys.includes(name.trim().toLowerCase()));
  return known ?? platformProvider(name) ?? bankProvider(name.trim());
}

/** An Indian mobile or landline number (+91, 0 or bare 10 digits): the ones UNICROSS can get CDR and CAF for. */
export function isIndianNumber(value: string): boolean {
  const raw = value.trim();
  const d = raw.replace(/\D/g, "");
  if (/^\+/.test(raw)) return d.startsWith("91") && d.length === 12;
  if (d.length === 10) return /^[6-9]/.test(d);
  if (d.length === 11) return d.startsWith("0") && /^[6-9]/.test(d.slice(1));
  return d.length === 12 && d.startsWith("91");
}

/** Second-level names under which domains are registered (example.co.in is registered, co.in is not). */
const SECOND_LEVEL = /^(?:co|com|net|org|gov|ac|edu|res|gen|firm|ind|nic|mil)\.[a-z]{2}$/;

/**
 * The domain a website is registered under, which is what a registrar answers for
 * ("https://www.harmon.rest/x" → "harmon.rest", "m.darwinexgolbal.cc" → "darwinexgolbal.cc", "shop.example.co.in" →
 * "example.co.in"). A platform's own address keeps its host (x.com, t.me) so it can be recognised.
 */
export function siteHost(value: string): string | null {
  const v = value.trim().toLowerCase();
  const m = /^(?:[a-z][a-z0-9+.-]*:\/\/)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?::\d+)?(?:[/?#]|$)/.exec(v);
  if (!m || /^\d+(?:\.\d+){3}$/.test(m[1]!)) return null;
  const host = m[1]!.replace(/^www\./, "");
  if (PLATFORM_HOSTS.test(host)) return host;
  const labels = host.split(".");
  const keep = labels.length >= 3 && SECOND_LEVEL.test(labels.slice(-2).join(".")) ? 3 : 2;
  return labels.slice(-keep).join(".");
}

/** Hosts that belong to a platform: a link there is about an account on that platform, not a site to trace. */
export const PLATFORM_HOSTS = /^(?:x\.com|twitter\.com|t\.me|telegram\.me|telegram\.org|instagram\.com|facebook\.com|fb\.com|m\.facebook\.com|wa\.me|whatsapp\.com|chat\.whatsapp\.com|youtube\.com|youtu\.be|linkedin\.com)$/;

/** Whether an identifier is the complainant's own (their account, number, email): never a lead to request records on. */
export function isVictimOwned(e: { caseRole: string | null; attributes: Record<string, unknown>; belongsTo?: string | null }): boolean {
  if (e.attributes.isVictimAccount === true || e.belongsTo === "VICTIM") return true;
  if (e.belongsTo === "SUSPECT") return false;
  const role = e.caseRole ?? "";
  // "Complainant's own number", and a role that starts with the complainant's or victim's own thing ("Victim 2's
  // account", "Complainant's mobile number"); not "Account that received the complainant's payment".
  return /\b(?:complainant|victim)['’]?s? own\b/i.test(role) || /^(?:the\s+)?(?:complainant|victim)(?:\s*\d+)?['’]s\s+(?:(?:bank\s+|savings\s+)?account|a\/c|mobile|phone|number|e-?mail|upi|registered|card|wallet)\b/i.test(role.trim());
}

/** Bank names as FIRs write them ("SBI bank account", "HDFC", "Kotak"), with the bank they mean. */
const BANK_NAMES: [RegExp, string][] = [
  [/\bSBI\b|\bState Bank of India\b/i, "State Bank of India"],
  [/\bHDFC\b/i, "HDFC Bank"],
  [/\bICICI\b/i, "ICICI Bank"],
  [/\bAxis Bank\b/i, "Axis Bank"],
  [/\bKotak\b/i, "Kotak Mahindra Bank"],
  [/\bPNB\b|\bPunjab National Bank\b/i, "Punjab National Bank"],
  [/\bCanara Bank\b/i, "Canara Bank"],
  [/\bBank of Baroda\b|\bBOB\b/i, "Bank of Baroda"],
  [/\bUnion Bank\b/i, "Union Bank of India"],
  [/\bCentral Bank of India\b/i, "Central Bank of India"],
  [/(?<!State |Union |Central )\bBank of India\b|\bBOI\b/i, "Bank of India"],
  [/\bIndian Overseas Bank\b|\bIOB\b/i, "Indian Overseas Bank"],
  [/\bIndian Bank\b/i, "Indian Bank"],
  [/\bUCO Bank\b/i, "UCO Bank"],
  [/\bIDFC\b/i, "IDFC First Bank"],
  [/\bIDBI\b/i, "IDBI Bank"],
  [/\bIndusInd\b/i, "IndusInd Bank"],
  [/\bYes Bank\b/i, "Yes Bank"],
  [/\bFederal Bank\b/i, "Federal Bank"],
  [/\bRBL\b/i, "RBL Bank"],
  [/\bBandhan\b/i, "Bandhan Bank"],
  [/\bAU Small Finance\b/i, "AU Small Finance Bank"],
  [/\bEquitas\b/i, "Equitas Small Finance Bank"],
  [/\bUjjivan\b/i, "Ujjivan Small Finance Bank"],
  [/\bAirtel Payments? Bank\b/i, "Airtel Payments Bank"],
  [/\bPaytm Payments? Bank\b/i, "Paytm Payments Bank"],
  [/\bIndia Post Payments? Bank\b|\bIPPB\b/i, "India Post Payments Bank"],
  [/\bFino\b/i, "Fino Payments Bank"],
  [/\bKarur Vysya\b/i, "Karur Vysya Bank"],
  [/\bSouth Indian Bank\b/i, "South Indian Bank"],
  [/\bCity Union Bank\b/i, "City Union Bank"],
  [/\bKarnataka Bank\b/i, "Karnataka Bank"],
  [/\bDCB Bank\b/i, "DCB Bank"],
];

/**
 * The bank a text names beside an account number ("SBI bank account 3001…"): the nearest one within a short
 * distance, or null. What it reads is recorded as said in the FIR; the officer can correct it on the identifier.
 */
export function bankNamedNear(text: string, account: string, reach = 100): string | null {
  const at = text.indexOf(account);
  if (at < 0) return null;
  let best: { bank: string; distance: number } | null = null;
  for (const [re, bank] of BANK_NAMES) {
    for (const m of text.matchAll(new RegExp(re.source, "gi"))) {
      const start = m.index!;
      const end = start + m[0].length;
      const distance = end <= at ? at - end : start >= at + account.length ? start - (at + account.length) : 0;
      if (distance <= reach && (!best || distance < best.distance)) best = { bank, distance };
    }
  }
  return best?.bank ?? null;
}

/**
 * How a name a record gives (a bank's KYC, a CAF, a platform's registration) compares with the name the FIR stated
 * for the same identifier. A match says only that the record names the person the complainant named; it does not
 * show who used the account.
 */
export function compareNames(stated: string, record: string): { verdict: "MATCHES" | "PROBABLY" | "DIFFERS"; words: string } {
  const toks = (s: string) =>
    s
      .toLowerCase()
      .replace(/\b(?:mr|mrs|ms|miss|sri|shri|smt|dr|m\/s)\b\.?/g, " ")
      .replace(/[^a-z\s.]/g, " ")
      .split(/[\s.]+/)
      .filter(Boolean);
  const said = toks(stated);
  const rec = toks(record);
  if (!said.length || !rec.length) return { verdict: "DIFFERS", words: "the names differ" };
  const near = (a: string, b: string) => {
    if (Math.abs(a.length - b.length) > 2) return false;
    const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0]![j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    // A spelling variant keeps its first letter and differs by one letter (two in a long name).
    return a[0] === b[0] && d[a.length]![b.length]! <= (a.length >= 9 ? 2 : 1);
  };
  // Each part of the stated name must be in the record: whole, as an initial, or (for "probably") spelt slightly differently.
  const exact = said.every((w) => rec.some((r) => r === w || (w.length === 1 && r.startsWith(w)) || (r.length === 1 && w.startsWith(r))));
  if (exact) return { verdict: "MATCHES", words: "the names match" };
  const close = said.every((w) => rec.some((r) => r === w || (w.length === 1 && r.startsWith(w)) || (w.length >= 4 && near(w, r))));
  return close ? { verdict: "PROBABLY", words: "probably the same name, spelt differently" } : { verdict: "DIFFERS", words: "the names differ" };
}
