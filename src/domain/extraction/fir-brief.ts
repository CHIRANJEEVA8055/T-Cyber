import { formatInr } from "@/domain/money";
import { formatDateIST } from "@/domain/time";
import type { ExtractedCandidate, SourceLine } from "./index";
import { sourceOf, type FirProposal } from "./fir-intake";
import { briefFromForm, foundFromForm, stepsFromForm } from "./cctns-proposal";
import { classifyMo, type MoClass } from "@/domain/mo-verticals";
import { shownId } from "@/domain/identifiers";

/**
 * What the New FIR window shows after reading a copy: a short brief, the details found and the first steps.
 * Everything is composed by rules from what the FIR states, each sentence with the page it came from. Nothing is
 * inferred that the copy does not say; sections are shown only as the copy states them, never proposed.
 */

export const KINDS = [
  { key: "INVESTMENT", label: "Investment-app fraud", re: /\b(invest(?:ment|ments|ed|ing|or|ors)?|trading|crypto|stock|share market|returns)\b/i },
  { key: "SEXTORTION", label: "Sextortion", re: /\b(video call|nude|morph\w*|sextort\w*|intimate)\b/i },
  { key: "LOAN", label: "Loan-app extortion", re: /\b(loan app|instant loan|loan)\b/i },
  { key: "JOB", label: "Job scam", re: /\b(part[- ]time|job|work from home|tasks?|registration fee)\b/i },
  { key: "COURIER", label: "Courier-parcel scam", re: /\b(courier|parcel|customs)\b/i },
  { key: "OTP", label: "OTP fraud", re: /\b(OTP|one[- ]time password|customer care|screen shar\w*|remote access)\b/i },
  { key: "UPI", label: "UPI collect-request fraud", re: /\bcollect request\b/i },
] as const;

export function detectKind(text: string): { key: string; label: string } {
  const k = KINDS.find((x) => x.re.test(text));
  return k ? { key: k.key, label: k.label } : { key: "OTHER", label: "Online financial fraud" };
}

/** Which writing system most of the text is in: Telugu and Hindi copies are translated before rules read them. */
export function scriptOf(text: string): "TELUGU" | "HINDI" | "LATIN" {
  const telugu = (text.match(/[ఀ-౿]/g) ?? []).length;
  const hindi = (text.match(/[ऀ-ॿ]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  const total = telugu + hindi + latin || 1;
  if (telugu / total > 0.3) return "TELUGU";
  if (hindi / total > 0.3) return "HINDI";
  return "LATIN";
}

const NUMBER_WORD = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
/** A payment reference, in full as the copy gives it. */
export const maskRef = (v: string) => v.trim();
const humanDates = (s: string) =>
  s.replace(/\b(\d{2})-(\d{2})-(\d{4})\b/g, (_, d, m, y) => {
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `${d} ${months[Number(m) - 1]} ${y}`;
  });

interface PaymentDetail {
  payment: FirProposal["payments"][number];
  payer: string | null;
  channel: string | null;
  bank: string | null;
  sameAccount: boolean;
  uncertain: boolean;
  line: SourceLine | undefined;
}

function paymentDetails(p: FirProposal, lines: readonly SourceLine[], candidates: readonly ExtractedCandidate[]): PaymentDetail[] {
  return p.payments.map((pay) => {
    const line = lines.find((l) => sourceOf(l) === pay.source);
    const next = line ? lines.find((l) => l.page === line.page && l.line === (line.line ?? 0) + 1) : undefined;
    const text = `${line?.text ?? ""} ${next?.text ?? ""}`;
    const payer = p.parties.find((x) => text.includes(x.name.replace(/\s*\(synthetic\)$/, "")))?.name.replace(/\s*\(synthetic\)$/, "") ?? null;
    const channel = /\bUPI\b/i.test(text) ? "UPI" : /\bIMPS\b/i.test(text) ? "IMPS" : /\bNEFT\b/i.test(text) ? "NEFT" : /\bRTGS\b/i.test(text) ? "RTGS" : null;
    const bank = /\(([^)]*\bbank\b[^)]*)\)/i.exec(text)?.[1] ?? null;
    const ref = candidates.find((c) => c.field === "TXN_REFERENCE" && c.originalValue === pay.reference);
    return { payment: pay, payer, channel, bank, sameAccount: /\bsame account\b/i.test(text), uncertain: ref?.uncertainty === "UNCERTAIN_CHARACTERS", line };
  });
}

