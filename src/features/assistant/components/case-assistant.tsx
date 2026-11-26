"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { CircleCheck, CircleDashed, CircleHelp, ListOrdered } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InlineAlert } from "@/components/ui/feedback";
import { DateTime } from "@/components/app/datetime";
import { useServerAction } from "@/features/shared/use-action";
import { askCaseAssistantAction } from "@/features/assistant/actions";
import type { AnswerItem, CaseAnswer } from "@/contracts/assistant";
import { AnswerSection, PassageCard, QuestionComposer } from "./shared";

const EXAMPLES = ["What changed recently?", "What is still missing?", "What is supported by evidence?", "What should I review next?", "How much money is secured?"];

function Items({ items, prefix, ordered }: { items: AnswerItem[]; prefix: string; ordered?: boolean }) {
  const List = ordered ? "ol" : "ul";
  return (
    <List className={ordered ? "ml-5 flex list-decimal flex-col gap-1.5 marker:text-ink-3" : "ml-5 flex list-disc flex-col gap-1.5 marker:text-ink-3"}>
      {items.map((item, i) => (
        <li key={i} className="break-words pl-1 text-body text-ink">
          {item.text}
          {item.refs.map((r) => (
            <sup key={r}>
              <a href={`#${prefix}-${r}`} className="ml-0.5 px-0.5 text-meta font-medium text-action hover:underline" aria-label={`Reference ${r}`}>
                {r}
              </a>
            </sup>
          ))}
        </li>
      ))}
    </List>
  );
}

function CaseAnswerCard({ a, id }: { a: CaseAnswer; id: string }) {
  const icon = (node: ReactNode) => <span className="[&_svg]:size-4">{node}</span>;
  return (
    <article aria-labelledby={`${id}-q`} className="panel overflow-hidden">
      <header className="border-b border-line bg-surface-muted px-5 py-3">
        <p className="text-meta text-ink-3">
          You asked, <DateTime iso={a.asOf} />
        </p>
        <h2 id={`${id}-q`} className="break-words text-section font-semibold tracking-tight text-ink">
          “{a.question}”
        </h2>
      </header>
      <div className="flex flex-col gap-5 px-5 py-4">
        <p className="max-w-[75ch] break-words text-body text-ink">{a.summary}</p>
        {a.steps.length ? (
          <AnswerSection title="In this order" icon={icon(<ListOrdered aria-hidden="true" className="text-ink-3" />)}>
            <Items items={a.steps} prefix={id} ordered />
          </AnswerSection>
        ) : null}
        {a.established.length ? (
          <AnswerSection title="Established by the records" icon={icon(<CircleCheck aria-hidden="true" className="text-success" />)}>
            <Items items={a.established} prefix={id} />
          </AnswerSection>
        ) : null}
        {a.hypotheses.length ? (
          <AnswerSection title="Possible, not established" icon={icon(<CircleDashed aria-hidden="true" className="text-warning" />)}>
            <Items items={a.hypotheses} prefix={id} />
          </AnswerSection>
        ) : null}
        {a.unknowns.length ? (
          <AnswerSection title="Not yet known" icon={icon(<CircleHelp aria-hidden="true" className="text-ink-3" />)}>
            <Items items={a.unknowns} prefix={id} />
          </AnswerSection>
        ) : null}
        {a.guidance ? (
          <AnswerSection title="Applicable guidance from the library">
            <div className="flex flex-col gap-3">
              {a.guidance.kind === "CONFLICT" ? <InlineAlert tone="warning">{a.guidance.summary}</InlineAlert> : null}
              {a.guidance.passages.map((p) => (
                <PassageCard key={p.sectionId} p={p} />
              ))}
            </div>
          </AnswerSection>
        ) : null}
        {a.suggestions.length ? (
          <AnswerSection title="Open a page">
            <div className="flex flex-wrap gap-2">
              {a.suggestions.map((s) => (
                <Button key={s.href + s.label} asChild variant="secondary" size="sm">
                  <Link href={s.href}>{s.label}</Link>
                </Button>
              ))}
            </div>
            <p className="mt-2 text-label text-ink-3">These only open pages. The assistant never sends, approves or changes anything.</p>
          </AnswerSection>
        ) : null}
        {a.references.length ? (
          <AnswerSection title="References">
            <ol className="flex flex-col gap-1">
              {a.references.map((r) => (
                <li key={r.ref} id={`${id}-${r.ref}`} className="flex scroll-mt-28 gap-2 rounded-[4px] text-label target:bg-action-tint">
                  <span className="w-7 shrink-0 font-medium tabular-nums text-ink-3">{r.ref}</span>
                  <Link href={r.href} className="min-w-0 break-words text-action hover:underline">
                    {r.label}
                  </Link>
                </li>
              ))}
            </ol>
          </AnswerSection>
        ) : null}
        <p className="border-t border-line pt-3 text-meta text-ink-3">
          Answered from this case&apos;s records as of <DateTime iso={a.asOf} />. {a.provider.disclosure}
        </p>
      </div>
    </article>
  );
}

export function CaseAssistant({ caseId }: { caseId: string }) {
  const [answers, setAnswers] = useState<CaseAnswer[]>([]);
  const ask = useServerAction(askCaseAssistantAction);
  return (
    <div className="flex flex-col gap-6">
      <QuestionComposer
        label="Your question about this case"
        hint="Answers use this case's records and the approved guidance library only. Each question is recorded in the activity log."
        examples={EXAMPLES}
        pending={ask.pending}
        error={ask.fieldErrors.question}
        onAsk={async (q) => {
          const r = await ask.run([caseId, q], { onSuccess: (a) => setAnswers((prev) => [a, ...prev].slice(0, 20)) });
          return r.ok;
        }}
      />
      <div aria-live="polite" className="flex flex-col gap-6">
        {answers.length ? (
          answers.map((a, i) => <CaseAnswerCard key={`${a.asOf}-${answers.length - i}`} a={a} id={`answer-${answers.length - i}`} />)
        ) : (
          <p className="text-body text-ink-2">Answers appear here, newest first. They stay on this page until you leave it and are not stored in the browser.</p>
        )}
      </div>
    </div>
  );
}
