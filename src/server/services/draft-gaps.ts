import { formatInr } from "@/domain/money";
import { formatDateIST } from "@/domain/time";
import { shownId } from "@/domain/identifiers";

/**
 * When a request cannot be addressed yet: what is missing, why it matters, and how the officer can find it, step by
 * step, from what the case already holds (the payment and its reference, the complainant's bank, the FIR, the
 * knowledge base). The request can still be drafted in full with only the addressee left blank; it is then edited
 * and printed as usual, and approved and sent once the missing detail is recorded and the draft is addressed.
 * Nothing here looks anything up outside the station; the steps say what the officer can do.
 */

export type GapKind = "BANK" | "UPI_BANK" | "MAIL_PROVIDER" | "PLATFORM" | "REGISTRAR" | "NODAL_ADDRESS" | "ROUTE" | "NO_SUBJECT";

export interface GapStep {
  text: string;
  link: { label: string; href: string } | null;
}

export interface DraftGap {
  kind: GapKind;
  /** What is missing, in one sentence. */
  missing: string;
  /** Who the letter is for, in words: printed where the addressee goes when it is drafted without one. */
  addressee: string;
  /** Why the request cannot be addressed without it. */
  why: string;
  /** Whether the request can be drafted now with the addressee left blank. */
  canDraftWithout: boolean;
  /** How to get the missing detail, in order, using the details already in the case. */
  steps: GapStep[];
  /** The detail the officer can record from the dialog, on the identifier it belongs to. */
  record: { entityId: string; field: "bank" | "provider"; label: string; placeholder: string; hint: string } | null;
  /** All of it as one line, for lists and messages. */
  message: string;
}

export interface GapContext {
  caseId: string;
  category: string;
  subject: { id: string; kind: string; value: string; label: string } | null;
  /** The subject is the complainant's (or a victim's) own account, not one the money went to. */
  subjectIsVictims?: boolean;
  /** Payments into the subject, oldest first. */
  incoming: { amountMinor: bigint; occurredAt: Date; reference: string | null }[];
  /** The complainant's accounts with a bank recorded. */
  victimBanks: string[];
  /** An open action that asks the complainant's bank where the payments went ("Ask SBI where …"). */
  victimDebitsAction: string | null;
  hasFirCopy: boolean;
  complaintRef: string | null;
  /** NODAL_ADDRESS: the provider whose address is missing. */
  providerName?: string | null;
}

