import { formatInr } from "../money";
import { formatDateTimeIST } from "../time";
import { parseCctnsFir, type At, type CctnsFir, type CctnsOfficer } from "./cctns";
import { domainOf, firAmounts, firEntities, fraudKind, type FirAmount, type FirEntity } from "./fir-entities";
import type { SourceLine } from "./index";
import { shownId } from "@/domain/identifiers";

/**
 * Turns a CCTNS FIR, read item by item, into what the New FIR window shows: the case fields, a brief, the details
 * found with whose they are, and first steps that follow from those details. Everything carries the page and line it
 * was read from; nothing is added that the FIR does not state.
 */

export interface FormEntity {
  kind: FirEntity["kind"];
  value: string;
  role: FirEntity["role"];
  basis: string;
  platform: string | null;
  foreign: boolean;
  source: string;
}
export interface FormAmount {
  kind: FirAmount["kind"];
  summary: boolean;
  text: string;
  minor: string;
  date: string | null;
  reference: string | null;
  source: string;
}
export interface FirForm {
  district: string | null;
  policeStation: string | null;
  firDate: string | null;
  gdEntry: string | null;
  place: string | null;
  infoType: string | null;
  received: string | null;
  complainant: { name: string | null; relative: string | null; relation: string | null; age: number | null; occupation: string | null; mobile: string | null; email: string | null; address: string | null; source: string };
  accused: { serial: number; text: string; source: string }[];
  entities: FormEntity[];
  amounts: FormAmount[];
  totalValue: string | null;
  kind: { key: string; label: string };
  whatHappened: { text: string; source: string } | null;
  officers: { registeredBy: string | null; investigating: string | null; inCharge: string | null; source: string | null };
  /** Pages of the copy with no text layer (scanned attachments), filled in by the reader. */
  pagesWithoutText: number[];
}

export const sourceAt = (a: At | null | undefined) => (a ? [a.page != null ? `p. ${a.page}` : null, a.line != null ? `line ${a.line}` : null].filter(Boolean).join(", ") || "document" : "document");
const officer = (o: CctnsOfficer | null) => (o ? [o.rank?.replace(/ of Police$/i, ""), titleCase(o.name), o.number ? `(No. ${o.number})` : null, o.unit].filter(Boolean).join(" ").replace(/\) /, "), ") : null);
function titleCase(n: string): string {
  return /[a-z]/.test(n) ? n : n.toLowerCase().replace(/(^|[\s.])([a-z])/g, (_, p: string, c: string) => p + c.toUpperCase());
}
const ist = (s: string | null) => (s ? formatDateTimeIST(new Date(`${s}:00+05:30`)) : null);

/** The complainant's address as the complaint states it ("residing at …"), which the form's columns break up. */
function addressFromNarrative(text: string): string | null {
  const m = /(?:residing at|R\/o:?|resident of)\s+(.+?)(?:,\s*(?:whose|Mobile|Mail|Ph(?:one)?|Cell|local police)|\.\s+In which|\s+submitted|\s+stated|;)/i.exec(text.slice(0, 900));
  return m ? m[1]!.replace(/\s+/g, " ").trim().replace(/,$/, "") : null;
}

/** The first thing the complainant says happened: the clause after "submitted that" / "stated that". */
function whatHappened(fir: CctnsFir): { text: string; source: string } | null {
  const n = fir.narrative;
  if (!n) return null;
  const m = /(?:submitted that|In which (?:he|she|they) stated that|(?:he|she|they) stated that|stated that)\s+/i.exec(n.text);
  const start = m ? m.index + m[0].length : 0;
  let s = n.text.slice(start, start + 320);
  const stop = s.search(/;\s|\.\s(?=[A-Z])/);
  if (stop > 60) s = s.slice(0, stop);
  else if (s.length >= 320) s = `${s.slice(0, s.lastIndexOf(" ", 300))}…`;
  s = s.trim().replace(/[,;]$/, "");
  const at = n.lines.find((_, i) => (n.offsets[i + 1] ?? Infinity) > start) ?? n.lines[0]!;
  return { text: s.charAt(0).toUpperCase() + s.slice(1), source: sourceAt(at) };
}

