import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/** Page title block: title, one-line description, and the page's actions (one primary). */
export function PageHeader({ title, description, actions, meta, className }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; meta?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-4 md:flex-row md:items-end md:justify-between", className)}>
      <div className="min-w-0">
        <h1 className="text-title font-semibold tracking-tight text-ink">{title}</h1>
        {description ? <p className="mt-1 max-w-[70ch] text-body text-ink-2">{description}</p> : null}
        {meta ? <div className="mt-2">{meta}</div> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** Bounded content area. Wide views (graph, large tables) opt out with `wide`. */
export function PageBody({ children, wide, className }: { children: ReactNode; wide?: boolean; className?: string }) {
  return <div className={cn("mx-auto w-full px-4 py-6 sm:px-6 lg:px-10 lg:py-8", wide ? "max-w-none" : "max-w-[1600px]", className)}>{children}</div>;
}

/** A titled panel (L1 surface with hairline border). */
export function Panel({ title, description, actions, children, className, bodyClassName, id, as: As = "section" }: { title?: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string; id?: string; as?: "section" | "div" }) {
  return (
    <As id={id} aria-labelledby={title && id ? `${id}-title` : undefined} className={cn("panel min-w-0", className)}>
      {title || actions ? (
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-3.5">
          <div className="min-w-0">
            {title ? (
              <h2 id={id ? `${id}-title` : undefined} className="text-section font-semibold tracking-tight text-ink">
                {title}
              </h2>
            ) : null}
            {description ? <p className="mt-0.5 text-label text-ink-2">{description}</p> : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      <div className={cn("min-w-0", bodyClassName ?? "px-5 py-4")}>{children}</div>
    </As>
  );
}

/** Label/value pairs for record details. */
export function DefinitionList({ items, className, columns = 2 }: { items: { term: ReactNode; value: ReactNode; wide?: boolean }[]; className?: string; columns?: 1 | 2 | 3 }) {
  return (
    <dl className={cn("grid gap-x-6 gap-y-3", columns === 1 ? "grid-cols-1" : columns === 2 ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3", className)}>
      {items.map((item, i) => (
        <div key={i} className={cn("min-w-0", item.wide && "sm:col-span-full")}>
          <dt className="text-label text-ink-3">{item.term}</dt>
          <dd className="mt-0.5 break-words text-body text-ink">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Headline figures in L1 cards with a thin accent stripe (reference layout). Static: each figure is
 * explained by its label and hint, so it never promises a filtered page whose count could differ.
 */
export function StatCards({ items, className }: { items: { label: ReactNode; value: ReactNode; hint?: ReactNode; accent: "blue" | "teal" | "violet" | "cyan" }[]; className?: string }) {
  const accent = { blue: "bg-[#3979ff]", teal: "bg-[#00a383]", violet: "bg-[#7c4dff]", cyan: "bg-[#14a3a0]" };
  return (
    <dl className={cn("grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4", className)}>
      {items.map((item, i) => (
        <div key={i} className="panel relative min-w-0 overflow-hidden py-3 pl-5 pr-3 sm:py-4 sm:pl-6 sm:pr-5">
          <span aria-hidden="true" className={cn("absolute inset-y-3 left-0 w-1 rounded-r-full sm:inset-y-4", accent[item.accent])} />
          <dt className="text-label text-ink-2">{item.label}</dt>
          <dd className="mt-1 text-[1.375rem] font-semibold leading-8 tracking-tight tabular-nums text-ink sm:text-[1.75rem] sm:leading-9">{item.value}</dd>
          {item.hint ? <dd className="text-meta text-ink-3">{item.hint}</dd> : null}
        </div>
      ))}
    </dl>
  );
}
