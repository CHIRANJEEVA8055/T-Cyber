/**
 * Browser helpers that work when T-CYBER is opened over plain HTTP on the station network (http://192.168.x.x:3000).
 * Browsers offer some APIs only in a "secure context" (HTTPS or localhost): crypto.randomUUID and the Clipboard API
 * among them. Client code uses these helpers instead of calling those APIs directly (the lint rules enforce it).
 */

/** A random v4 UUID. Uses crypto.randomUUID when offered, else crypto.getRandomValues (available on plain HTTP). */
export function newId(): string {
  const c = (globalThis as { crypto?: Partial<Crypto> }).crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const b = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(b);
  else for (let i = 0; i < b.length; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Copies text to the clipboard. On plain HTTP, where the Clipboard API is missing, it copies through a hidden text
 * area instead. Returns whether the text was copied, so the caller can say so or offer the text to select.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard && typeof window !== "undefined" && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the text-area copy */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    Object.assign(ta.style, { position: "fixed", top: "0", left: "0", opacity: "0", pointerEvents: "none" });
    const active = document.activeElement as HTMLElement | null;
    document.body.appendChild(ta);
    ta.select();
    // The older copy command still works where the Clipboard API is not offered.
    const ok = document.execCommand("copy");
    ta.remove();
    active?.focus?.();
    return ok;
  } catch {
    return false;
  }
}
