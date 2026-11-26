/**
 * Identifier normalisation for de-duplication inside a case. Values are kept exactly as
 * recorded for display; the normalised form is only a matching key. Leading zeros and
 * masking characters are always preserved so a masked number never merges with a full one.
 */

export const ENTITY_KINDS = [
  "PERSON",
  "ORGANISATION",
  "BANK_ACCOUNT",
  "UPI_ID",
  "WALLET",
  "PHONE",
  "EMAIL",
  "PLATFORM_PROFILE",
  "WEBSITE",
  "IP_ADDRESS",
  "DEVICE",
  "CASH",
] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

export const IDENTIFIER_KINDS: readonly EntityKind[] = [
  "BANK_ACCOUNT",
  "UPI_ID",
  "WALLET",
  "PHONE",
  "EMAIL",
  "PLATFORM_PROFILE",
  "WEBSITE",
  "IP_ADDRESS",
  "DEVICE",
];

/**
 * An identifier as T-CYBER shows it everywhere (screens, drafts, letters, notices): in full, exactly as recorded.
 * Officers work from the whole number, so nothing is shortened or masked. A value the source itself masked
 * ("XXXX2093") stays as the source gave it.
 */
export function shownId(value: string | null | undefined): string {
  return (value ?? "").trim();
}

export function isMaskedValue(value: string): boolean {
  return /[Xx*•]{2,}/.test(value);
}

export function normalizeIdentifier(kind: string, raw: string): string {
  const value = raw.trim();
  switch (kind) {
    case "BANK_ACCOUNT":
    case "WALLET":
      return value.replace(/[\s-]/g, "").replace(/[x*•]/g, "X").toUpperCase();
    case "PHONE": {
      let v = value.replace(/[\s()-]/g, "").replace(/[x*•]/g, "X").toUpperCase();
      if (v.startsWith("+91")) v = v.slice(3);
      else if (v.startsWith("0091")) v = v.slice(4);
      else if (v.length === 11 && v.startsWith("0")) v = v.slice(1);
      return v.length === 10 ? `+91${v}` : v;
    }
    case "EMAIL":
    case "UPI_ID":
      return value.toLowerCase();
    case "WEBSITE":
      return value
        .toLowerCase()
        .replace(/^[a-z]+:\/\//, "")
        .replace(/^www\./, "")
        .replace(/\/+$/, "");
    case "IP_ADDRESS": {
      const parts = value.split(".");
      if (parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p))) {
        return parts.map((p) => String(Number.parseInt(p, 10))).join(".");
      }
      return value.toLowerCase();
    }
    case "PLATFORM_PROFILE":
    case "DEVICE":
      return value.toLowerCase();
    default:
      return value;
  }
}
