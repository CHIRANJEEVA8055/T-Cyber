/**
 * One vocabulary for statuses across every screen. Each status has a tone (colour) AND a label,
 * and the badge also shows an icon, so meaning never depends on colour alone.
 */
export type Tone = "neutral" | "info" | "success" | "warning" | "danger";

export interface StatusDef {
  label: string;
  tone: Tone;
  icon: IconName;
}

export type IconName =
  | "draft"
  | "hourglass"
  | "approved"
  | "send"
  | "inbox"
  | "partial"
  | "check"
  | "x"
  | "alert"
  | "dot"
  | "clock"
  | "lock"
  | "pause"
  | "minus"
  | "eye"
  | "question"
  | "link";

const S = (label: string, tone: Tone, icon: IconName): StatusDef => ({ label, tone, icon });

export const STATUS: Record<string, Record<string, StatusDef>> = {
  request: {
    DRAFT: S("Draft", "neutral", "draft"),
    AWAITING_APPROVAL: S("Awaiting approval", "warning", "hourglass"),
    APPROVED: S("Approved", "info", "approved"),
    SUBMITTED: S("Submitted", "info", "send"),
    ACKNOWLEDGED: S("Acknowledged", "info", "inbox"),
    PARTIAL_RESPONSE: S("Partial response", "warning", "partial"),
    COMPLETE_RESPONSE: S("Complete response", "success", "check"),
    REJECTED: S("Rejected", "danger", "x"),
    SUBMISSION_FAILED: S("Submission failed", "danger", "alert"),
    DISCARDED: S("Discarded before sending", "neutral", "x"),
  },
  task: {
    OPEN: S("Open", "info", "dot"),
    DRAFT_PREPARED: S("Draft prepared", "info", "draft"),
    WAITING: S("Waiting on response", "neutral", "clock"),
    DEFERRED: S("Deferred", "neutral", "pause"),
    DISMISSED: S("Dismissed", "neutral", "minus"),
    COMPLETED: S("Completed", "success", "check"),
    SUPERSEDED: S("Superseded", "neutral", "minus"),
  },
  hold: {
    REQUESTED: S("Hold requested", "neutral", "clock"),
    RESTRICTION_CONFIRMED: S("Restricted, amount unknown", "warning", "lock"),
    CONFIRMED_HELD: S("Funds held", "success", "lock"),
    RELEASED: S("Released", "neutral", "minus"),
  },
  allocation: {
    PROPOSED: S("Proposed", "warning", "question"),
    CONFIRMED: S("Confirmed", "success", "check"),
    WITHDRAWN: S("Withdrawn", "neutral", "minus"),
  },
  refund: {
    AUTHORISED: S("Authorised", "info", "approved"),
    INITIATED: S("Initiated", "info", "send"),
    CREDIT_CONFIRMED: S("Credit confirmed", "success", "check"),
    FAILED: S("Failed", "danger", "alert"),
    CANCELLED: S("Cancelled", "neutral", "minus"),
  },
  transaction: {
    REPORTED_BY_VICTIM: S("Reported by victim", "neutral", "dot"),
    CONFIRMED_BY_BANK: S("Confirmed by bank", "success", "check"),
    REPORTED_ON_NCRP: S("Reported on NCRP", "neutral", "dot"),
    DISPUTED: S("Disputed", "danger", "alert"),
  },
  verification: {
    UNVERIFIED: S("Unverified", "neutral", "question"),
    CORROBORATED: S("Corroborated", "success", "check"),
    DISPUTED: S("Disputed", "danger", "alert"),
    VERIFIED: S("Verified", "success", "check"),
    EXPIRED: S("Expired", "warning", "clock"),
  },
  classification: {
    NEW: S("New", "info", "dot"),
    ALREADY_KNOWN: S("Already known", "neutral", "link"),
    CONFLICTING: S("Conflicting", "danger", "alert"),
    INCOMPLETE: S("Incomplete", "warning", "partial"),
    UNCERTAIN: S("Uncertain", "warning", "question"),
  },
  decision: {
    PENDING: S("Not reviewed", "neutral", "dot"),
    ACCEPTED: S("Accepted", "success", "check"),
    EDITED: S("Accepted with edits", "success", "check"),
    REJECTED: S("Rejected", "danger", "x"),
    DEFERRED: S("Deferred", "neutral", "pause"),
  },
  review: {
    UNREVIEWED: S("Awaiting review", "warning", "eye"),
    IN_REVIEW: S("In review", "info", "eye"),
    APPLIED: S("Reviewed", "success", "check"),
    REVIEWED: S("Reviewed", "success", "check"),
  },
  match: {
    MATCHED: S("Matched", "success", "link"),
    NEEDS_MATCH_REVIEW: S("Match needs review", "warning", "question"),
    UNMATCHED: S("Unmatched", "danger", "question"),
  },
  processing: {
    PENDING: S("Processing", "neutral", "clock"),
    TEXT_EXTRACTED: S("Text extracted", "success", "check"),
    TABLE_PARSED: S("Table parsed", "success", "check"),
    NO_TEXT_LAYER: S("No text layer", "warning", "alert"),
    ENCRYPTED: S("Password-protected", "warning", "lock"),
    UNSUPPORTED: S("Not parsed", "neutral", "minus"),
    FAILED: S("Could not open", "danger", "alert"),
  },
  evidenceReview: {
    UNREVIEWED: S("Not reviewed", "neutral", "dot"),
    IN_REVIEW: S("Extraction in review", "warning", "eye"),
    REVIEWED: S("Extraction reviewed", "success", "check"),
  },
  candidate: {
    PENDING: S("Not reviewed", "neutral", "dot"),
    ACCEPTED: S("Read correctly", "success", "check"),
    CORRECTED: S("Corrected", "success", "check"),
    REJECTED: S("Rejected", "danger", "x"),
    ADDED: S("Added manually", "info", "draft"),
  },
  item: {
    PENDING: S("Pending", "neutral", "clock"),
    RECEIVED: S("Received", "success", "check"),
    PARTIAL: S("Partly received", "warning", "partial"),
    NOT_PROVIDED: S("Not provided", "danger", "x"),
  },
  corroboration: {
    UNCORROBORATED: S("Uncorroborated", "neutral", "question"),
    CORROBORATED: S("Corroborated", "success", "check"),
    CONTRADICTED: S("Contradicted", "danger", "alert"),
  },
  case: {
    OPEN: S("Open", "info", "dot"),
    CLOSED: S("Closed", "neutral", "lock"),
  },
  report: {
    DRAFT: S("Draft", "neutral", "draft"),
    REVIEWED: S("Reviewed", "success", "check"),
  },
  knowledge: {
    CURRENT: S("Current", "success", "check"),
    SUPERSEDED: S("Superseded", "neutral", "minus"),
    WITHDRAWN: S("Withdrawn", "danger", "alert"),
  },
  guidance: {
    ANSWER: S("Answered from the library", "success", "check"),
    CONFLICT: S("Current sources differ", "warning", "alert"),
    INSUFFICIENT: S("Not covered by the library", "neutral", "question"),
  },
};