export function readCctnsForm(lines: readonly SourceLine[]): { fir: CctnsFir; form: FirForm } | null {
  const fir = parseCctnsFir(lines);
  if (!fir) return null;
  const entities = firEntities(fir);
  const amounts = firAmounts(fir);
  const email = entities.find((e) => e.kind === "EMAIL" && e.role === "COMPLAINANT")?.value ?? null;
  const kind = fraudKind(`${fir.narrative?.text ?? ""} ${fir.accused.map((a) => a.text.value).join(" ")}`);
  const form: FirForm = {
    district: fir.district?.value ?? null,
    policeStation: fir.policeStation?.value ?? null,
    firDate: fir.firDate?.value ?? null,
    gdEntry: fir.gdEntry?.value ?? null,
    place: fir.place?.value ?? null,
    infoType: fir.infoType?.value ?? null,
    received: fir.received?.value ?? null,
    complainant: {
      name: fir.complainant.name?.value ?? null,
      relative: fir.complainant.relative?.value ?? null,
      // The relation as the complaint writes it ("S/o Kondal Reddy"); the form only has "Father's/Husband's Name".
      relation: fir.narrative && fir.complainant.relative ? (new RegExp(`\\b(S/o|D/o|W/o|C/o)\\.?\\s+${fir.complainant.relative.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\./g, "\\.?\\s*")}`, "i").exec(fir.narrative.text)?.[1] ?? null) : null,
      age: fir.complainant.age?.value ?? null,
      occupation: fir.complainant.occupation?.value ?? null,
      mobile: fir.complainant.mobile?.value ?? null,
      email,
      address: ((fir.narrative && addressFromNarrative(fir.narrative.text)) ?? fir.complainant.address?.value ?? null)?.replace(/,\s*,/g, ",").replace(/\s+,/g, ",") ?? null,
      source: sourceAt(fir.complainant.name),
    },
    accused: fir.accused.map((a) => ({ serial: a.serial, text: a.text.value, source: sourceAt(a.text) })),
    entities: entities.map((e) => ({ kind: e.kind, value: e.value, role: e.role, basis: e.basis, platform: e.platform, foreign: e.foreign, source: sourceAt(e.at) })),
    amounts: amounts.map((a) => ({ kind: a.kind, summary: a.summary, text: a.text, minor: a.minor.toString(), date: a.date, reference: a.reference, source: sourceAt(a.at) })),
    totalValue: fir.totalValue ? fir.totalValue.value.minor.toString() : null,
    kind: { key: kind.key, label: kind.label },
    whatHappened: whatHappened(fir),
    officers: { registeredBy: officer(fir.registeredBy), investigating: officer(fir.investigatingOfficer), inCharge: officer(fir.officerInCharge), source: fir.investigatingOfficer ? sourceAt(fir.investigatingOfficer.at) : null },
    pagesWithoutText: [],
  };
  return { fir, form };
}

const inr = (minor: string | bigint) => formatInr(BigInt(minor));
const sum = (xs: FormAmount[]) => xs.reduce((s, a) => s + BigInt(a.minor), 0n);
const last = <T>(xs: T[]) => xs[xs.length - 1];

/** The money as the FIR states it: what was paid, what came back, and the loss registered (item 10). */
export function moneyOf(form: FirForm) {
  const total = form.totalValue ? BigInt(form.totalValue) : null;
  const stated = last(form.amounts.filter((a) => a.kind === "LOSS"));
  const totalPaid = last(form.amounts.filter((a) => a.kind === "TOTAL_PAID"));
  // The complaint's own summing-up ("they returned only Rs. …") is the figure; otherwise each return is counted once.
  const summedUp = last(form.amounts.filter((a) => a.kind === "RETURNED" && a.summary));
  const returned = summedUp ? [summedUp] : form.amounts.filter((a) => a.kind === "RETURNED");
  const paid = form.amounts.filter((a) => a.kind === "PAID");
  return { total, stated, totalPaid, returned, paid, loss: total ?? (stated ? BigInt(stated.minor) : null) };
}

