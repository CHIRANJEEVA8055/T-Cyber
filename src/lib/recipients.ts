/**
 * Display helpers for recipient-directory entries. The configuration file gives each recipient an
 * organisation ("Demo Bank A") and a full addressee name ("Demo Bank A: Nodal Officer"); screens that show
 * both should not repeat the organisation.
 */

/** The addressee name without a leading copy of the organisation, e.g. "Nodal Officer". */
export function recipientRole(organisation: string, name: string): string {
  const base = organisation.replace(/\s*\([^)]*\)\s*$/, "").trim();
  for (const prefix of [organisation.trim(), base]) {
    if (!prefix || !name.toLowerCase().startsWith(prefix.toLowerCase())) continue;
    const rest = name
      .slice(prefix.length)
      .replace(/^[\s:,;–-]+/, "")
      .trim();
    if (rest) return rest.charAt(0).toUpperCase() + rest.slice(1);
  }
  return name;
}

/**
 * Splits an email address or portal address into pieces that may wrap: after "@" and before each "." in
 * long tokens, so a narrow column never breaks in the middle of a word.
 */
export function addressBreakPoints(address: string): string[] {
  return address.split(/(?<=@)|(?=\.)/).filter(Boolean);
}