export interface BriefSentence {
  text: string;
  source: string;
}

/**
 * The sections, only as the FIR states them. When it states none, none are shown: T-CYBER never proposes sections
 * of law; they are what was registered, or what an officer decides.
 */
const statedSections = (p: FirProposal): { text: string | null; stated: boolean } => (p.fields.legalSections ? { text: p.fields.legalSections, stated: true } : { text: null, stated: false });

/** The station's investigation vertical for the brief, with what it rests on, in words. */
export function briefVertical(mo: MoClass): { label: string | null; why: string } {
  if (!mo.vertical) return { label: null, why: "The FIR does not show which vertical this is; choose it on the case." };
  const label = `${mo.vertical.label}${mo.subtype ? ` · ${mo.subtype}` : ""}`;
  return { label, why: mo.basis === "SECTIONS" ? `From the stated section ${mo.signs[0]}; the facts do not show the MO.` : `From the facts: ${mo.signs.slice(0, 3).join(", ")}.` };
}

export function briefFromFir(p: FirProposal, lines: readonly SourceLine[], candidates: readonly ExtractedCandidate[]) {
  const all = lines.map((l) => l.text).join(" ");
  // The narrative alone: the form's own printed words ("Investigating Officer") are not facts of the complaint.
  const vertical = briefVertical(classifyMo({ facts: p.fields.narrative || (p.form ? "" : all), sections: p.fields.legalSections }));
  if (p.form) {
    const b = briefFromForm(p.form);
    return { ...b, vertical, sections: statedSections(p) };
  }
  const kind = detectKind(all);
  const victims = p.parties.filter((x) => x.role === "VICTIM");
  const n = victims.length;
  const headline = `${kind.label} with ${n === 1 ? "one victim" : `${NUMBER_WORD[n] ?? n} victims`}.`;
  const sentences: BriefSentence[] = [];
  const facts = lines.find((l) => p.fields.narrative && l.text.trim() && p.fields.narrative.startsWith(l.text.trim().slice(0, 30)));
  const first = p.fields.narrative?.split(/(?<=\.)\s+/)[0];
  if (first) sentences.push({ text: humanDates(first.replace(/\s*\(synthetic\)/g, "")), source: facts ? sourceOf(facts) : "brief facts" });
  for (const d of paymentDetails(p, lines, candidates)) {
    const when = d.payment.when ? `On ${formatDateIST(new Date(d.payment.when))} ` : "";
    const who = d.payer ?? (n === 1 ? (victims[0]?.name ?? "The complainant") : "A victim");
    const to = d.sameAccount ? "to the same account" : d.payment.to ? `to ${/@/.test(d.payment.to) ? `UPI ID ${d.payment.to}` : `Account ${shownId(d.payment.to)}`}${d.bank ? ` at ${d.bank}` : ""}` : "to an account the copy does not show";
    sentences.push({ text: `${when}${who} paid ${d.payment.amount}${d.channel ? ` by ${d.channel}` : ""} ${to}${d.uncertain ? "; part of the reference is unreadable" : ""}.`, source: d.payment.source });
  }
  if (p.totalLoss) sentences.push({ text: `Total loss ${p.totalLoss}.`, source: "stated total" });
  return {
    kind,
    headline,
    sentences,
    vertical,
    tags: [kind.label, n === 1 ? "1 victim" : `${n} victims`, ...(p.totalLoss ? [`${p.totalLoss} lost`] : [])],
    sections: statedSections(p),
  };
}

export interface FoundItem {
  title: string;
  sub: string;
  status: "READ" | "CHECK";
}

