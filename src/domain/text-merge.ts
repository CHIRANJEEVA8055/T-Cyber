/**
 * Gmail sends a draft's plain text back hard-wrapped at about 76 characters, so an edit made there arrives with line
 * breaks in the middle of sentences. This takes the words of the edited text and lays them out as the earlier text
 * was: unchanged words keep the spacing and line breaks they had, new words take spaces in place of Gmail's wrapping.
 * A paragraph break or list line the officer added is kept. Pure: no I/O.
 */

type Tok = { w: string; s: string };
const tokens = (t: string): Tok[] => [...t.matchAll(/(\S+)(\s*)/g)].map((m) => ({ w: m[1]!, s: m[2]! }));
const para = (ws: string) => /\n[ \t]*\n/.test(ws);
const listStart = (w: string | undefined) => !!w && /^([-•*]|\d{1,2}[.)]|\([a-z0-9]{1,3}\))$/i.test(w);

/** Whitespace from an edit, with Gmail's soft line wrapping made into spaces (paragraphs and list lines kept). */
function soft(ws: string, next: string | undefined): string {
  if (para(ws)) return "\n\n";
  if (ws.includes("\n")) return listStart(next) ? "\n" : " ";
  return ws;
}

export function keepLayout(before: string, edited: string): string {
  const A = tokens(before.trim());
  const B = tokens(edited.trim());
  if (!A.length || !B.length) return edited.trim();
  const n = A.length;
  const m = B.length;
  // Too long to align word by word: just undo the wrapping.
  if (n * m > 6_000_000) return B.map((b, i) => b.w + (i < m - 1 ? soft(b.s, B[i + 1]?.w) : "")).join("");
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i]![j] = A[i]!.w === B[j]!.w ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out: { w: string; ai: number | null; bs: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i]!.w === B[j]!.w) {
      out.push({ w: B[j]!.w, ai: i, bs: B[j]!.s });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i++;
    else {
      out.push({ w: B[j]!.w, ai: null, bs: B[j]!.s });
      j++;
    }
  }
  for (; j < m; j++) out.push({ w: B[j]!.w, ai: null, bs: B[j]!.s });
  return out
    .map((t, k) => {
      const next = out[k + 1];
      if (!next) return t.w;
      // Two words that stood together before keep the spacing they had, unless the edit split or joined paragraphs.
      if (t.ai !== null && next.ai === t.ai + 1) {
        const old = A[t.ai]!.s;
        if (para(t.bs) && !para(old)) return `${t.w}\n\n`;
        if (para(old) && !t.bs.includes("\n")) return `${t.w}${t.bs}`;
        return t.w + old;
      }
      return t.w + soft(t.bs, next.w);
    })
    .join("");
}
