import { z } from "zod";
import type { CaseAnswer, GuidanceAnswer } from "@/contracts/assistant";
import type { Db } from "../db";
import type { SessionUser } from "../auth/session";
import { recordAudit } from "../audit";
import { now } from "../clock";
import { AppError } from "../errors";
import { buildCaseContext } from "../ai/context";
import { loadLibrary } from "../ai/library";
import { getAssistantProvider } from "../ai/provider";
import { answerOpenQuestion, answerWithLocalModel, type ChatTurn, type Generate } from "../ai/grounded";
import { localModelStatus } from "../ai/local-model";
import { canWorkCases } from "@/domain/permissions";
import type { GuidanceResult } from "@/domain/guidance";
import { needsApprovedSource, readSmallTalk, smallTalkReply, type SmallTalk, type SmallTalkContext } from "@/domain/conversation";

const questionSchema = z.string().trim().min(3, "Type a question of at least 3 characters.").max(500, "Keep the question under 500 characters.");
/** The procedure assistant also takes "hi" or "ok". */
const messageSchema = z.string().trim().min(1, "Type a message first.").max(500, "Keep the question under 500 characters.");

function parseQuestion(question: string, schema = questionSchema): string {
  const parsed = schema.safeParse(question);
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? "Type a question.";
    throw new AppError(message, "VALIDATION", { question: message });
  }
  return parsed.data;
}

/** Case AI: answers from one authorised case's records. Every question is recorded under access to records. */
export async function askCaseAssistant(db: Db, user: SessionUser, caseId: string, question: string, opts: { generate?: Generate } = {}): Promise<CaseAnswer> {
  const q = parseQuestion(question);
  const context = await buildCaseContext(db, user, caseId);
  const provider = await getAssistantProvider(db);
  const body = await provider.answerCaseQuestion(q, context);
  let answer: CaseAnswer = { ...body, provider: provider.info, question: q, asOf: now().toISOString() };
  // Rules first. Only a question the rules cannot place goes to the local model, grounded in the case's facts.
  if (body.intent === "HELP") {
    const m = await answerWithLocalModel(q, context, opts.generate);
    answer = m.ok
      ? { ...m.body, question: q, asOf: now().toISOString() }
      : { ...answer, summary: `${body.summary} The rules could not place this question, and the local model could not be used: ${m.reason}` };
  }
  const by = answer.intent === "MODEL" ? "the local model" : "the rules";
  await db.$transaction((tx) => recordAudit(tx, { caseId, actorId: user.id, action: "assistant.case_question", objectType: "Case", objectId: caseId, summary: `Asked the case assistant (answered by ${by}): “${q.slice(0, 200)}”` }));
  return answer;
}

/** General guidance: answers from the approved-document library only. It is never given case records. */
export type GuidanceScope = "ALL" | "SOP" | "LAW" | "PROVIDER";

/** Which approved documents a scope covers: SOPs and circulars, the evidence law, or provider policies. */
export function inScope(doc: { title: string; docNumber: string; issuingBody: string; category?: string }, scope: GuidanceScope): boolean {
  if (scope === "ALL") return true;
  if (doc.category) {
    if (scope === "LAW") return doc.category === "LAW";
    if (scope === "PROVIDER") return doc.category === "PROVIDER";
    return doc.category === "SOP" || doc.category === "CIRCULAR" || doc.category === "OTHER";
  }
  const t = `${doc.title} ${doc.docNumber} ${doc.issuingBody}`;
  const law = /\b(BSA|Adhiniyam|Sanhita|Act)\b/i.test(t);
  const provider = /provider|platform polic/i.test(t);
  if (scope === "LAW") return law;
  if (scope === "PROVIDER") return provider;
  return !law && !provider;
}

/** A fixed reply from the rules: nothing is looked up and no model is used. */
const CHAT_PROVIDER = { id: "RULES_CHAT", label: "Rules", disclosure: "A fixed reply from the assistant's rules. No document, case record or model was used." };

