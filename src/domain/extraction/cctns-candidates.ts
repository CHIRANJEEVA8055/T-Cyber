import { bankNamedNear } from "../providers";
import { normalizeIdentifier, isMaskedValue } from "../identifiers";
import { parseCctnsFir, type At } from "./cctns";
import { firAmounts, firEntities, type FirEntity } from "./fir-entities";
import type { CandidateField, ExtractedCandidate, SourceLine, Uncertainty } from "./index";

/**
 * The extraction candidates of a CCTNS FIR copy, from the item-by-item reading (cctns.ts, fir-entities.ts): each with
 * whose it is, in the FIR's words, and its exact place on the page so the review screen can mark it. Used in place of
 * the line-by-line rules for these copies; dates and IP addresses still come from the line rules.
 */

const FIELD: Partial<Record<FirEntity["kind"], CandidateField>> = { PHONE: "PHONE", EMAIL: "EMAIL", WEBSITE: "WEBSITE", HANDLE: "PLATFORM_PROFILE", UPI_ID: "UPI_ID", BANK_ACCOUNT: "BANK_ACCOUNT", IFSC: "IFSC", TXN_REFERENCE: "TXN_REFERENCE" };

function roleHint(e: FirEntity): string | null {
  const via = e.platform ? ` (${e.platform})` : "";
  switch (e.role) {
    case "COMPLAINANT":
      return e.kind === "EMAIL" ? "Complainant's own email" : "Complainant's own number";
    case "VICTIM_ACCOUNT":
      return "Complainant's own account";
    case "BENEFICIARY":
      return e.kind === "UPI_ID" ? "Reported beneficiary UPI ID" : "Reported beneficiary account";
    case "SUSPECT": {
      // An entry in item 7 keeps its serial: "Accused 1 in the FIR: number (WhatsApp)".
      const serial = /item 7, serial (\d+)/.exec(e.basis)?.[1];
      const WHAT: Partial<Record<FirEntity["kind"], string>> = { PHONE: "number", EMAIL: "email", HANDLE: "account", BANK_ACCOUNT: "bank account", UPI_ID: "UPI ID", WEBSITE: "website" };
      if (serial && WHAT[e.kind]) return `Accused ${serial} in the FIR: ${WHAT[e.kind]}${via}`;
      if (e.kind === "PHONE") return `Contact used by the alleged fraudster${via}`;
      if (e.kind === "EMAIL") return "Email used by the alleged fraudster";
      if (e.kind === "HANDLE") return `Account named against the accused in the FIR${via}`;
      if (e.kind === "WEBSITE") return /\/status\//.test(e.value) ? `Post named in the FIR${via}` : "Website used in the fraud (per the FIR)";
      return "Named against the accused in the FIR";
    }
    default:
      return e.kind === "TXN_REFERENCE" ? "Transaction reference stated in the FIR" : null;
  }
}

const AMOUNT_HINT: Record<string, string> = {
  PAID: "Paid by the complainant (per the FIR)",
  TOTAL_PAID: "Total the complainant says was paid",
  RETURNED: "Returned to the complainant (per the FIR)",
  LOSS: "Loss stated in the FIR",
  DEMANDED: "Further amount demanded by the fraudsters, not stated as paid",
};