const KIND_NOUN: Record<FirEntity["kind"], [string, string]> = {
  PHONE: ["phone number", "phone numbers"],
  EMAIL: ["email address", "email addresses"],
  WEBSITE: ["website", "websites"],
  HANDLE: ["platform account", "platform accounts"],
  UPI_ID: ["UPI ID", "UPI IDs"],
  BANK_ACCOUNT: ["bank account", "bank accounts"],
  IFSC: ["IFSC", "IFSCs"],
  TXN_REFERENCE: ["transaction reference", "transaction references"],
  NCRP_ACK: ["NCRP acknowledgement", "NCRP acknowledgements"],
  BANK_SR: ["bank service request", "bank service requests"],
};
const count = (n: number, [one, many]: [string, string]) => `${n} ${n === 1 ? one : many}`;

export function briefFromForm(form: FirForm) {
  const c = form.complainant;
  const money = moneyOf(form);
  const sentences: { text: string; source: string }[] = [];
  const who = [c.name, c.age ? `(${c.age})` : null].filter(Boolean).join(" ");
  if (who) sentences.push({ text: `${who}${c.relative ? (c.relation ? `, ${c.relation} ${c.relative}` : `, father's or husband's name ${c.relative}`) : ""}${c.occupation ? `, ${c.occupation}` : ""}${c.address ? `, of ${c.address}` : ""}.`, source: c.source });
  if (form.whatHappened) sentences.push({ text: form.whatHappened.text.endsWith(".") || form.whatHappened.text.endsWith("…") ? form.whatHappened.text : `${form.whatHappened.text}.`, source: form.whatHappened.source });
  if (money.totalPaid || money.returned.length || money.loss) {
    const parts: string[] = [];
    if (money.totalPaid) parts.push(`Paid ${inr(money.totalPaid.minor)} in all`);
    else if (money.paid.length) parts.push(`${money.paid.length} ${money.paid.length === 1 ? "payment" : "payments"} listed`);
    if (money.returned.length) parts.push(`${inr(sum(money.returned))} came back`);
    if (money.loss) parts.push(`loss registered ${inr(money.loss)}${money.total ? " (item 10)" : ""}`);
    const shown = form.amounts.filter((a) => a.kind === "PROFIT_SHOWN");
    sentences.push({ text: `${parts.join("; ")}.${shown.length ? ` The ${shown.length === 1 ? "figure" : "figures"} shown as profit (${shown.map((a) => inr(a.minor)).join(", ")}) never existed as money.` : ""}`.replace(/^./, (x) => x.toUpperCase()), source: money.totalPaid?.source ?? money.stated?.source ?? "item 10" });
  }
  const suspects = form.entities.filter((e) => e.role === "SUSPECT" || e.role === "BENEFICIARY");
  if (suspects.length) {
    const byKind = new Map<FirEntity["kind"], number>();
    for (const e of suspects) byKind.set(e.kind, (byKind.get(e.kind) ?? 0) + (e.kind === "WEBSITE" ? 0 : 1));
    const domains = new Set(suspects.filter((e) => e.kind === "WEBSITE" && !/\/status\//.test(e.value)).map((e) => domainOf(e.value)));
    const posts = suspects.filter((e) => e.kind === "WEBSITE" && /\/status\//.test(e.value)).length;
    const bits = [...byKind.entries()].filter(([k, n]) => n && k !== "WEBSITE").map(([k, n]) => count(n, KIND_NOUN[k]));
    if (domains.size) bits.unshift(count(domains.size, ["website", "websites"]));
    if (posts) bits.push(count(posts, ["post", "posts"]));
    const foreign = suspects.filter((e) => e.foreign).length;
    sentences.push({ text: `Against the accused: ${bits.join(", ")}${foreign ? ` (${foreign} foreign ${foreign === 1 ? "number" : "numbers"})` : ""}.`, source: form.accused[0]?.source ?? "item 7" });
  }
  if (form.received || form.officers.investigating) {
    sentences.push({ text: `Registered ${ist(form.received) ?? form.firDate ?? ""}${form.gdEntry ? ` (GD entry ${form.gdEntry})` : ""}${form.officers.registeredBy ? ` by ${form.officers.registeredBy}` : ""}${form.officers.investigating ? `; investigation with ${form.officers.investigating}` : ""}.`, source: form.officers.source ?? "items 1 and 13" });
  }
  const ack = form.entities.find((e) => e.kind === "NCRP_ACK");
  if (ack) sentences.push({ text: `NCRP acknowledgement ${ack.value}.`, source: ack.source });
  const headline = money.loss ? `${form.kind.label}: ${c.name ?? "the complainant"} lost ${inr(money.loss)}.` : `${form.kind.label}${c.name ? `, reported by ${c.name}` : ""}.`;
  return {
    kind: form.kind,
    headline,
    sentences,
    tags: [form.kind.label, money.loss ? `${inr(money.loss)} lost` : "No money lost", ...(form.accused.length ? [`${form.accused.length} accused ${form.accused.length === 1 ? "entry" : "entries"}`] : [])],
    sections: null as { text: string | null; stated: boolean } | null,
  };
}


/** One line per detail, saying whose it is; READ when the FIR states it, CHECK when the officer must decide. */
export function foundFromForm(form: FirForm, fir: { number: number; year: number } | null) {
  const items: { title: string; sub: string; status: "READ" | "CHECK" }[] = [];
  if (fir) items.push({ title: `FIR ${fir.number}/${fir.year}`, sub: `Registered ${ist(form.received) ?? form.firDate ?? "date not shown"}${form.gdEntry ? ` · GD entry ${form.gdEntry}` : ""}${form.policeStation ? ` · ${form.policeStation}` : ""}`, status: "READ" });
  const c = form.complainant;
  if (c.name) items.push({ title: `${c.name}, the complainant`, sub: `${[c.mobile ? `own mobile ${shownId(c.mobile)}` : null, c.email ? "own email" : null].filter(Boolean).join(" and ") || "No contact stated"}${c.mobile || c.email ? " noted and never requested" : ""} · ${c.source}`, status: "READ" });
  const label = (e: FormEntity) => {
    switch (e.kind) {
      case "PHONE":
        return `${e.foreign ? "Foreign number" : "Mobile"} ${e.value}${e.platform ? ` · ${e.platform}` : ""}`;
      case "WEBSITE":
        return /\/status\//.test(e.value) ? `${e.platform ?? "Post"} post ${e.value.replace(/^https?:\/\/(?:www\.)?/, "").replace(/(status\/)(\d{4})\d+(\d{3})/, "$1$2…$3")}` : `Website ${domainOf(e.value)}${e.value.replace(/^https?:\/\//, "").length > domainOf(e.value).length + 1 ? ` (${e.value.replace(/^https?:\/\/[^/]+/, "").slice(0, 40)})` : ""}`;
      case "HANDLE":
        return `${e.platform ?? "Platform"} account ${e.value}`;
      case "EMAIL":
        return `Email ${e.value}`;
      case "UPI_ID":
        return `UPI ID ${e.value}`;
      case "BANK_ACCOUNT":
        return e.role === "VICTIM_ACCOUNT" ? `Complainant's account ${shownId(e.value)}` : `Account ${shownId(e.value)}${e.role === "BENEFICIARY" ? ", money sent here" : ""}`;
      case "TXN_REFERENCE":
        return `Ref ${e.value}`;
      case "NCRP_ACK":
        return `NCRP acknowledgement ${e.value}`;
      case "BANK_SR":
        return `Bank service request ${e.value}`;
      default:
        return `${e.kind} ${e.value}`;
    }
  };
  for (const e of form.entities) {
    if (e.role === "COMPLAINANT") continue;
    items.push({ title: label(e), sub: `${e.basis.charAt(0).toUpperCase()}${e.basis.slice(1)} · ${e.source}`, status: e.role === "UNSTATED" && !["NCRP_ACK", "BANK_SR", "TXN_REFERENCE"].includes(e.kind) ? "CHECK" : "READ" });
  }
  const money = moneyOf(form);
  if (money.paid.length) {
    const dated = money.paid.filter((p) => p.date);
    items.push({ title: `${money.paid.length} ${money.paid.length === 1 ? "payment" : "payments"} listed in the complaint`, sub: `${dated.length ? `${dated[0]!.date} to ${last(dated)!.date}; ` : ""}check each against the bank statement before it is recorded`, status: "CHECK" });
  }
  if (money.loss) items.push({ title: `Loss ${inr(money.loss)}`, sub: money.total ? "Total value of property, item 10" : `As the complaint states it · ${money.stated?.source}`, status: "READ" });
  if (form.officers.investigating) items.push({ title: `Investigating officer: ${form.officers.investigating}`, sub: `Item 13 · ${form.officers.source}`, status: "READ" });
  if (form.pagesWithoutText.length) items.push({ title: `${form.pagesWithoutText.length} ${form.pagesWithoutText.length === 1 ? "page is a scan" : "pages are scans"}, not read`, sub: `${pageRanges(form.pagesWithoutText)}: attachments with no text layer. The local model reads them when it is running; otherwise check them by eye.`, status: "CHECK" });
  return { items, total: items.length, read: items.filter((i) => i.status === "READ").length, check: items.filter((i) => i.status === "CHECK").length };
}

export function pageRanges(pages: number[]): string {
  const out: string[] = [];
  for (let i = 0; i < pages.length; ) {
    let j = i;
    while (j + 1 < pages.length && pages[j + 1] === pages[j]! + 1) j++;
    out.push(i === j ? `p. ${pages[i]}` : `pp. ${pages[i]}–${pages[j]}`);
    i = j + 1;
  }
  return out.join(", ");
}

/** First steps that follow from what the FIR names. Nothing is drafted or sent until the case is open and approved. */
export function stepsFromForm(form: FirForm): { title: string; sub: string; request: "HOLD" | "INFORMATION" | "PRESERVATION" | null }[] {
  const steps: { title: string; sub: string; request: "HOLD" | "INFORMATION" | "PRESERVATION" | null }[] = [];
  const ofRole = (k: FirEntity["kind"], ...roles: FirEntity["role"][]) => form.entities.filter((e) => e.kind === k && roles.includes(e.role));
  const money = moneyOf(form);
  const ask: Record<string, string> = {
    INVESTMENT: "Ask for the bank statement for the payment period, screenshots of the app or website and the chat or group export, and every transaction reference.",
    JOB: "Ask for the task links, the Telegram and WhatsApp chat exports, the bank statement for the payment period and every transaction reference.",
    BEC: "Ask for the emails with full headers, the vendor's confirmation that it did not send them, the bank's recall letter and the beneficiary details given.",
    ABUSE: "Ask for screenshots of each post with its address and time visible; they are hashed when added to the case.",
  };
  steps.push({ title: "Record the complainant’s detailed statement", sub: ask[form.kind.key] ?? "Questions drafted from what the FIR leaves open.", request: null });
  steps.push({ title: "Seize and record the digital evidence", sub: "The phone or mailbox the fraud came through, with chat exports and screenshots, each hashed on intake (panchanama).", request: null });
  if (money.loss) {
    const ack = form.entities.find((e) => e.kind === "NCRP_ACK");
    steps.push(ack ? { title: `Check the CFCFRMS holds on NCRP ${ack.value}`, sub: "What each bank has put on hold against the complaint, and what is still moving.", request: null } : { title: "Find or raise the NCRP complaint for this loss", sub: "The CFCFRMS holds run on its acknowledgement number; the complaint mentions the portal but no number.", request: null });
  }
  for (const a of ofRole("BANK_ACCOUNT", "BENEFICIARY")) {
    steps.push({ title: `Hold request on account ${shownId(a.value)}`, sub: "Through CFCFRMS, to the bank's nodal officer. Urgent: money like this usually moves on within 48 hours.", request: "HOLD" });
    steps.push({ title: `Statement and KYC for account ${shownId(a.value)}`, sub: "From the bank's nodal officer, for the payment period.", request: "INFORMATION" });
  }
  for (const a of ofRole("BANK_ACCOUNT", "VICTIM_ACCOUNT")) steps.push({ title: `Statement of the complainant's account ${shownId(a.value)}`, sub: "Shows where each payment went: the beneficiary accounts to trace.", request: "INFORMATION" });
  const refs = form.entities.filter((e) => e.kind === "TXN_REFERENCE");
  if (refs.length || money.paid.length) steps.push({ title: `Trace the beneficiaries of ${refs.length ? count(refs.length, ["reference", "references"]) : "the listed payments"}`, sub: "Beneficiary account, bank and onward transfers for each transaction.", request: "INFORMATION" });
  const sr = form.entities.find((e) => e.kind === "BANK_SR");
  if (sr) steps.push({ title: `Ask the bank where recall request ${sr.value} stands`, sub: "Whether the transfer was recalled or held at the beneficiary bank.", request: "INFORMATION" });
  const indian = ofRole("PHONE", "SUSPECT", "UNSTATED").filter((p) => !p.foreign);
  if (indian.length) steps.push({ title: `CDR and CAF for ${count(indian.length, ["number", "numbers"])}`, sub: `${indian.slice(0, 3).map((p) => p.value).join(", ")}${indian.length > 3 ? "…" : ""} · through UNICROSS; replies come back through the DD mailbox.`, request: "INFORMATION" });
  const viaApps = form.entities.filter((e) => e.kind === "PHONE" && e.role === "SUSPECT" && (e.foreign || e.platform === "WhatsApp"));
  if (viaApps.length) steps.push({ title: `Preserve the WhatsApp accounts of ${count(viaApps.length, ["number", "numbers"])}`, sub: "Then ask for the registration details and access logs; foreign numbers are reached only through the platform.", request: "PRESERVATION" });
  const handles = ofRole("HANDLE", "SUSPECT");
  for (const h of handles) steps.push({ title: `Preserve ${h.platform ?? "the"} account ${h.value}`, sub: `Then ask ${h.platform ?? "the platform"} for the account details and login IP logs${form.kind.key === "ABUSE" ? ", and for the posts to be taken down" : ""}.`, request: "PRESERVATION" });
  const domains = [...new Set(form.entities.filter((e) => e.kind === "WEBSITE" && e.role === "SUSPECT" && !/\/status\//.test(e.value)).map((e) => domainOf(e.value)))];
  if (domains.length) steps.push({ title: `Registrar and hosting details for ${count(domains.length, ["website", "websites"])}`, sub: `${domains.slice(0, 4).join(", ")}${domains.length > 4 ? "…" : ""} · who registered them, where they are hosted, and the payment pages they use.`, request: "INFORMATION" });
  const emails = ofRole("EMAIL", "SUSPECT");
  if (emails.length) steps.push({ title: `Preserve ${count(emails.length, ["email account", "email accounts"])}`, sub: `${[...new Set(emails.map((e) => e.value.split("@")[1]))].join(", ")} · then ask for the subscriber details and login IPs.`, request: "PRESERVATION" });
  return steps;
}
