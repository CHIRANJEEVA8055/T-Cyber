"use client";

import { useId, useState, type ReactNode } from "react";
import { MessageSquareText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FormField, Textarea } from "@/components/ui/field";
import { StatusBadge } from "@/components/app/status-badge";
import { formatDateIST } from "@/domain/time";
import type { Passage } from "@/domain/guidance";
import { cn } from "@/lib/cn";

/** A quoted library passage with everything needed to judge it: issuer, number, version, date and status. */
export function PassageCard({ p }: { p: Passage }) {
  return (
    <figure className="rounded-[var(--radius-panel)] border border-line bg-surface p-4">
      <figcaption className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-body font-medium text-ink">
            {p.documentTitle}, {p.sectionRef}: {p.heading}
          </p>
          <p className="text-label text-ink-3">
            {p.issuingBody}. {p.docNumber}, version {p.version}, in force from {formatDateIST(new Date(p.effectiveFrom))}. {p.jurisdiction}.
          </p>
        </div>
        <StatusBadge kind="knowledge" value={p.status} />
      </figcaption>
      <blockquote className="mt-3 border-l-2 border-line-strong pl-3 text-body text-ink">“{p.text}”</blockquote>
      {p.supersededBy ? (
        <p className="mt-2 text-label text-ink-2">
          Superseded by version {p.supersededBy.version}, in force from {formatDateIST(new Date(p.supersededBy.effectiveFrom))}. Shown for history only.
        </p>
      ) : null}
    </figure>
  );
}

export function AnswerSection({ title, icon, children, className }: { title: string; icon?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={className}>
      <h3 className="flex items-center gap-2 text-label font-semibold text-ink-2">
        {icon}
        {title}
      </h3>
      <div className="mt-2">{children}</div>
    </section>
  );
}

/** Question box with example questions. Enter asks; Shift+Enter starts a new line. */
export function QuestionComposer({ label, hint, examples, pending, error, onAsk }: { label: string; hint: string; examples: string[]; pending: boolean; error?: string; onAsk: (question: string) => Promise<boolean> }) {
  const [question, setQuestion] = useState("");
  const examplesId = useId();
  const ask = async (q: string) => {
    if (pending) return;
    if (await onAsk(q)) setQuestion("");
  };
  return (
    <form
      className="panel flex flex-col gap-4 p-5"
      onSubmit={(e) => {
        e.preventDefault();
        void ask(question);
      }}
    >
      <FormField label={label} hint={hint} error={error}>
        <Textarea
          rows={2}
          value={question}
          maxLength={500}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void ask(question);
            }
          }}
        />
      </FormField>
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div className="min-w-0">
          <p id={examplesId} className="text-label text-ink-3">
            Or ask one of these:
          </p>
          <div role="group" aria-labelledby={examplesId} className="mt-1.5 flex flex-wrap gap-2">
            {examples.map((x) => (
              <button
                key={x}
                type="button"
                disabled={pending}
                onClick={() => void ask(x)}
                className={cn("min-h-9 rounded-[var(--radius-control)] border border-line-input bg-surface px-3 py-1.5 text-left text-label text-ink-2 shadow-[var(--shadow-control)] hover:border-line-strong hover:text-ink", pending && "cursor-wait opacity-60")}
              >
                {x}
              </button>
            ))}
          </div>
        </div>
        <Button type="submit" variant="primary" loading={pending} icon={<MessageSquareText aria-hidden="true" />} className="shrink-0 self-start md:self-end">
          Ask question
        </Button>
      </div>
    </form>
  );
}