async function smallTalkContext(db: Db, user: SessionUser, intent: SmallTalk): Promise<SmallTalkContext> {
  const sources = await db.knowledgeDocument.count({ where: { status: "CURRENT" } });
  // Only the replies that describe the assistant say whether the model is running.
  const modelReady = intent === "HELP" || intent === "IDENTITY" ? await localModelStatus().then((s) => s.reachable && s.hasModel) : true;
  return { at: now(), officer: user.displayName, station: user.stationName, sources, canUseCases: canWorkCases(user), modelReady };
}

/**
 * The procedure assistant's answer to a message. Small talk (a greeting, thanks, today's date) is answered by fixed
 * rules. A question goes to the approved library's rules first; one they cannot answer goes to the local model, which
 * answers from the nearest library passages (citing them) or, for general questions only, from its general
 * knowledge, labelled as not from the approved sources. Law and procedure never get a general-knowledge answer.
 */
export async function askGuidance(
  db: Db,
  user: SessionUser,
  question: string,
  opts: { generate?: Generate; scope?: GuidanceScope; history?: ChatTurn[]; useModel?: boolean } = {},
): Promise<GuidanceAnswer> {
  const original = parseQuestion(question, messageSchema);
  const record = (by: string, q: string) =>
    db.$transaction((tx) => recordAudit(tx, { caseId: null, actorId: user.id, action: "assistant.guidance_question", objectType: "KnowledgeLibrary", objectId: null, summary: `Asked the procedure assistant (answered by ${by}): “${q.slice(0, 200)}”` }));

  const talk = readSmallTalk(original);
  if (talk.intent) {
    const summary = smallTalkReply(talk.intent, await smallTalkContext(db, user, talk.intent));
    await record("the rules", original);
    return { kind: "ANSWER", mode: "CHAT", summary, passages: [], superseded: [], provider: CHAT_PROVIDER, question: original, asOf: now().toISOString() };
  }
  const q = talk.question.length >= 3 ? talk.question : original;

  const library = (await loadLibrary(db)).filter((d) => inScope(d, opts.scope ?? "ALL"));
  const provider = await getAssistantProvider(db);
  let result: GuidanceResult & Pick<GuidanceAnswer, "mode" | "caution"> = await provider.answerGuidanceQuestion(q, library);
  let info =
    provider.info.id === "DEMO_LOCAL"
      ? { ...provider.info, disclosure: "Answered by fixed rules from the sections of the approved library shown. A question no section matches goes to the local model on this server, when it is running; no external service is used." }
      : provider.info;
  // The rules find the passages; the local model, when it runs, writes the answer from them. Without the model the
  // rules' own answer stands: the matching sections, quoted.
  if (opts.useModel !== false) {
    const rules = result;
    const m = await answerOpenQuestion({ question: q, library, history: opts.history ?? [], at: now(), station: user.stationName, seed: rules.kind === "INSUFFICIENT" ? [] : rules.passages, conflict: rules.kind === "CONFLICT" }, opts.generate);
    if (m.ok) {
      result = { ...m.result, superseded: m.result.superseded.length ? m.result.superseded : rules.superseded };
      info = m.provider;
    } else if (!m.skipped && rules.kind === "INSUFFICIENT") {
      result = {
        ...rules,
        summary: needsApprovedSource(q)
          ? `${rules.summary} The local model could not be used either: ${m.reason}`
          : `The approved library does not cover this. General questions are answered by the local model on this server, which could not be used: ${m.reason}`,
      };
    }
  }
  await record(info.id === "LOCAL_MODEL" ? (result.mode === "GENERAL" ? "the local model, from general knowledge" : "the local model") : "the rules", original);
  return { ...result, provider: info, question: original, asOf: now().toISOString() };
}

export async function getGuidanceLibrary(db: Db, _user: SessionUser) {
  const docs = await loadLibrary(db);
  return docs.map((d) => ({ ...d, supersededBy: d.supersededById ? (docs.find((x) => x.id === d.supersededById) ?? null) : null }));
}

export type GuidanceLibrary = Awaited<ReturnType<typeof getGuidanceLibrary>>;
