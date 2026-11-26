"use client";

import { useState } from "react";
import { BookOpen, History } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DetailDrawer } from "@/components/ui/drawer";
import { InlineAlert } from "@/components/ui/feedback";
import { StatusBadge } from "@/components/app/status-badge";
import { DateTime } from "@/components/app/datetime";
import { formatDateIST } from "@/domain/time";
import { useServerAction } from "@/features/shared/use-action";
import { askGuidanceAction } from "@/features/assistant/actions";
import type { GuidanceAnswer } from "@/contracts/assistant";
import type { GuidanceLibrary } from "@/server/services/assistant";
import { AnswerSection, PassageCard, QuestionComposer } from "./shared";

const EXAMPLES = [
  "When should I follow up with a bank that has not replied?",
  "Does an acknowledgement from the bank mean the money is held?",
  "Does subscriber registration show who used the number?",
  "Can held money be returned to the victim without an order?",
  "What is the extradition procedure?",
];

function GuidanceAnswerCard({ a, id }: { a: GuidanceAnswer; id: string }) {
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
      <div className="flex flex-col gap-4 px-5 py-4">
        <div className="flex flex-col items-start gap-2">
          <StatusBadge kind="guidance" value={a.kind} />
          {a.kind === "CONFLICT" ? <InlineAlert tone="warning">{a.summary}</InlineAlert> : <p className="max-w-[75ch] text-body text-ink">{a.summary}</p>}
        </div>
        {a.passages.length ? (
          <AnswerSection title={a.kind === "CONFLICT" ? "What each current document says" : "From the library"}>
            <div className="flex flex-col gap-3">
              {a.passages.map((p) => (
                <PassageCard key={p.sectionId} p={p} />
              ))}
            </div>
          </AnswerSection>
        ) : null}
        {a.superseded.length ? (
          <details className="rounded-[var(--radius-panel)] border border-line">
            <summary className="flex cursor-pointer items-center gap-2 px-4 py-2.5 text-label font-medium text-ink-2">
              <History aria-hidden="true" className="size-4" />
              Earlier versions that also mention this ({a.superseded.length}), for history only
            </summary>
            <div className="flex flex-col gap-3 border-t border-line p-4">
              {a.superseded.map((p) => (
                <PassageCard key={p.sectionId} p={p} />
              ))}
            </div>
          </details>
        ) : null}
        <p className="border-t border-line pt-3 text-meta text-ink-3">
          {a.provider.disclosure} This assistant does not read case files.
        </p>
      </div>
    </article>
  );
}

export function GuidanceAssistant() {
  const [answers, setAnswers] = useState<GuidanceAnswer[]>([]);
  const ask = useServerAction(askGuidanceAction);
  return (
    <div className="flex flex-col gap-6">
      <QuestionComposer
        label="Your question about procedure"
        hint="Answers quote the approved library only. Do not include case details: this assistant does not read case files."
        examples={EXAMPLES}
        pending={ask.pending}
        error={ask.fieldErrors.question}
        onAsk={async (q) => {
          const r = await ask.run([q], { onSuccess: (a) => setAnswers((prev) => [a, ...prev].slice(0, 20)) });
          return r.ok;
        }}
      />
      <div aria-live="polite" className="flex flex-col gap-6">
        {answers.length ? (
          answers.map((a, i) => <GuidanceAnswerCard key={`${a.asOf}-${answers.length - i}`} a={a} id={`guidance-${answers.length - i}`} />)
        ) : (
          <p className="text-body text-ink-2">Answers appear here, newest first, with the exact passages they rest on.</p>
        )}
      </div>
    </div>
  );
}

export function LibraryPanel({ library }: { library: GuidanceLibrary }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const doc = library.find((d) => d.id === openId) ?? null;
  return (
    <section aria-labelledby="library-title" className="panel overflow-hidden">
      <div className="border-b border-line px-5 py-3.5">
        <h2 id="library-title" className="text-section font-semibold tracking-tight text-ink">
          Approved Library
        </h2>
        <p className="mt-0.5 text-label text-ink-2">Synthetic documents for this demonstration. Not an official SOP library.</p>
      </div>
      <ul className="divide-y divide-line">
        {library.map((d) => (
          <li key={d.id} className="flex flex-col gap-1.5 px-5 py-3.5">
            <div className="flex items-start justify-between gap-2">
              <p className="min-w-0 text-body font-medium text-ink">{d.title}</p>
              <StatusBadge kind="knowledge" value={d.status} />
            </div>
            <p className="text-label text-ink-3">
              {d.docNumber}, version {d.version}, in force from {formatDateIST(new Date(d.effectiveFrom))}. {d.jurisdiction}.
            </p>
            {d.supersededBy ? <p className="text-label text-ink-2">Superseded by version {d.supersededBy.version}.</p> : null}
            <Button variant="secondary" size="sm" className="self-start" icon={<BookOpen aria-hidden="true" />} aria-haspopup="dialog" onClick={() => setOpenId(d.id)}>
              Read {d.sections.length} section{d.sections.length === 1 ? "" : "s"}
            </Button>
          </li>
        ))}
      </ul>
      <DetailDrawer
        open={!!doc}
        onOpenChange={(o) => !o && setOpenId(null)}
        title={doc?.title ?? "Document"}
        subtitle={doc ? `${doc.issuingBody}. ${doc.docNumber}, version ${doc.version}, in force from ${formatDateIST(new Date(doc.effectiveFrom))}. ${doc.jurisdiction}.` : undefined}
      >
        {doc ? (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge kind="knowledge" value={doc.status} />
              {doc.supersededBy ? <span className="text-label text-ink-2">Superseded by version {doc.supersededBy.version}; shown for history only.</span> : null}
            </div>
            <p className="text-body text-ink-2">{doc.summary}</p>
            {doc.sections.map((s) => (
              <section key={s.id}>
                <h3 className="text-body font-semibold text-ink">
                  {s.sectionRef} {s.heading}
                </h3>
                <p className="mt-1 text-body text-ink">{s.text}</p>
              </section>
            ))}
          </div>
        ) : null}
      </DetailDrawer>
    </section>
  );
}
