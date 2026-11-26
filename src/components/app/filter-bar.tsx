"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useId, useRef, useState, useTransition } from "react";
import { Search, SlidersHorizontal, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/feedback";

export interface FilterSelect {
  param: string;
  label: string;
  options: { value: string; label: string }[];
  /** Value meaning "no filter"; not written to the URL. */
  allValue?: string;
}

/**
 * Filters live in the URL so reload, back/forward and shared links keep them.
 * Search updates after a short pause; selects update immediately.
 */
export function FilterBar({
  searchLabel = "Search",
  searchHint,
  selects = [],
  className,
  resetParams = [],
}: {
  searchLabel?: string;
  searchHint?: string;
  selects?: FilterSelect[];
  className?: string;
  /** Parameters that stop making sense when a filter changes (e.g. a paging cursor); removed on every change. */
  resetParams?: string[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const urlQ = params.get("q") ?? "";
  const [q, setQ] = useState(urlQ);
  const [prevUrlQ, setPrevUrlQ] = useState(urlQ);
  // Keep the box in step with the URL (back/forward, Clear all filters) without an effect.
  if (urlQ !== prevUrlQ) {
    setPrevUrlQ(urlQ);
    setQ(urlQ);
  }
  const searchId = useId();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);


  const push = (mutate: (p: URLSearchParams) => void) => {
    const next = new URLSearchParams(params.toString());
    mutate(next);
    for (const r of resetParams) next.delete(r);
    const qs = next.toString();
    startTransition(() => router.replace(`${pathname}${qs ? `?${qs}` : ""}`, { scroll: false }));
  };

  const active = !!params.get("q") || selects.some((s) => params.get(s.param) && params.get(s.param) !== (s.allValue ?? ""));
  const activeSelects = selects.filter((s) => params.get(s.param) && params.get(s.param) !== (s.allValue ?? "")).length;
  const [showFilters, setShowFilters] = useState(false);
  const panelId = useId();

  return (
    <div className={cn("flex flex-col gap-3 md:flex-row md:flex-wrap md:items-end", className)} role="search">
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 md:min-w-[18rem] md:max-w-md">
        <label htmlFor={searchId} className="sr-only text-label font-medium text-ink md:not-sr-only">
          {searchLabel}
        </label>
        <div className="relative">
          <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-3" />
          <input
            id={searchId}
            type="search"
            value={q}
            aria-label={searchLabel}
            placeholder={searchHint}
            onChange={(e) => {
              const value = e.target.value;
              setQ(value);
              if (timer.current) clearTimeout(timer.current);
              timer.current = setTimeout(() => push((p) => (value.trim() ? p.set("q", value.trim()) : p.delete("q"))), 300);
            }}
            className="h-10 w-full rounded-[var(--radius-control)] border border-line-input bg-surface pl-9 pr-9 text-body text-ink shadow-[inset_0_1px_2px_rgba(0,0,0,0.03)] placeholder:text-ink-3 focus-visible:border-focus focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[rgb(40_102_197/0.25)] pointer-coarse:h-11 [&::-webkit-search-cancel-button]:hidden"
          />
          {pending ? <Spinner className="absolute right-3 top-1/2 size-4 -translate-y-1/2 text-ink-3" /> : null}
        </div>
      </div>
      {selects.length > 0 ? (
        <button
          type="button"
          aria-expanded={showFilters}
          aria-controls={panelId}
          onClick={() => setShowFilters((v) => !v)}
          className="inline-flex h-11 items-center gap-2 self-start rounded-[var(--radius-control)] border border-line-input bg-surface px-3.5 text-body font-medium text-ink md:hidden"
        >
          <SlidersHorizontal aria-hidden="true" className="size-4 text-ink-3" />
          Filters{activeSelects ? ` (${activeSelects} active)` : ""}
        </button>
      ) : null}
      <div id={panelId} className={cn("flex-col gap-3 md:contents", showFilters ? "flex" : "hidden")}>
        {selects.map((s) => (
          <FilterSelectControl key={s.param} select={s} value={params.get(s.param) ?? s.allValue ?? ""} onChange={(v) => push((p) => (v === (s.allValue ?? "") ? p.delete(s.param) : p.set(s.param, v)))} />
        ))}
      </div>
      {active ? (
        <Button variant="ghost" icon={<X aria-hidden="true" />} onClick={() => push((p) => [...p.keys()].forEach((k) => p.delete(k)))} className="md:mb-0">
          Clear all filters
        </Button>
      ) : null}
    </div>
  );
}

function FilterSelectControl({ select, value, onChange }: { select: FilterSelect; value: string; onChange: (v: string) => void }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-label font-medium text-ink">
        {select.label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-10 min-w-40 appearance-none rounded-[var(--radius-control)] border border-line-input bg-surface bg-[url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2216%22 height=%2216%22 fill=%22none%22 stroke=%22%236b6b74%22 stroke-width=%222%22 viewBox=%220 0 24 24%22><path d=%22m6 9 6 6 6-6%22/></svg>')] bg-[length:16px] bg-[right_10px_center] bg-no-repeat pl-3 pr-9 text-body text-ink focus-visible:border-focus focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[rgb(40_102_197/0.25)] pointer-coarse:h-11"
      >
        {select.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}
