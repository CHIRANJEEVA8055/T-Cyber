import { z } from "zod";
import { parseRupeesToMinor } from "@/domain/money";
import { istInputToUtc } from "@/domain/time";

/** Shared between the New FIR form (client) and the case service (server). */

export const PARTY_ROLES = ["VICTIM", "COMPLAINANT", "WITNESS", "PERSON_OF_INTEREST", "ACCOUNT_HOLDER_ON_RECORD", "OTHER"] as const;
export const PARTY_ROLE_LABELS: Record<(typeof PARTY_ROLES)[number], string> = {
  VICTIM: "Victim",
  COMPLAINANT: "Complainant",
  WITNESS: "Witness",
  PERSON_OF_INTEREST: "Person of interest",
  ACCOUNT_HOLDER_ON_RECORD: "Account holder on record",
  OTHER: "Other",
};

export const INTAKE_IDENTIFIER_KINDS = ["BANK_ACCOUNT", "UPI_ID", "WALLET", "PHONE", "EMAIL", "PLATFORM_PROFILE", "WEBSITE", "IP_ADDRESS", "DEVICE"] as const;
export const IDENTIFIER_KIND_LABELS: Record<string, string> = {
  PERSON: "Person",
  ORGANISATION: "Organisation",
  BANK_ACCOUNT: "Bank account",
  UPI_ID: "UPI ID",
  WALLET: "Wallet",
  PHONE: "Phone number",
  EMAIL: "Email address",
  PLATFORM_PROFILE: "Platform profile",
  WEBSITE: "Website",
  IP_ADDRESS: "IP address",
  DEVICE: "Device",
  CASH: "Cash withdrawal",
};

const optionalText = (max: number) => z.string().trim().max(max).optional().transform((v) => (v ? v : undefined));

export const partyInputSchema = z.object({
  name: z.string().trim().min(2, "Enter the person's name as recorded.").max(120),
  role: z.enum(PARTY_ROLES),
  lossRupees: optionalText(30),
});

export const identifierInputSchema = z.object({
  kind: z.enum(INTAKE_IDENTIFIER_KINDS),
  value: z.string().trim().min(3, "Enter the identifier exactly as recorded.").max(200),
  label: optionalText(80),
  role: optionalText(200),
  bank: optionalText(120),
});

export const createCaseSchema = z
  .object({
    referenceType: z.enum(["FIR", "COMPLAINT"]),
    firNumber: optionalText(10),
    firYear: z.string().trim().regex(/^\d{4}$/, "Enter a four-digit year."),
    complaintRef: optionalText(60),
    investigatingOfficerId: z.string().min(1, "Choose the investigating officer."),
    title: z.string().trim().min(5, "Enter a short case title (at least 5 characters).").max(160),
    fraudCategory: optionalText(80),
    incidentStart: optionalText(20),
    incidentEnd: optionalText(20),
    reportedAt: optionalText(20),
    narrative: z.string().trim().max(20000).default(""),
    legalSections: optionalText(500),
    parties: z.array(partyInputSchema).max(50).default([]),
    identifiers: z.array(identifierInputSchema).max(100).default([]),
  })
  .superRefine((v, ctx) => {
    if (v.referenceType === "FIR") {
      if (!v.firNumber || !/^\d{1,6}$/.test(v.firNumber) || Number(v.firNumber) < 1) {
        ctx.addIssue({ code: "custom", path: ["firNumber"], message: "Enter the FIR number (digits only)." });
      }
    } else if (!v.complaintRef) {
      ctx.addIssue({ code: "custom", path: ["complaintRef"], message: "Enter the complaint or NCRP acknowledgement reference." });
    }
    for (const key of ["incidentStart", "incidentEnd", "reportedAt"] as const) {
      const value = v[key];
      if (value && !istInputToUtc(value)) ctx.addIssue({ code: "custom", path: [key], message: "Enter a valid date and time." });
    }
    if (v.incidentStart && v.incidentEnd) {
      const a = istInputToUtc(v.incidentStart);
      const b = istInputToUtc(v.incidentEnd);
      if (a && b && b < a) ctx.addIssue({ code: "custom", path: ["incidentEnd"], message: "The end of the incident must be after the start." });
    }
    v.parties.forEach((p, i) => {
      if (p.lossRupees) {
        const parsed = parseRupeesToMinor(p.lossRupees);
        if (!parsed.ok) ctx.addIssue({ code: "custom", path: ["parties", i, "lossRupees"], message: parsed.error });
      }
      if (p.lossRupees && p.role !== "VICTIM") {
        ctx.addIssue({ code: "custom", path: ["parties", i, "lossRupees"], message: "Only a victim can have a recorded loss." });
      }
    });
  });

export type CreateCaseInput = z.input<typeof createCaseSchema>;
export type CreateCaseParsed = z.output<typeof createCaseSchema>;

/** Flattens Zod issues to { "parties.0.name": "message" } for inline form errors. */
export function zodFieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".");
    if (!out[key]) out[key] = issue.message;
  }
  return out;
}