export function statusDef(kind: keyof typeof STATUS | string, value: string): StatusDef {
  return STATUS[kind]?.[value] ?? { label: value.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase()), tone: "neutral", icon: "dot" };
}

export const REQUEST_CATEGORY_LABELS: Record<string, string> = {
  INFORMATION: "Information request",
  PRESERVATION: "Preservation",
  HOLD: "Hold / debit freeze",
  RESTORATION: "Restoration",
};

export const CHANNEL_LABELS: Record<string, string> = {
  EMAIL: "Email (simulated)",
  PORTAL: "Provider portal (officer-recorded)",
  UNICROSS: "UNICROSS route (simulated)",
  NPCI_ROUTE: "NPCI route (simulated)",
};

/** The email channel as shown: real, not simulated, when requests go out through the linked Gmail account. */
export function emailChannelText(gmail: { on: boolean; connected: boolean; account: string | null } | null | undefined): string {
  if (!gmail?.on) return CHANNEL_LABELS.EMAIL!;
  return gmail.connected ? `Email, sent from the linked Gmail account${gmail.account ? ` (${gmail.account})` : ""}` : "Email through Gmail (the Gmail link is not connected yet)";
}
export const channelText = (channel: string, gmail?: { on: boolean; connected: boolean; account: string | null } | null) => (channel === "EMAIL" ? emailChannelText(gmail) : (CHANNEL_LABELS[channel] ?? channel));