export function foundDetails(p: FirProposal, candidates: readonly ExtractedCandidate[]) {
  if (p.form) return foundFromForm(p.form, p.fields.firNumber && p.fields.firYear ? { number: Number(p.fields.firNumber), year: Number(p.fields.firYear) } : null);
  const items: FoundItem[] = [];
  const fir = candidates.find((c) => c.field === "FIR_REFERENCE");
  if (fir) items.push({ title: `FIR ${fir.originalValue}`, sub: `${p.fields.reportedAt ? `Registered ${formatDateIST(new Date(`${p.fields.reportedAt}:00+05:30`))} · ` : ""}${sourceOf(fir)}`, status: "READ" });
  const own = candidates.find((c) => c.field === "PHONE" && /own number/i.test(c.roleHint ?? ""));
  p.parties.forEach((x, i) =>
    items.push({ title: i === 0 ? `${x.name.replace(/\s*\(synthetic\)$/, "")}, the complainant` : x.name.replace(/\s*\(synthetic\)$/, ""), sub: i === 0 && own ? `Own number ${shownId(own.originalValue)} is noted and never requested` : `Named in the FIR · ${x.source}`, status: "READ" }),
  );
  const seen = new Set<string>();
  for (const c of candidates) {
    const key = `${c.field}:${c.normalizedValue}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const ifsc = candidates.find((x) => x.field === "IFSC" && x.page === c.page && x.line === c.line);
    const check = c.uncertainty === "UNCERTAIN_CHARACTERS" || c.uncertainty === "AMBIGUOUS_FORMAT" || c.uncertainty === "AMBIGUOUS_ROLE" || c.uncertainty === "INCOMPLETE";
    if (c.field === "BANK_ACCOUNT" && !/own account/i.test(c.roleHint ?? ""))
      items.push({ title: `Account ${shownId(c.originalValue)}${ifsc ? ` · IFSC ${ifsc.originalValue}` : ""}`, sub: `${c.uncertainty === "MASKED" ? "Masked in this copy; the bank will confirm the number" : "Read in full"} · ${sourceOf(c)}`, status: "READ" });
    if (c.field === "TXN_REFERENCE") {
      const amount = candidates.find((x) => x.field === "AMOUNT" && x.page === c.page && (x.line === c.line || x.line === (c.line ?? 0) - 1));
      items.push({ title: `${/^\d/.test(c.originalValue) ? "UPI ref" : "Ref"} ${maskRef(c.originalValue)}${amount ? ` · ${amount.originalValue.replace(/^Rs\.?\s?/, "₹")}` : ""}`, sub: c.uncertaintyNote ? `${c.uncertaintyNote.split(".")[0]} · ${sourceOf(c)}` : sourceOf(c), status: check ? "CHECK" : "READ" });
    }
    if (c.field === "PHONE" && !/own number/i.test(c.roleHint ?? "")) items.push({ title: `Mobile ${shownId(c.originalValue)}`, sub: `${c.roleHint ?? "Role not stated"} · ${sourceOf(c)}`, status: c.roleHint ? "READ" : "CHECK" });
    if (c.field === "UPI_ID" && !/own|payer/i.test(c.roleHint ?? "")) items.push({ title: `UPI ID ${c.originalValue}`, sub: `${c.roleHint ?? "Whose it is is not stated"} · ${sourceOf(c)}`, status: c.roleHint ? "READ" : "CHECK" });
    if (c.field === "EMAIL") items.push({ title: `Email ${c.originalValue}`, sub: `${c.roleHint ?? "Whose it is is not stated"} · ${sourceOf(c)}`, status: c.roleHint ? "READ" : "CHECK" });
    if (c.field === "PLATFORM_PROFILE") items.push({ title: `Profile “${c.originalValue}”`, sub: `${c.roleHint ?? "Profile named in the FIR"} · ${sourceOf(c)}`, status: "READ" });
  }
  return { items, total: items.length, read: items.filter((i) => i.status === "READ").length, check: items.filter((i) => i.status === "CHECK").length };
}

export interface FirstStep {
  title: string;
  sub: string;
  request: "HOLD" | "INFORMATION" | "PRESERVATION" | null;
}

export function firstStepsFromFir(p: FirProposal, candidates: readonly ExtractedCandidate[]): FirstStep[] {
  if (p.form) return stepsFromForm(p.form);
  const victims = p.parties.filter((x) => x.role === "VICTIM").map((x) => x.name.replace(/\s*\(synthetic\)$/, ""));
  const uncertain = candidates.filter((c) => c.field === "TXN_REFERENCE" && c.uncertainty === "UNCERTAIN_CHARACTERS");
  const steps: FirstStep[] = [
    {
      title: victims.length > 1 ? "Record the complainants’ detailed statements" : "Record the complainant’s detailed statement",
      sub: `${victims.length > 1 ? `${victims[0]} first, then ${victims.slice(1).join(", ")}.` : "Questions drafted from what the FIR leaves open."}${uncertain.length ? ` Ask for a clearer receipt for ref ${uncertain.map((u) => maskRef(u.originalValue)).join(", ")}.` : ""}`,
      request: null,
    },
    { title: "Visit the scene of offence and conduct the panchanama", sub: "Where the transfers were made. Seize the phone and any chat export, with hashes recorded.", request: null },
  ];
  const seen = new Set<string>();
  const accounts = candidates.filter((c) => c.field === "BANK_ACCOUNT" && /beneficiary/i.test(c.roleHint ?? "") && !seen.has(c.normalizedValue) && seen.add(c.normalizedValue));
  for (const a of accounts) {
    const bank = /\(([^)]*\bbank\b[^)]*)\)/i.exec(candidates.find((c) => c.field === "TRANSACTION_ROW" && c.normalizedValue && (c.structured?.counterpartyAccount === a.originalValue))?.excerpt ?? "")?.[1] ?? "the account's bank";
    const paid = p.payments.filter((x) => x.to === a.originalValue).reduce((s, x) => s + BigInt(x.amount.replace(/[^0-9]/g, "")) * 100n, 0n);
    steps.push({ title: `Hold request to ${bank} on ${shownId(a.originalValue)}`, sub: `${paid ? `${formatInr(paid)} ` : ""}through CFCFRMS. Urgent: money like this usually moves on within 48 hours.`, request: "HOLD" });
    steps.push({ title: `Statement and KYC for ${shownId(a.originalValue)}`, sub: `From ${bank === "the account's bank" ? "the bank" : bank}’s nodal officer`, request: "INFORMATION" });
  }
  if (p.payments.some((x) => x.reference)) {
    steps.push({ title: "NPCI trace for the UPI payments", sub: `Beneficiary details for each UTR.${uncertain.length ? ` Ref ${uncertain.map((u) => maskRef(u.originalValue)).join(", ")} is held back until it is checked.` : ""}`, request: "INFORMATION" });
  }
  const callers = candidates.filter((c) => c.field === "PHONE" && /caller|fraudster|contact/i.test(c.roleHint ?? "") && !/own number/i.test(c.roleHint ?? ""));
  for (const ph of [...new Map(callers.map((c) => [c.normalizedValue, c])).values()]) {
    steps.push({ title: `CDR and CAF for ${shownId(ph.originalValue)}`, sub: "Through UNICROSS at the Zonal ACP; the reply comes back through the DD mailbox", request: "INFORMATION" });
  }
  const profiles = [...new Set(candidates.filter((c) => c.field === "PLATFORM_PROFILE").map((c) => c.originalValue))];
  const emails = [...new Set(candidates.filter((c) => c.field === "EMAIL").map((c) => c.originalValue))];
  if (profiles.length || emails.length) {
    const what = [...profiles.map((x) => `“${x}”`), ...(emails.length ? [emails.length === 1 ? "the email address" : "the email addresses"] : [])].join(" and ");
    steps.push({ title: `Preservation of ${what}`, sub: "On the providers’ law-enforcement portals; disclosure is a separate request", request: "PRESERVATION" });
  }
  return steps;
}