export function cctnsCandidates(lines: readonly SourceLine[]): ExtractedCandidate[] | null {
  const fir = parseCctnsFir(lines);
  if (!fir) return null;
  const lineAt = (a: At) => lines.find((l) => l.page === a.page && l.line === a.line);
  // Where the value sits on its line; a value that wraps onto the next line is marked as far as this line goes.
  const span = (a: At, value: string) => {
    const first = lineAt(a);
    if (!first) return { start: null, end: null, excerpt: "", row: null, at: a };
    // The value can sit on one of the next few lines (a wrapped accused entry, a long sentence).
    const k0 = lines.indexOf(first);
    // "Rs." can end one line and the figure start the next: then the figure itself is marked.
    const bare = value.replace(/^(?:Rs\.?|INR|₹)\s*/i, "");
    for (const v of bare !== value ? [value, bare] : [value])
      for (const l of lines.slice(k0, k0 + 5)) {
        const r = locate(l, v);
        if (r) return { ...r, at: { page: l.page, line: l.line } };
      }
    return { start: null, end: null, excerpt: first.text, row: first.row, at: a };
  };
  const locate = (l: SourceLine, value: string) => {
    const squash = (t: string) => t.replace(/\s+/g, " ");
    let i = l.text.indexOf(value);
    let len = value.length;
    if (i < 0) i = squash(l.text).indexOf(squash(value));
    if (i < 0)
      for (let k = value.length - 1; k >= 6; k--) {
        // Only a part that runs to the end of the line is the start of a wrapped value.
        const j = l.text.trimEnd().endsWith(value.slice(0, k)) ? l.text.trimEnd().length - k : -1;
        if (j >= 0) {
          i = j;
          len = k;
          break;
        }
      }
    return i >= 0 ? { start: i, end: i + len, excerpt: l.text, row: l.row } : null;
  };
  const out: ExtractedCandidate[] = [];
  const push = (field: CandidateField, value: string, a: At, extra: Partial<ExtractedCandidate> = {}) => {
    const s = span(a, value);
    const masked = isMaskedValue(value);
    out.push({
      field,
      originalValue: value,
      normalizedValue: ["PHONE", "EMAIL", "UPI_ID", "WEBSITE", "IP_ADDRESS", "BANK_ACCOUNT"].includes(field) ? normalizeIdentifier(field as never, value) : ["IFSC", "TXN_REFERENCE"].includes(field) ? value.toUpperCase() : value.trim(),
      roleHint: null,
      roleHintBasis: null,
      uncertainty: masked ? "MASKED" : "NONE",
      uncertaintyNote: masked ? "Partly masked in the source document; the full value is not available." : null,
      page: s.at.page,
      line: s.at.line,
      row: s.row,
      charStart: s.start,
      charEnd: s.end,
      excerpt: s.excerpt,
      ...extra,
    });
  };

  if (fir.fir) push("FIR_REFERENCE", `${fir.fir.value.number}/${fir.fir.value.year}`, fir.fir, { structured: { number: fir.fir.value.number, year: fir.fir.value.year }, roleHint: "FIR registered (item 1)", roleHintBasis: "FIR No. on the form" });
  if (fir.complainant.name) push("PERSON_NAME", fir.complainant.name.value, fir.complainant.name, { roleHint: "Complainant", roleHintBasis: "Item 6(a), Complainant / Informant" });

  for (const e of firEntities(fir)) {
    const field = FIELD[e.kind];
    if (!field) continue;
    // A name the FIR gives for it is only what was stated: never the accused's name or the holder on record.
    const role = roleHint(e);
    const hint = role && e.statedName ? `${role}; stated to be “${e.statedName}” (per the FIR, not verified)` : role;
    const uncertainty: Uncertainty = hint ? "NONE" : "AMBIGUOUS_ROLE";
    // A bank the FIR names right beside the account ("SBI bank account 3001…") is kept with it.
    const bank = e.kind === "BANK_ACCOUNT" ? bankNamedNear(fir.narrative?.text ?? e.excerpt, e.value) ?? bankNamedNear(e.excerpt, e.value) : null;
    const structured = { ...(bank ? { bank, bankBasis: "Named beside the account in the FIR" } : {}), ...(e.statedName ? { statedName: e.statedName, statedNameBasis: "As stated in the FIR; not verified" } : {}) };
    push(field, e.value, e.at, {
      ...(Object.keys(structured).length ? { structured } : {}),
      roleHint: hint,
      roleHintBasis: hint ? `FIR: ${e.basis}${bank ? `; bank: ${bank}, as named beside it` : ""}` : null,
      uncertainty,
      uncertaintyNote: hint ? (e.foreign ? "A number outside India: the platform, not a telecom operator, holds its details." : null) : "The FIR does not say whose identifier this is. Assign a role during review.",
      ...(e.kind === "HANDLE" ? { normalizedValue: e.value.toLowerCase() } : {}),
    });
  }

  for (const a of firAmounts(fir)) {
    const hint = AMOUNT_HINT[a.kind];
    if (!hint) continue;
    push("AMOUNT", a.text, a.at, { structured: { amountMinor: a.minor.toString(), kind: a.kind, date: a.date, reference: a.reference }, roleHint: hint, roleHintBasis: "The sentence the amount is in" });
  }
  if (fir.totalValue) push("AMOUNT", fir.totalValue.value.text, fir.totalValue, { structured: { amountMinor: fir.totalValue.value.minor.toString(), kind: "TOTAL_VALUE" }, roleHint: "Total value of property stolen (item 10)", roleHintBasis: "Item 10 of the FIR" });
  return out;
}
