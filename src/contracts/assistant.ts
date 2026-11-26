import type { CaseIntent } from "@/domain/assistant";
import type { GuidanceResult, Passage } from "@/domain/guidance";

/** A numbered reference ("R2") to the record or document an answer item rests on. */
export interface AnswerRef {
  ref: string;
  label: string;
  href: string;
}

export interface AnswerItem {
  text: string;
  refs: string[];
}

/** What an officer attached to a question in the procedure assistant: their own uploaded file, a station mailbox
 *  message, or a whole case they can read. */
export interface ChatAttachment {
  kind: "FILE" | "MAIL" | "CASE";
  id: string;
  label: string;
  sub: string;
}

/** Something written in more than one attachment (the same account, number, ID or reference), with where. */
export interface AnswerConnection {
  kind: string;
  value: string;
  /** SAME: written identically in each; POSSIBLE: one is partly hidden and the shown digits fit; NAME: the same name. */
  strength: "SAME" | "POSSIBLE" | "NAME";
  in: { tag: string; label: string; refs: string[] }[];
  note: string | null;
}

/** A numbered passage quoted from the attached file or mail ("D2", "M1"), or a case's facts ("C3"). */
export interface AnswerExtract {
  ref: string;
  heading: string;
  text: string;
}

/** Work the assistant can set up but never complete: preparing a draft (which still needs approval) or opening one. */
export interface AnswerTask {
  kind: "PREPARE_DRAFT" | "OPEN_DRAFT";
  label: string;
  sub: string;
  taskId?: string;
  href?: string;
}

export interface AssistantProviderInfo {
  id: string;
  label: string;
  /** Shown with every answer so nobody mistakes the demo for a language model or an official SOP service. */
  disclosure: string;
}

/**
 * A case answer keeps what the records establish apart from what is only possible and from what is not known.
 * Suggestions only open pages (a draft, a task, a review); the assistant never acts.
 */
export interface CaseAnswer {
  provider: AssistantProviderInfo;
  question: string;
  /** MODEL: the rules could not answer and the local model wrote it from the numbered case facts. */
  intent: CaseIntent | "RECORD" | "MODEL";
  summary: string;
  steps: AnswerItem[];
  established: AnswerItem[];
  hypotheses: AnswerItem[];
  unknowns: AnswerItem[];
  suggestions: { label: string; href: string }[];
  guidance: { kind: GuidanceResult["kind"]; summary: string; passages: Passage[] } | null;
  references: AnswerRef[];
  asOf: string;
  attachment?: ChatAttachment | null;
  attachments?: ChatAttachment[];
  tasks?: AnswerTask[];
}

export interface GuidanceAnswer extends GuidanceResult {
  provider: AssistantProviderInfo;
  question: string;
  asOf: string;
  attachment?: ChatAttachment | null;
  /** Several files, mails or cases asked about together. */
  attachments?: ChatAttachment[];
  /** What the attachments have in common, found by exact matching (several attachments only). */
  connections?: AnswerConnection[];
  /** Passages from the attached file or mail that bear on the question, quoted, never paraphrased by the rules. */
  extracts?: AnswerExtract[];
  /** A sentence about the attachment itself (what it is, which case or request it seems to belong to). */
  about?: string;
  tasks?: AnswerTask[];
  /**
   * CHAT: a fixed conversational reply from the rules (a greeting, today's date, what the assistant can do); nothing
   * was looked up. GENERAL: the local model answered from its general knowledge; nothing in it is from the approved
   * sources. Absent: an answer from the approved sources (or an attachment).
   */
  mode?: "CHAT" | "GENERAL";
  /** A caution shown with the answer, e.g. when a general answer names a legal provision. */
  caution?: string;
}