export const PAYMENT_CHANNEL_LABELS: Record<string, string> = {
  UPI: "UPI",
  IMPS: "IMPS",
  NEFT: "NEFT",
  RTGS: "RTGS",
  CASH_WITHDRAWAL: "Cash withdrawal",
  CARD: "Card",
  OTHER: "Other or not stated",
};

export const RELATIONSHIP_STATUS_TEXT: Record<string, string> = {
  ASSERTED: "As stated in the source; not independently verified",
  CORROBORATED: "Corroborated by another source",
  DISPUTED: "Disputed",
  REFUTED: "Refuted",
};

export const OBJECTIVE_LABELS: Record<string, string> = {
  FINANCIAL: "Financial recovery",
  IDENTITY: "Identity and location",
  EVIDENCE: "Evidence",
};

export const ITEM_TYPE_LABELS: Record<string, string> = {
  STATEMENT: "Statement",
  KYC: "KYC",
  BALANCE_CONFIRMATION: "Balance",
  HOLD_CONFIRMATION: "Hold confirmation",
  SUBSCRIBER_DETAILS: "Subscriber details",
  ACCOUNT_DETAILS: "Account holder details",
  BENEFICIARY_DETAILS: "Beneficiary of each debit",
  CDR: "Call detail records (CDR)",
  IP_LOGS: "Session details",
  PRESERVATION_CONFIRMATION: "Preservation",
  RESTORATION_CONFIRMATION: "Restoration",
  OTHER: "Other",
};

export const DERIVATION_LABELS: Record<string, string> = {
  ORIGINAL: "Original",
  EXTRACTED_TEXT: "Extracted text",
  OCR_TEXT: "OCR text",
  TRANSLATION: "Translation",
  ANNOTATION: "Officer annotation",
  AI_SUMMARY: "Demo assistant summary",
  PREPARED: "Prepared by hand, not the CCTNS copy",
};

export const EVIDENCE_CATEGORY_LABELS: Record<string, string> = {
  FIR_COPY: "FIR copy",
  COMPLAINT: "Complaint",
  TRANSACTION_RECORD: "Transaction record",
  BANK_RESPONSE: "Bank response",
  TELECOM_RESPONSE: "Telecom response",
  PROVIDER_RESPONSE: "Provider response",
  EMAIL_MESSAGE: "Message",
  SCREENSHOT: "Screenshot",
  OTHER: "Other",
};

export const RELATIONSHIP_LABELS: Record<string, string> = {
  REGISTERED_TO: "Registered to",
  USED_BY: "Used by",
  CONTROLLED_BY: "Controlled by",
  POTENTIALLY_ASSOCIATED_WITH: "Potentially associated with",
  LINKED_IDENTIFIER: "Linked by record",
  CONTACTED: "Contacted",
};

export const PARTY_ROLE_TEXT: Record<string, string> = {
  VICTIM: "Victim",
  COMPLAINANT: "Complainant",
  WITNESS: "Witness",
  PERSON_OF_INTEREST: "Person of interest",
  ACCOUNT_HOLDER_ON_RECORD: "Account holder on record",
  OTHER: "Other",
};