const domainOf = (v: string) => (v.includes("@") ? v.split("@").pop()! : v.replace(/^https?:\/\//i, "").split(/[/?#]/)[0]!).toLowerCase();
const ask = (q: string) => `/assistant?ask=${encodeURIComponent(q)}`;

/** The one-line description of what is missing, used where only text fits (an error, a list). */
export function gapMessage(g: Pick<DraftGap, "missing" | "canDraftWithout">): string {
  return g.canDraftWithout ? `Not addressed yet: ${g.missing} It can be drafted now with the addressee left blank, or addressed once this is recorded.` : g.missing;
}

export function draftGapFor(kind: GapKind, ctx: GapContext): DraftGap {
  const s = ctx.subject;
  const intake = { label: ctx.hasFirCopy ? "Open the FIR" : "Upload the FIR or receipts", href: `/cases/${ctx.caseId}/intake` };
  const people = { label: "Open people & identifiers", href: `/cases/${ctx.caseId}/people` };
  const firstPaid = ctx.incoming[0];
  const paid = firstPaid ? `${formatInr(firstPaid.amountMinor)} on ${formatDateIST(firstPaid.occurredAt)}${firstPaid.reference && !firstPaid.reference.includes("?") ? ` (reference ${firstPaid.reference})` : ""}` : null;
  let g: Omit<DraftGap, "message">;
  switch (kind) {
    case "BANK": {
      const acc = shownId(s!.value);
      // The complainant's own account: the complainant knows the bank; payment and beneficiary steps do not apply.
      if (ctx.subjectIsVictims) {
        g = {
          kind,
          missing: `The bank of the complainant's account ${acc} is not recorded.`,
          addressee: `the bank holding the complainant's account ${acc}`,
          why: "The request goes to that bank's nodal officer, so the bank decides where it is sent.",
          canDraftWithout: true,
          steps: [
            { text: `Ask the complainant which bank holds account ${acc}: the passbook, a cheque leaf, net banking or the bank's SMS alerts show the bank and the IFSC.`, link: null },
            { text: `Look in the FIR for the bank's name or an IFSC beside account ${acc}. The first four letters of an IFSC name the bank: SBIN is State Bank of India, HDFC is HDFC Bank, ICIC is ICICI Bank.`, link: intake },
            { text: `${ctx.complaintRef ? `The NCRP complaint ${ctx.complaintRef}` : "If the complaint came through 1930 or NCRP, it"} names the complainant's bank for each reported transaction.`, link: null },
            { text: "Record the bank or the IFSC below. The draft is then addressed to that bank's nodal officer from the nodal officer list.", link: null },
          ],
          record: { entityId: s!.id, field: "bank", label: `Bank or IFSC of account ${acc}`, placeholder: "SBIN0001234, or State Bank of India", hint: "An IFSC is read for its bank." },
        };
        break;
      }
      g = {
        kind,
        missing: `The bank of account ${acc} is not recorded.`,
        addressee: `the bank holding account ${acc}`,
        why: "The request goes to that bank's nodal officer, so the bank decides where it is sent.",
        canDraftWithout: true,
        steps: [
          { text: `Look in the FIR, and in any receipt or screenshot the complainant gave, for an IFSC beside account ${acc}. Its first four letters name the bank: SBIN is State Bank of India, HDFC is HDFC Bank, ICIC is ICICI Bank.`, link: intake },
          paid
            ? { text: `The complainant paid ${paid} to this account. The payment app's transaction details (PhonePe, Google Pay, Paytm) or the bank's SMS for that payment show the receiving bank and IFSC.`, link: { label: "How to read them", href: ask("How do I collect PhonePe or Google Pay fraud transaction details, including the receiving bank and IFSC?") } }
            : { text: `Ask the complainant for the receipt or app screenshot of the payment to ${acc}: it shows the receiving bank and IFSC.`, link: { label: "How to read them", href: ask("How do I collect PhonePe or Google Pay fraud transaction details, including the receiving bank and IFSC?") } },
          ctx.victimDebitsAction
            ? { text: `${ctx.victimDebitsAction} is in Next actions: that bank's reply gives the beneficiary account, IFSC and bank of each debit.`, link: null }
            : ctx.victimBanks.length
              ? { text: `${ctx.victimBanks[0]}, the complainant's bank, can give the beneficiary account, IFSC and bank of each debit from the complainant's account.`, link: null }
              : { text: "If the complainant's own account and bank are recorded, that bank can give the beneficiary's bank and IFSC for each debit. Record them under People & identifiers.", link: people },
          { text: `${ctx.complaintRef ? `The NCRP complaint ${ctx.complaintRef}` : "If the complaint came through 1930 or NCRP, its"} transaction trail on the NCRP police portal lists the bank each payment reached.`, link: null },
          { text: "Record the bank or the IFSC below. The draft is then addressed to that bank's nodal officer from the nodal officer list.", link: null },
        ],
        record: { entityId: s!.id, field: "bank", label: `Bank or IFSC of account ${acc}`, placeholder: "SBIN0001234, or State Bank of India", hint: "An IFSC is read for its bank." },
      };
      break;
    }
    case "UPI_BANK":
      g = {
        kind,
        missing: `The bank behind UPI ID ${s!.value} is not known yet.`,
        addressee: `the bank holding the account behind UPI ID ${s!.value}`,
        why: "A hold or preservation goes to the bank that holds the account, and a UPI ID alone does not say which.",
        canDraftWithout: true,
        steps: [
          { text: `Ask NPCI for the account behind ${s!.value} (an information request, in Next actions). Its reply names the bank and the account number.`, link: null },
          paid
            ? { text: `In the complainant's UPI app, the payment of ${paid} shows the payee's bank account (the bank's name and the last digits).`, link: { label: "How to read it", href: ask("How do I collect Google Pay or PhonePe fraud transaction details for a UPI payment?") } }
            : { text: "Ask the complainant for the UPI payment screenshot: it shows the payee's bank account (the bank's name and the last digits).", link: null },
          { text: "The part after @ names the UPI app's partner bank, which is not always the bank that holds the account. Record a bank only when a record or receipt shows it.", link: null },
          { text: "Record the bank below once a record shows it.", link: null },
        ],
        record: { entityId: s!.id, field: "bank", label: `Bank behind ${s!.value}`, placeholder: "The bank named in NPCI's reply or the receipt", hint: "Only from a record or a receipt, not from the UPI handle." },
      };
      break;
    case "MAIL_PROVIDER": {
      const d = domainOf(s!.value);
      g = {
        kind,
        missing: `Who runs the mail for ${d} is not known.`,
        addressee: `the provider of the mail service for ${d}`,
        why: "The request goes to the company that hosts the mailbox, which the address alone does not show.",
        canDraftWithout: true,
        steps: [
          { text: `Look up the mail (MX) records of ${d}: on any computer run "nslookup -type=mx ${d}", or use an online MX lookup. The mail server's name shows the provider (google.com is Google, outlook.com is Microsoft, zoho.com is Zoho).`, link: null },
          { text: `Or open the full headers of an email from ${s!.value} (in Gmail, "Show original"): the Received lines show which mail service sent it.`, link: { label: "How to read headers", href: ask("How do I gather email fraud information from the email headers?") } },
          { text: "Record the provider below.", link: null },
        ],
        record: { entityId: s!.id, field: "provider", label: `Mail provider for ${d}`, placeholder: "Google, Microsoft, Zoho …", hint: "The company that hosts the mailbox." },
      };
      break;
    }
    case "PLATFORM":
      g = {
        kind,
        missing: `The platform of profile ${s!.value} is not recorded.`,
        addressee: `the platform where profile ${s!.value} is`,
        why: "The request goes to the platform's law-enforcement team.",
        canDraftWithout: true,
        steps: [
          { text: "Check the FIR and the complainant's screenshots for the app's name next to the profile.", link: intake },
          { text: "Ask the complainant which app the profile was on, and for the profile's link or a screenshot showing its URL or ID.", link: { label: "How to collect it", href: ask("How do I collect Instagram or Facebook profile information related to fraud incidents?") } },
          { text: "Record the platform below.", link: null },
        ],
        record: { entityId: s!.id, field: "provider", label: `Platform of ${s!.value}`, placeholder: "Instagram, Facebook, Telegram …", hint: "Where the profile is." },
      };
      break;
    case "REGISTRAR": {
      const d = domainOf(s!.value);
      g = {
        kind,
        missing: `The registrar of ${d} is not recorded.`,
        addressee: `the registrar of ${d}`,
        why: "Registration and payment records of a site are asked of its registrar.",
        canDraftWithout: true,
        steps: [
          { text: `Look up ${d} on a WHOIS service (for example lookup.icann.org): the "Registrar" line names it, with its abuse contact.`, link: { label: "How to look it up", href: ask("How do I gather URL fraud information using WHOIS?") } },
          { text: "If the site is hosted elsewhere, the WHOIS of its IP address names the hosting company, which can be asked as well.", link: null },
          { text: "Record the registrar below.", link: null },
        ],
        record: { entityId: s!.id, field: "provider", label: `Registrar of ${d}`, placeholder: "GoDaddy, Namecheap, Hostinger …", hint: "As the WHOIS record names it." },
      };
      break;
    }
    case "NODAL_ADDRESS": {
      const p = ctx.providerName ?? "This provider";
      g = {
        kind,
        missing: `${p} has no email address on the nodal officer list.`,
        addressee: `${p}, whose address is not on the nodal officer list`,
        why: "Requests go only to an address from the nodal officer list or one a supervisor has confirmed.",
        canDraftWithout: true,
        steps: [
          { text: `Import the latest nodal officer list (Settings, Nodal officers): ${p} may be on a newer list.`, link: { label: "Open nodal officers", href: "/settings/nodal" } },
          { text: `${p}'s law-enforcement contact may be on the intermediary nodal list on the NCRP police portal, or on its own law-enforcement request page.`, link: null },
          { text: "Once a supervisor confirms the address and adds it to the recipient directory, address the draft from Next actions.", link: null },
        ],
        record: null,
      };
      break;
    }
    case "ROUTE":
      g = {
        kind,
        missing: `No recipient is set up for ${ctx.category.toLowerCase()} requests about ${s ? `a ${s.kind.toLowerCase().replace(/_/g, " ")}` : "this identifier"}.`,
        addressee: ctx.providerName ? `${ctx.providerName}, whose address is not set up` : "the organisation that holds these records",
        why: "Without a recipient the request has nowhere to go.",
        canDraftWithout: true,
        steps: [
          { text: "Set up the recipient and a routing rule (Settings, Routes), then address the draft.", link: { label: "Open routes", href: "/settings/routes" } },
          { text: "Or open the draft in the request editor and choose the recipient there.", link: null },
        ],
        record: null,
      };
      break;
    case "NO_SUBJECT":
    default:
      g = {
        kind: "NO_SUBJECT",
        missing: "This action has no identifier to address the request to.",
        addressee: "the recipient",
        why: "A request is about one account, number, address or profile.",
        canDraftWithout: false,
        steps: [{ text: "Record the identifier the request is about under People & identifiers.", link: people }],
        record: null,
      };
  }
  return { ...g, message: gapMessage(g) };
}
