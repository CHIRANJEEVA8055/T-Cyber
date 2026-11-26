import { Fragment, type ReactNode } from "react";

/**
 * The assistant's written answers, which the local model writes in Markdown: paragraphs, ### headings, numbered and
 * bulleted lists (one level of nesting), tables, **bold**, *italic*, `code`, and citation markers ([S2], [D1]) shown as
 * chips. Everything becomes React elements; no HTML from the answer is ever inserted into the page.
 */

type Cite = (ref: string) => ReactNode;

function inline(text: string, cite: Cite, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|`([^`]+)`|\[([SDMFCK]\d+)\]/g;
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    const k = `${key}-${i++}`;
    if (m[1] ?? m[2]) out.push(<strong key={k} style={{ fontWeight: 600 }}>{inline(m[1] ?? m[2]!, cite, k)}</strong>);
    else if (m[3]) out.push(<em key={k}>{m[3]}</em>);
    else if (m[4]) out.push(<code key={k} className="md-code">{m[4]}</code>);
    else if (m[5]) out.push(<Fragment key={k}>{cite(m[5])}</Fragment>);
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

type Block =
  | { t: "h"; level: number; text: string }
  | { t: "p"; text: string }
  | { t: "list"; ordered: boolean; start: number; items: { text: string; sub: { ordered: boolean; items: string[] } | null }[] }
  | { t: "table"; head: string[]; rows: string[][] }
  | { t: "code"; text: string }
  | { t: "hr" };

const LIST = /^(\s*)(?:([-*•+])|(\d+)[.)])\s+(.*)$/;
const cells = (line: string) => line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r/g, "").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ t: "p", text: para.join(" ").trim() });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) {
      flush();
      continue;
    }
    if (/^```/.test(line.trim())) {
      flush();
      const body: string[] = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]!.trim()); i++) body.push(lines[i]!);
      blocks.push({ t: "code", text: body.join("\n") });
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line.trim());
    if (h) {
      flush();
      blocks.push({ t: "h", level: h[1]!.length, text: h[2]!.replace(/\s*#+\s*$/, "") });
      continue;
    }
    if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) {
      flush();
      blocks.push({ t: "hr" });
      continue;
    }
    // A table: a row of cells, then a separator row of dashes.
    if (line.includes("|") && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(lines[i + 1]!)) {
      flush();
      const head = cells(line);
      const rows: string[][] = [];
      for (i += 2; i < lines.length && lines[i]!.includes("|") && lines[i]!.trim(); i++) rows.push(cells(lines[i]!));
      i--;
      blocks.push({ t: "table", head, rows });
      continue;
    }
    const li = LIST.exec(line);
    if (li) {
      flush();
      const ordered = !li[2];
      const baseIndent = li[1]!.length;
      const list: Extract<Block, { t: "list" }> = { t: "list", ordered, start: ordered ? Number(li[3]) : 1, items: [] };
      for (; i < lines.length; i++) {
        const l = lines[i]!;
        if (!l.trim()) {
          // A blank line inside a list continues it when the next line is another item of it.
          const nm = LIST.exec(lines[i + 1] ?? "");
          if (nm && (nm[1]!.length > baseIndent || !nm[2] === ordered)) continue;
          break;
        }
        const m = LIST.exec(l);
        if (m && m[1]!.length <= baseIndent) {
          // An item of the other kind (a bullet after numbered steps) starts a new list.
          if (!m[2] !== ordered) break;
          list.items.push({ text: m[4]!, sub: null });
        } else if (m) {
          const last = list.items.at(-1);
          if (!last) break;
          if (!last.sub) last.sub = { ordered: !m[2], items: [] };
          last.sub.items.push(m[4]!);
        } else if (/^\s{2,}\S/.test(l) && list.items.length) {
          list.items.at(-1)!.text += ` ${l.trim()}`;
        } else break;
      }
      i--;
      blocks.push(list);
      continue;
    }
    para.push(line.trim());
  }
  flush();
  return blocks;
}

export function Markdown({ text, cite }: { text: string; cite: Cite }) {
  const blocks = parseMarkdown(text);
  return (
    <div className="md">
      {blocks.map((b, i) => {
        const k = `b${i}`;
        switch (b.t) {
          case "h":
            return b.level <= 2 ? <h3 key={k}>{inline(b.text, cite, k)}</h3> : <h4 key={k}>{inline(b.text, cite, k)}</h4>;
          case "p":
            return <p key={k}>{inline(b.text, cite, k)}</p>;
          case "hr":
            return <hr key={k} />;
          case "code":
            return (
              <pre key={k} className="md-pre">
                <code>{b.text}</code>
              </pre>
            );
          case "table":
            return (
              <div key={k} className="md-table" role="region" aria-label="Table" tabIndex={0}>
                <table>
                  <thead>
                    <tr>
                      {b.head.map((h, j) => (
                        <th key={j} scope="col">
                          {inline(h, cite, `${k}h${j}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, ri) => (
                      <tr key={ri}>
                        {b.head.map((_, ci) => (
                          <td key={ci}>{inline(r[ci] ?? "", cite, `${k}r${ri}c${ci}`)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case "list": {
            const items = b.items.map((it, j) => (
              <li key={j}>
                {inline(it.text, cite, `${k}i${j}`)}
                {it.sub
                  ? (() => {
                      const Sub = it.sub.ordered ? "ol" : "ul";
                      return (
                        <Sub>
                          {it.sub.items.map((s, si) => (
                            <li key={si}>{inline(s, cite, `${k}i${j}s${si}`)}</li>
                          ))}
                        </Sub>
                      );
                    })()
                  : null}
              </li>
            ));
            return b.ordered ? (
              <ol key={k} start={b.start}>
                {items}
              </ol>
            ) : (
              <ul key={k}>{items}</ul>
            );
          }
        }
      })}
    </div>
  );
}
