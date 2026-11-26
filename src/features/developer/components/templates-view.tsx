"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Icon } from "@/components/ui/icon";
import { C } from "@/components/design/tokens";
import { DesignModal } from "@/components/design/modal";
import type { PromptTemplateView } from "@/server/services/prompt-templates";
import { deletePromptAction, movePromptAction, savePromptAction } from "../actions";

type Edit = { id: string | null; title: string; question: string; sourceLabel: string; active: boolean };

/** Developer console › Ready questions: the suggestions officers see on a new procedure-assistant chat. */
export function TemplatesView({ templates }: { templates: PromptTemplateView[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [edit, setEdit] = useState<Edit | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [del, setDel] = useState<PromptTemplateView | null>(null);
  const run = (fn: () => Promise<{ ok: true } | { ok: false; error: string; fieldErrors?: Record<string, string> }>, after?: () => void) =>
    start(async () => {
      setError(null);
      const r = await fn();
      if (!r.ok) {
        setError(r.error);
        setErrors(r.fieldErrors ?? {});
        return;
      }
      setErrors({});
      after?.();
      router.refresh();
    });
  const form = (e: Edit) => (
    <div className="inner" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span className="lbl">Title on the card *</span>
        <input className="input" value={e.title} onChange={(x) => setEdit({ ...e, title: x.target.value })} aria-invalid={!!errors.title} style={{ minHeight: 38 }} />
        {errors.title ? <span role="alert" style={{ fontSize: 13, color: C.orange }}>{errors.title}</span> : null}
      </label>
      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span className="lbl">Question asked *</span>
        <textarea className="input" rows={2} value={e.question} onChange={(x) => setEdit({ ...e, question: x.target.value })} aria-invalid={!!errors.question} style={{ padding: 8 }} />
        {errors.question ? <span role="alert" style={{ fontSize: 13, color: C.orange }}>{errors.question}</span> : null}
      </label>
      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span className="lbl">Source shown under it</span>
        <input className="input" value={e.sourceLabel} onChange={(x) => setEdit({ ...e, sourceLabel: x.target.value })} placeholder="Refund SOP, 17.02.2024" style={{ minHeight: 38 }} />
      </label>
      <label className="row" style={{ gap: 8 }}>
        <input type="checkbox" checked={e.active} onChange={(x) => setEdit({ ...e, active: x.target.checked })} /> Shown to officers
      </label>
      <div className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
        <button className="btn" type="button" onClick={() => (setEdit(null), setErrors({}))}>
          Cancel
        </button>
        <button className="btn primary" type="button" aria-busy={pending} onClick={() => run(() => savePromptAction(e.id, { title: e.title, question: e.question, sourceLabel: e.sourceLabel, active: e.active }), () => setEdit(null))}>
          {e.id ? "Save question" : "Add question"}
        </button>
      </div>
    </div>
  );
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {error ? (
        <div role="alert" className="inner" style={{ padding: "12px 14px", display: "flex", gap: 10, color: C.orange }}>
          <Icon name="alertCircle" size={18} /> <span>{error}</span>
        </div>
      ) : null}
      <div className="card" style={{ overflow: "hidden" }}>
        <div className="row" style={{ justifyContent: "space-between", padding: "14px 20px", borderBottom: `1px solid ${C.line}` }}>
          <span style={{ fontWeight: 600 }}>
            {templates.filter((t) => t.active).length} shown · {templates.filter((t) => !t.active).length} hidden
          </span>
          <button className="btn sm primary" type="button" onClick={() => setEdit({ id: null, title: "", question: "", sourceLabel: "", active: true })}>
            <Icon name="plus" size={14} /> Add a ready question
          </button>
        </div>
        {edit && !edit.id ? <div style={{ padding: 16 }}>{form(edit)}</div> : null}
        {templates.length ? (
          <ol style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {templates.map((t, i) => (
              <li key={t.id} style={{ padding: "14px 20px", borderTop: `1px solid ${C.lineSoft}` }}>
                {edit?.id === t.id ? (
                  form(edit)
                ) : (
                  <div className="row" style={{ justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
                    <div style={{ minWidth: 0, flex: "1 1 360px" }}>
                      <div style={{ fontWeight: 500 }}>
                        {t.title} {t.active ? null : <span className="pill neutral">Hidden</span>}
                      </div>
                      <div className="sec" style={{ fontSize: 14, marginTop: 2 }}>{t.question}</div>
                      {t.sourceLabel ? <div className="mut" style={{ fontSize: 13, marginTop: 2 }}>{t.sourceLabel}</div> : null}
                    </div>
                    <div className="row" style={{ gap: 6 }}>
                      <button className="btn sm" type="button" disabled={i === 0 || pending} aria-label={`Move “${t.title}” up`} onClick={() => run(() => movePromptAction(t.id, "up"))}>
                        <Icon name="arrowUp" size={14} />
                      </button>
                      <button className="btn sm" type="button" disabled={i === templates.length - 1 || pending} aria-label={`Move “${t.title}” down`} onClick={() => run(() => movePromptAction(t.id, "down"))}>
                        <Icon name="arrowDown" size={14} />
                      </button>
                      <button className="btn sm" type="button" onClick={() => setEdit({ id: t.id, title: t.title, question: t.question, sourceLabel: t.sourceLabel, active: t.active })}>
                        Edit
                      </button>
                      <button className="btn sm" type="button" onClick={() => setDel(t)}>
                        Delete
                      </button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ol>
        ) : (
          <div style={{ padding: "28px 20px" }}>
            <strong>No ready questions yet</strong>
            <p className="mut" style={{ margin: "6px 0 0" }}>Add the questions officers ask most; they appear as cards on a new procedure-assistant chat.</p>
          </div>
        )}
      </div>
      <DesignModal open={!!del} onClose={() => setDel(null)} scope="scr-dashboard" maxWidth={520} title={`Delete the ready question “${del?.title ?? ""}”?`}>
        <div className="mhead">
          <h2 className="h" style={{ fontSize: 20, margin: 0 }}>Delete the ready question “{del?.title}”?</h2>
        </div>
        <div className="mbody">
          <p className="sec" style={{ margin: 0 }}>Officers stop seeing it. To keep it for later, hide it instead. This cannot be undone.</p>
        </div>
        <div className="mfoot">
          <button className="btn" type="button" autoFocus onClick={() => setDel(null)}>
            Cancel
          </button>
          <button className="btn" type="button" style={{ background: "#dc2626", color: "#fff", borderColor: "transparent" }} onClick={() => del && run(() => deletePromptAction(del.id), () => setDel(null))}>
            Delete question
          </button>
        </div>
      </DesignModal>
    </div>
  );
}
