/**
 * What links several documents or cases: the same account, UPI ID, phone number, email, website, IP address, handset or
 * transaction reference appearing in more than one of them. Found by exact matching of the normalised values, so a
 * link is only claimed where the same identifier is really written in both. A partly hidden account number whose
 * shown digits fit is only a possible link. The same name is listed apart: it may be two different people.
 * Pure: no I/O.
 */
import { compareAccounts } from "./file-reading";
import { normalizeIdentifier } from "./identifiers";

export interface ConnItem {
  kind: string;
  value: string;
  /** Where in the attachment it is written: a passage reference such as "D3" or "C2". */
  where: string;
}
export interface ConnDoc {
  tag: string;
  label: string;
  items: ConnItem[];
}
export interface Connection {
  kind: string;
  value: string;
  strength: "SAME" | "POSSIBLE" | "NAME";
  in: { tag: string; label: string; refs: string[] }[];
  note: string | null;
}

const ORDER = ["BANK_ACCOUNT", "UPI_ID", "PHONE", "EMAIL", "WEBSITE", "IP_ADDRESS", "TXN_REFERENCE", "DEVICE", "PLATFORM_PROFILE", "PERSON_NAME"];
export const KIND_WORD: Record<string, string> = { BANK_ACCOUNT: "Account", UPI_ID: "UPI ID", PHONE: "Mobile", EMAIL: "Email", WEBSITE: "Website", IP_ADDRESS: "IP address", TXN_REFERENCE: "Transaction reference", DEVICE: "Handset", PLATFORM_PROFILE: "Profile", PERSON_NAME: "Name" };
/** The kind as it reads inside a sentence ("UPI ID" and "IP address" keep their capitals). */
export const kindPhrase = (kind: string) => {
  const w = KIND_WORD[kind] ?? kind.replace(/_/g, " ").toLowerCase();
  return /^(UPI|IP)\b/.test(w) ? w : w.charAt(0).toLowerCase() + w.slice(1);
};

/** A name as a matching key: lower case, without titles and punctuation. Only names of two words or more are kept. */
export function nameKey(name: string): string | null {
  const k = name
    .toLowerCase()
    .replace(/\b(mr|mrs|ms|miss|sri|shri|smt|dr|s\/o|d\/o|w\/o)\b\.?/g, " ")
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return k.split(" ").length >= 2 && k.length >= 5 ? k : null;
}

function keyOf(it: ConnItem): string | null {
  if (it.kind === "PERSON_NAME") return nameKey(it.value);
  if (it.kind === "TXN_REFERENCE") return it.value.replace(/\s/g, "").toUpperCase();
  const k = normalizeIdentifier(it.kind, it.value);
  // A fully hidden or very short value links nothing.
  return k.replace(/[X+]/g, "").length >= 4 ? k : null;
}

export function findConnections(docs: ConnDoc[]): Connection[] {
  type G = { kind: string; value: string; docs: Map<string, Set<string>> };
  const groups = new Map<string, G>();
  for (const d of docs)
    for (const it of d.items) {
      const k = keyOf(it);
      if (!k) continue;
      const id = `${it.kind}|${k}`;
      const g = groups.get(id) ?? { kind: it.kind, value: it.value, docs: new Map() };
      g.docs.set(d.tag, (g.docs.get(d.tag) ?? new Set()).add(it.where));
      groups.set(id, g);
    }
  const label = new Map(docs.map((d) => [d.tag, d.label]));
  const out: Connection[] = [];
  for (const g of groups.values()) {
    if (g.docs.size < 2) continue;
    out.push({
      kind: g.kind,
      value: g.value,
      strength: g.kind === "PERSON_NAME" ? "NAME" : "SAME",
      in: [...g.docs.entries()].map(([tag, refs]) => ({ tag, label: label.get(tag) ?? tag, refs: [...refs].slice(0, 4) })),
      note: g.kind === "PERSON_NAME" ? "The same name: it may be different people. Check it before linking them." : null,
    });
  }
  // A partly hidden account in one and a full one in another whose shown digits fit: possibly the same account.
  const accounts = [...groups.values()].filter((g) => g.kind === "BANK_ACCOUNT");
  for (let i = 0; i < accounts.length; i++)
    for (let j = i + 1; j < accounts.length; j++) {
      const a = accounts[i]!;
      const b = accounts[j]!;
      if (compareAccounts(a.value, b.value) !== "POSSIBLE") continue;
      const tags = new Set([...a.docs.keys(), ...b.docs.keys()]);
      if (tags.size < 2) continue;
      const merged = new Map<string, Set<string>>();
      for (const g of [a, b]) for (const [t, refs] of g.docs) merged.set(t, new Set([...(merged.get(t) ?? []), ...refs]));
      out.push({ kind: "BANK_ACCOUNT", value: `${a.value} / ${b.value}`, strength: "POSSIBLE", in: [...merged.entries()].map(([tag, refs]) => ({ tag, label: label.get(tag) ?? tag, refs: [...refs].slice(0, 4) })), note: "One of the two is partly hidden; the digits that are shown match. Confirm the full number with the bank." });
    }
  const rank = (c: Connection) => (c.strength === "SAME" ? 0 : c.strength === "POSSIBLE" ? 1 : 2);
  return out.sort((x, y) => rank(x) - rank(y) || y.in.length - x.in.length || ORDER.indexOf(x.kind) - ORDER.indexOf(y.kind)).slice(0, 40);
}
