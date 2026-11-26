import Link from "next/link";
import type { ReactNode } from "react";
import type { ReportSource } from "@/server/services/reports";

/** Turns "[S2]" markers into links to the numbered source list; everything else stays plain text. */
function withMarkers(text: string, refs: Set<string>): ReactNode[] {
  return text.split(/(\[S\d+\])/g).map((part, i) => {
    const ref = /^\[(S\d+)\]$/.exec(part)?.[1];
    if (ref && refs.has(ref))
      return (
        <sup key={i}>
          <a href={`#src-${ref}`} className="ml-0.5 rounded-[3px] px-0.5 text-meta font-medium text-action hover:underline" aria-label={`Source ${ref}`}>
            {ref}
          </a>
        </sup>
      );
    return part;
  });
}

/**
 * Renders a report's plain text: "## " lines are headings, "- " lines are list items, anything else is a
 * paragraph. The text is never interpreted as HTML.
 */
export function ReportBody({ body, sources }: { body: string; sources: ReportSource[] }) {
  const refs = new Set(sources.map((s) => s.ref));
  const blocks: ReactNode[] = [];
  let items: string[] = [];
  const flush = () => {
    if (!items.length) return;
    const list = items;
    blocks.push(
      <ul key={`list-${blocks.length}`} className="ml-5 flex list-disc flex-col gap-1.5 text-body text-ink marker:text-ink-3">
        {list.map((item, i) => (
          <li key={i} className="break-words pl-1">
            {withMarkers(item, refs)}
          </li>
        ))}
      </ul>,
    );
    items = [];
  };
  body.split("\n").forEach((line, i) => {
    if (line.startsWith("- ")) {
      items.push(line.slice(2));
      return;
    }
    flush();
    if (!line.trim()) return;
    if (line.startsWith("## "))
      blocks.push(
        <h2 key={i} className="mt-4 text-section font-semibold tracking-tight text-ink first:mt-0">
          {withMarkers(line.slice(3), refs)}
        </h2>,
      );
    else
      blocks.push(
        <p key={i} className="break-words text-body text-ink">
          {withMarkers(line, refs)}
        </p>,
      );
  });
  flush();
  return <div className="flex max-w-[75ch] flex-col gap-3">{blocks}</div>;
}

export function ReportSources({ sources }: { sources: ReportSource[] }) {
  if (!sources.length) return null;
  return (
    <section aria-labelledby="report-sources" className="mt-8 max-w-[75ch] border-t border-line pt-4">
      <h2 id="report-sources" className="text-section font-semibold tracking-tight text-ink">
        Sources
      </h2>
      <ol className="mt-2 flex flex-col gap-1.5">
        {sources.map((s) => (
          <li key={s.ref} id={`src-${s.ref}`} className="flex scroll-mt-28 gap-2 rounded-[4px] text-label target:bg-action-tint">
            <span className="w-8 shrink-0 font-medium tabular-nums text-ink-3">{s.ref}</span>
            <span className="min-w-0 break-words">
              <Link href={s.href} className="text-action hover:underline">
                {s.label}
              </Link>
              <span className="print-only text-meta text-ink-3">{s.href}</span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
