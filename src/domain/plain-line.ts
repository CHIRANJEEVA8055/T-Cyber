/**
 * One plain line for a next action, as an officer would say it: what to do, about which account, number or address
 * (with its last digits), and why, in one or two short sentences. Built from the action's own record (its title, the
 * relevance written by the rules, the subject and the recipient); nothing is added that the record does not say.
 */

import { shownId } from "@/domain/identifiers";

export interface LineInput {
  ruleId: string | null;
  title: string;
  why: string;
  subject: { kind: string; label: string; value: string } | null;
  org: string | null;
}

const firstAmount = (s: string) => /₹[\d,]+(?:\.\d+)?/.exec(s)?.[0] ?? null;
const firstDate = (s: string) => /\b(\d{2} [A-Z][a-z]{2})(?: \d{4})?\b/.exec(s)?.[1] ?? null;
// The rules' bookkeeping openers ("Reopened by you.", "Added by an officer.") say nothing about the task.
const firstSentence = (s: string) => (s.replace(/^(?:Reopened by you|Added by an officer)\.\s*/g, "").replace(/^(?:Reopened by you|Added by an officer)\.\s*/, "").match(/^.*?[.!?](?=\s|$)/)?.[0] ?? s).trim();

/** "account Account B (···2093)", "mobile ···41", "UPI ID x@bank", "the address x@y.com". */
export function nameOf(s: LineInput["subject"]): string {
  if (!s) return "";
  switch (s.kind) {
    case "BANK_ACCOUNT":
      return s.label && s.label !== s.value && !/^XX/i.test(s.label) ? `${/^account\b/i.test(s.label) ? s.label : `account ${s.label}`} (${shownId(s.value)})` : `account ${shownId(s.value)}`;
    case "PHONE":
      return `mobile ${shownId(s.value)}`;
    case "UPI_ID":
      return `UPI ID ${s.value}`;
    case "EMAIL":
      return `the address ${s.value}`;
    case "PLATFORM_PROFILE":
      return `the profile ${s.label || s.value}`;
    case "WEBSITE":
      return `the site ${s.value.replace(/^https?:\/\//, "").split("/")[0]}`;
    default:
      return s.label || s.value;
  }
}

export function plainLine(a: LineInput): string {
  const id = nameOf(a.subject);
  const amt = firstAmount(a.why);
  const date = firstDate(a.why);
  const org = a.org ?? "the bank";
  const got = amt ? `It got ${amt}${/from the victim|directly from the victim/i.test(a.why) ? " from the victim" : ""}${date ? ` on ${date}` : ""}` : "";
  switch (a.ruleId) {
    case "FUNDS_HOLD":
      return `Ask ${org} to freeze ${id}. ${got ? `${got}, and the money can still be stopped.` : "The money in it can still be stopped."}`;
    case "FUNDS_TRACE":
      return /KYC only|holds all of it|no onward movement/i.test(a.why)
        ? `Ask ${org} who owns ${id}. ${got ? `${got} and still holds it.` : "It still holds the money."}`
        : `Ask ${org} for the statement and owner details of ${id}. ${got ? `${got}; this shows who owns it and where the money went next.` : "This shows who owns it and where the money went next."}`;
    case "FUNDS_VICTIM_DEBITS":
      return `Find the accused's accounts: ask ${a.org && !/account-holding bank/i.test(a.org) ? a.org : "the complainant's bank"} which accounts got the complainant's money from ${id}. Each one named is frozen and traced next.`;
    case "FUNDS_VICTIM_STATEMENT":
      return "Find the accused's accounts: add the NCRP trail, or the complainant's statement or payment screenshots, with Add files. Each receiving account is read in, to be frozen and traced.";
    case "FUNDS_BALANCE_GAP":
      return `Ask ${org} how much is left in ${id}. The bank has not said yet, and the freeze depends on it.`;
    case "IDENTITY_SUBSCRIBER":
      return `Ask ${org} for the call records and ID form of ${id}. They show who registered and uses this number.`;
    case "IDENTITY_CALLER_NUMBER":
      return `Ask ${org} for the call records and ID form of ${id}. The accused called from it; the records show who uses it and where.`;
    case "IDENTITY_WHATSAPP":
      return `Ask WhatsApp who registered ${id} on WhatsApp. Their records give the account details and the IP addresses used.`;
    case "IDENTITY_IP_CORRELATION":
      return `${a.title}. The internet provider can name the user only with the exact time and port.`;
    case "EVIDENCE_ATM_CCTV":
      return `${a.title}. The camera may show who took the cash, and footage is kept only 30 to 90 days.`;
    case "EVIDENCE_PRESERVATION":
      return `Ask the provider to keep the records of ${id}. It is named in the complaint, and old records can be deleted.`;
    case "IDENTITY_ACCOUNT_DETAILS":
      return `Ask ${a.org ?? (a.subject?.kind === "EMAIL" ? "the mail provider" : "the platform")} who registered ${id}: its phone numbers, recovery email and login IP addresses lead to the person behind it.`;
    case "EVIDENCE_WEBSITE":
      return `Ask the registrar who registered and paid for ${id}. The site was used in the fraud.`;
    default: {
      const w = firstSentence(a.why);
      return w && !a.title.includes(w) ? `${a.title.replace(/\.$/, "")}. ${w}` : a.title;
    }
  }
}
