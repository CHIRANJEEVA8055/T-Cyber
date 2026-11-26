/** Fragments a letter carries only when they apply (a period, the FIR copy note, a hold note): empty means omitted. */
const OPTIONAL_FRAGMENTS = new Set(["periodText", "firCopyNote", "holdNote"]);

/** Fills {{placeholders}} in request templates. A missing fact is left visible so the gap is obvious. */
export function renderTemplate(template: string, vars: Record<string, string | null | undefined>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key: string) => {
    const value = vars[key];
    if (OPTIONAL_FRAGMENTS.has(key) && (value === "" || value === null || value === undefined)) return "";
    return value === undefined || value === null || value === "" ? `[${key} — not available]` : value;
  });
}

/**
 * A request's subject line from its template. When the subject's name is its number ("50100099990001"), a template
 * that writes the name and then the number would repeat it; the repeat is dropped.
 */
export function renderSubject(template: string, vars: Record<string, string | null | undefined>): string {
  return renderTemplate(template, vars).replace(/(\S*\d{4,}\S*)(?:\s+\1)+(?!\S)/g, "$1");
}

export const DEFAULT_ITEMS: Record<string, { label: string; itemType: string }[]> = {
  HOLD: [{ label: "Confirmation of the debit freeze and the amount actually held, with the time the balance was taken", itemType: "HOLD_CONFIRMATION" }],
  INFORMATION_BANK: [
    { label: "The account statement for the period", itemType: "STATEMENT" },
    { label: "KYC documents with photograph and ID proof", itemType: "KYC" },
    { label: "Current balance and any lien or hold in place", itemType: "BALANCE_CONFIRMATION" },
    { label: "Registered mobile number, email and linked devices", itemType: "LINKED_CONTACTS" },
  ],
  INFORMATION_PHONE: [
    { label: "CDR with cell IDs and IMEI for the period", itemType: "CDR" },
    { label: "CAF with ID proof and activation details", itemType: "SUBSCRIBER_DETAILS" },
    { label: "IMEI history for the period", itemType: "IMEI" },
  ],
  INFORMATION_PHONE_CALLER: [
    { label: "CDR with cell IDs for the period", itemType: "CDR" },
    { label: "CAF with ID proof and activation details", itemType: "SUBSCRIBER_DETAILS" },
  ],
  INFORMATION_IP: [{ label: "Source port and timestamp (with seconds and time zone) for the session", itemType: "IP_LOGS" }],
  INFORMATION_OTHER: [{ label: "Account records relevant to the requested period", itemType: "OTHER" }],
  PRESERVATION: [{ label: "Confirmation that records are preserved, and until when", itemType: "PRESERVATION_CONFIRMATION" }],
  RESTORATION: [{ label: "Confirmation of credit to the victim's account", itemType: "RESTORATION_CONFIRMATION" }],
};

/** Items for a request about a number the complaint says the caller used (rule IDENTITY_CALLER_NUMBER). */
export const CALLER_NUMBER_ITEMS = DEFAULT_ITEMS.INFORMATION_PHONE_CALLER!;

export function defaultItemsFor(category: string, subjectKind: string | null): { label: string; itemType: string }[] {
  if (category !== "INFORMATION") return DEFAULT_ITEMS[category] ?? DEFAULT_ITEMS.INFORMATION_OTHER!;
  if (subjectKind === "BANK_ACCOUNT" || subjectKind === "UPI_ID" || subjectKind === "WALLET") return DEFAULT_ITEMS.INFORMATION_BANK!;
  if (subjectKind === "PHONE") return DEFAULT_ITEMS.INFORMATION_PHONE!;
  if (subjectKind === "IP_ADDRESS") return DEFAULT_ITEMS.INFORMATION_IP!;
  return DEFAULT_ITEMS.INFORMATION_OTHER!;
}

/**
 * Placeholders that drafting fills for each kind of template (see services/drafting.ts). Settings only accepts
 * template edits that use these, so a saved template can never produce "[name — not available]".
 */
export const TEMPLATE_PLACEHOLDERS = {
  common: ["caseReference", "station", "officerName", "officerRank", "relevance", "requestReference", "signature", "stationAddress", "stationPhone", "stationEmail", "fromAddress"],
  subject: ["subjectLabel", "subjectValue", "subjectShort", "bank", "transactions", "moneyIn", "holdNote", "firCopyNote", "items", "periodFrom", "periodTo", "periodText", "scope", "sections", "district", "lossNote"],
  followUp: ["parentReference", "subjectLabel", "outstandingItems", "responseDate"],
} as const;

export function placeholdersFor(templateCategory: string): string[] {
  return [...TEMPLATE_PLACEHOLDERS.common, ...(templateCategory === "FOLLOW_UP" ? TEMPLATE_PLACEHOLDERS.followUp : TEMPLATE_PLACEHOLDERS.subject)];
}

export function unknownPlaceholders(text: string, allowed: readonly string[]): string[] {
  const found = [...text.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)].map((m) => m[1]!);
  return [...new Set(found.filter((k) => !allowed.includes(k)))];
}
