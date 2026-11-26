import { z } from "zod";
import type { CaseAnswer, ChatAttachment, GuidanceAnswer } from "@/contracts/assistant";
import { formatDateTimeIST } from "@/domain/time";
import type { Db } from "../db";
import type { SessionUser } from "../auth/session";
import { loadCaseForUser } from "../auth/access";
import { recordAudit } from "../audit";
import { now } from "../clock";
import { AppError, notFoundError } from "../errors";
import type { ChatTurn, Generate } from "../ai/grounded";
import { askCaseAssistant, type GuidanceScope } from "./assistant";
import { answerProcedureQuestion, dedupeAttachments } from "./procedure-assistant";
import { KIND_WORD } from "@/domain/connections";
import { buildDocx, type DocBlock } from "../documents/docx-writer";

/**
 * Saved conversations with the procedure assistant (station) and the case assistant (one case). A thread belongs
 * to the officer who started it; a case thread can only be opened while the officer can read that case.
 */

export type ChatKind = "PROCEDURE" | "CASE";
const NEW_TITLE = "New conversation";
const DAY = 24 * 3600 * 1000;

async function loadThread(db: Db, user: SessionUser, threadId: string) {
  const t = await db.chatThread.findUnique({ where: { id: threadId } });
  if (!t || t.userId !== user.id) throw notFoundError("conversation");
  if (t.caseId) await loadCaseForUser(db, user, t.caseId, "read");
  return t;
}

function bucket(d: Date, at: Date): string {
  const days = Math.floor((at.getTime() - d.getTime()) / DAY);
  if (days < 1 && new Date(at).toDateString() === d.toDateString()) return "Today";
  if (days < 2) return "Yesterday";
  if (days < 7) return "Previous 7 days";
  if (days < 30) return "Previous 30 days";
  return "Older";
}

export async function listThreads(db: Db, user: SessionUser, input: { kind: ChatKind; caseId?: string | null; q?: string }) {
  if (input.kind === "CASE") {
    if (!input.caseId) throw new AppError("Open a case to see its conversations.", "VALIDATION");
    await loadCaseForUser(db, user, input.caseId, "read");
  }
  const q = input.q?.trim().slice(0, 100);
  // A search looks in the chat's name and in every question and answer in it.
  const match = q ? { OR: [{ title: { contains: q } }, { messages: { some: { text: { contains: q } } } }] } : {};
  const where = { userId: user.id, kind: input.kind, ...(input.kind === "CASE" ? { caseId: input.caseId } : {}), ...match };
  const [threads, archived] = await Promise.all([
    db.chatThread.findMany({ where: { ...where, archivedAt: null }, orderBy: { updatedAt: "desc" }, take: 100, select: { id: true, title: true, scope: true, updatedAt: true } }),
    db.chatThread.findMany({ where: { ...where, archivedAt: { not: null } }, orderBy: { updatedAt: "desc" }, take: 50, select: { id: true, title: true, updatedAt: true } }),
  ]);
  const at = now();
  const groups: { label: string; threads: { id: string; title: string; scope: string }[] }[] = [];
  for (const t of threads) {
    const label = bucket(t.updatedAt, at);
    let g = groups.find((x) => x.label === label);
    if (!g) groups.push((g = { label, threads: [] }));
    g.threads.push({ id: t.id, title: t.title, scope: t.scope });
  }
  return { groups, archived: archived.map((t) => ({ id: t.id, title: t.title })) };
}

export type ChatMessageView = { id: string; role: "USER" | "ASSISTANT"; text: string; at: string; feedback: string | null; answer: CaseAnswer | GuidanceAnswer | null; attachment: ChatAttachment | null; attachments: ChatAttachment[] };

/** A question's attachments as stored: one (an object, as before) or several (a list). */
function storedAttachments(json: string | null): ChatAttachment[] {
  if (!json) return [];
  const v = JSON.parse(json) as ChatAttachment | ChatAttachment[];
  return Array.isArray(v) ? v : [v];
}

export async function getThread(db: Db, user: SessionUser, threadId: string) {
  const t = await loadThread(db, user, threadId);
  const messages = await db.chatMessage.findMany({ where: { threadId }, orderBy: { createdAt: "asc" } });
  return {
    id: t.id,
    kind: t.kind as ChatKind,
    caseId: t.caseId,
    title: t.title,
    scope: t.scope as GuidanceScope,
    archived: !!t.archivedAt,
    messages: messages.map((m): ChatMessageView => ({ id: m.id, role: m.role as "USER" | "ASSISTANT", text: m.text, at: m.createdAt.toISOString(), feedback: m.feedback, answer: m.answerJson ? (JSON.parse(m.answerJson) as CaseAnswer | GuidanceAnswer) : null, attachment: storedAttachments(m.attachmentJson)[0] ?? null, attachments: storedAttachments(m.attachmentJson) })),
  };
}
export type ChatThreadView = Awaited<ReturnType<typeof getThread>>;

const scopeSchema = z.enum(["ALL", "SOP", "LAW", "PROVIDER"]);

export async function createThread(db: Db, user: SessionUser, input: { kind: ChatKind; caseId?: string | null; scope?: string }) {
  if (input.kind === "CASE") {
    if (!input.caseId) throw new AppError("Open a case first.", "VALIDATION");
    await loadCaseForUser(db, user, input.caseId, "read");
  }
  const scope = scopeSchema.catch("ALL").parse(input.scope ?? "ALL");
  return db.chatThread.create({ data: { kind: input.kind, caseId: input.kind === "CASE" ? input.caseId! : null, userId: user.id, title: NEW_TITLE, scope, createdAt: now(), updatedAt: now() } });
}

/** Asks in a thread: the question and the answer are both kept; the first question names the thread. */
export async function askInThread(db: Db, user: SessionUser, threadId: string, question: string, opts: { scope?: string; generate?: Generate; attachment?: { kind: string; id: string } | null; attachments?: { kind: string; id: string }[] } = {}) {
  const t = await loadThread(db, user, threadId);
  if (t.archivedAt) throw new AppError("This conversation is archived. Restore it to ask more.", "PRECONDITION");
  const scope = scopeSchema.catch(t.scope as "ALL").parse(opts.scope ?? t.scope);
  const history = await recentTurns(db, threadId, 0);
  const attachments = dedupeAttachments([...(opts.attachments ?? []), ...(opts.attachment ? [opts.attachment] : [])]);
  const answer = await answerFor(db, user, t, question, scope, { generate: opts.generate, attachments, history });
  const at = now();
  const used = "attachments" in answer && answer.attachments?.length ? answer.attachments : "attachment" in answer && answer.attachment ? [answer.attachment] : [];
  await db.$transaction([
    db.chatMessage.create({ data: { threadId, role: "USER", text: answer.question, attachmentJson: used.length > 1 ? JSON.stringify(used) : used.length ? JSON.stringify(used[0]) : null, createdAt: at } }),
    db.chatMessage.create({ data: { threadId, role: "ASSISTANT", text: answer.summary, answerJson: JSON.stringify(answer), createdAt: new Date(at.getTime() + 1) } }),
    db.chatThread.update({ where: { id: threadId }, data: { updatedAt: at, scope, ...(t.title === NEW_TITLE ? { title: answer.question.length > 48 ? `${answer.question.slice(0, 47).trimEnd()}…` : answer.question } : {}) } }),
  ]);
  return answer;
}

/** The last few questions and answers of a conversation (skipping the newest `skip` messages), oldest first. */
async function recentTurns(db: Db, threadId: string, skip: number): Promise<ChatTurn[]> {
  const rows = await db.chatMessage.findMany({ where: { threadId }, orderBy: { createdAt: "desc" }, skip, take: 6, select: { role: true, text: true } });
  return rows.reverse().map((m) => ({ role: m.role === "USER" ? "USER" : "ASSISTANT", text: m.text }));
}

async function answerFor(db: Db, user: SessionUser, t: { kind: string; caseId: string | null }, question: string, scope: GuidanceScope, opts: { generate?: Generate; attachments?: { kind: string; id: string }[]; history?: ChatTurn[] }) {
  // A case question with files attached reads the case and the files together (as the procedure assistant does),
  // so it can say what in the files bears on this case; without files, the case assistant answers as before.
  const files = t.kind === "CASE" ? (opts.attachments ?? []).filter((a) => a.kind === "FILE").slice(0, 7) : [];
  if (t.kind === "CASE" && !files.length) return askCaseAssistant(db, user, t.caseId!, question, { generate: opts.generate });
  const list = t.kind === "CASE" ? [{ kind: "CASE", id: t.caseId! }, ...files] : (opts.attachments ?? []);
  if (t.kind === "CASE") scope = "ALL";
  const answer = await answerProcedureQuestion(db, user, { question, scope, attachments: list, generate: opts.generate, history: opts.history });
  if (list.length) {
    // Which attachments were used is recorded; never their contents.
    await db.$transaction(async (tx) => {
      for (const a of list)
        await recordAudit(tx, { caseId: a.kind === "CASE" ? a.id : null, actorId: user.id, action: "assistant.attachment_used", objectType: a.kind === "FILE" ? "ChatUpload" : a.kind === "MAIL" ? "InboxMessage" : "Case", objectId: a.id, summary: `Asked the procedure assistant about ${a.kind === "FILE" ? "an uploaded file" : a.kind === "MAIL" ? "a station mail" : "a case"}${list.length > 1 ? ` (one of ${list.length} attachments compared)` : ""}` });
    });
  }
  return answer;
}

/** Asks the last question again (with the same attachment) and replaces the last answer. */
export async function retryLastAnswer(db: Db, user: SessionUser, threadId: string, opts: { generate?: Generate } = {}) {
  const t = await loadThread(db, user, threadId);
  if (t.archivedAt) throw new AppError("This conversation is archived. Restore it to ask more.", "PRECONDITION");
  const last = await db.chatMessage.findMany({ where: { threadId }, orderBy: { createdAt: "desc" }, take: 2 });
  const [answerMsg, questionMsg] = last;
  if (!answerMsg || !questionMsg || answerMsg.role !== "ASSISTANT" || questionMsg.role !== "USER") throw new AppError("There is no answer to try again.", "PRECONDITION");
  const attachments = storedAttachments(questionMsg.attachmentJson).map((a) => ({ kind: a.kind, id: a.id }));
  const history = await recentTurns(db, threadId, 2);
  const answer = await answerFor(db, user, t, questionMsg.text, scopeSchema.catch("ALL").parse(t.scope), { generate: opts.generate, attachments, history });
  await db.$transaction([
    db.chatMessage.delete({ where: { id: answerMsg.id } }),
    db.chatMessage.create({ data: { threadId, role: "ASSISTANT", text: answer.summary, answerJson: JSON.stringify(answer), createdAt: now() } }),
    db.chatThread.update({ where: { id: threadId }, data: { updatedAt: now() } }),
  ]);
  return answer;
}

export async function renameThread(db: Db, user: SessionUser, threadId: string, title: string) {
  await loadThread(db, user, threadId);
  const v = title.trim();
  if (!v) throw new AppError("Give the conversation a name.", "VALIDATION", { title: "Give it a name." });
  return db.chatThread.update({ where: { id: threadId }, data: { title: v.slice(0, 80) } });
}

export async function setThreadArchived(db: Db, user: SessionUser, threadId: string, archived: boolean) {
  await loadThread(db, user, threadId);
  return db.chatThread.update({ where: { id: threadId }, data: { archivedAt: archived ? now() : null } });
}

/** Deletes a conversation. The questions stay in the audit log, as every question is recorded when asked. */
export async function deleteThread(db: Db, user: SessionUser, threadId: string) {
  const t = await loadThread(db, user, threadId);
  await db.$transaction(async (tx) => {
    await tx.chatThread.delete({ where: { id: threadId } });
    await recordAudit(tx, { caseId: t.caseId, actorId: user.id, action: "assistant.conversation_deleted", objectType: "ChatThread", objectId: threadId, summary: `Deleted the conversation “${t.title}”` });
  });
}

export async function setMessageFeedback(db: Db, user: SessionUser, messageId: string, feedback: "UP" | "DOWN" | null) {
  const m = await db.chatMessage.findUnique({ where: { id: messageId } });
  if (!m) throw notFoundError("message");
  await loadThread(db, user, m.threadId);
  if (m.role !== "ASSISTANT") throw new AppError("Only an answer can be rated.", "VALIDATION");
  return db.chatMessage.update({ where: { id: messageId }, data: { feedback } });
}

/** A plain-text copy of a conversation, with each answer's sources, for a case diary or a colleague. */
export async function exportThread(db: Db, user: SessionUser, threadId: string): Promise<{ fileName: string; text: string }> {
  const t = await getThread(db, user, threadId);
  const lines = [`${t.title}`, `${t.kind === "CASE" ? "Case assistant" : "Procedure assistant"} · exported ${formatDateTimeIST(now())} by ${user.displayName}`, ""];
  for (const m of t.messages) {
    lines.push(`${m.role === "USER" ? "Question" : "Answer"} · ${formatDateTimeIST(new Date(m.at))}`);
    for (const a of m.attachments) lines.push(`  Attached: ${a.label} (${a.sub})`);
    lines.push(m.text);
    const a = m.answer;
    if (a && "connections" in a && a.connections?.length) for (const [i, k] of a.connections.entries()) lines.push(`  K${i + 1} ${KIND_WORD[k.kind] ?? k.kind} ${k.value}: in ${k.in.map((x) => x.label).join(", ")}${k.note ? ` (${k.note})` : ""}`);
    if (a && "extracts" in a && a.extracts?.length) for (const e of a.extracts) lines.push(`  ${e.ref} ${e.heading}: “${e.text.slice(0, 300)}”`);
    if (a && "passages" in a && a.passages.length) for (const p of a.passages) lines.push(`  Source: ${p.documentTitle} ${p.sectionRef} (${p.status.toLowerCase()})`);
    if (a && "references" in a && a.references.length) for (const r of a.references) lines.push(`  ${r.ref}: ${r.label}`);
    if (a && "caution" in a && a.caution) lines.push(`  Caution: ${a.caution}`);
    if (a) lines.push(`  Answered by: ${a.provider.label}${"mode" in a && a.mode === "GENERAL" ? " (general knowledge, not from the approved sources)" : ""}`);
    lines.push("");
  }
  await db.$transaction((tx) => recordAudit(tx, { caseId: t.caseId, actorId: user.id, action: "assistant.conversation_exported", objectType: "ChatThread", objectId: threadId, summary: `Exported the conversation “${t.title}” as text` }));
  return { fileName: `${fileStem(t.title)}.txt`, text: lines.join("\r\n") };
}

const fileStem = (title: string) => title.replace(/[^\w]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "conversation";

function answerBlocks(a: CaseAnswer | GuidanceAnswer, text: string): DocBlock[] {
  const out: DocBlock[] = [{ kind: "para", text }];
  if ("about" in a && a.about) out.push({ kind: "small", text: a.about });
  if ("connections" in a && a.connections?.length) {
    out.push({ kind: "subheading", text: "Written in more than one attachment" });
    for (const [i, k] of a.connections.entries()) out.push({ kind: "bullet", text: `K${i + 1} · ${KIND_WORD[k.kind] ?? k.kind} ${k.value}: ${k.in.map((x) => `${x.label} (${x.refs.join(", ")})`).join("; ")}${k.note ? `. ${k.note}` : ""}` });
  }
  if ("extracts" in a && a.extracts?.length) for (const e of a.extracts) out.push({ kind: "quote", text: `${e.ref} · ${e.heading}: ${e.text}` });
  if ("passages" in a)
    for (const p of a.passages) out.push({ kind: "bullet", text: `${p.documentTitle} ${p.sectionRef} · ${p.heading}${p.status === "SUPERSEDED" ? " (superseded)" : ""}: ${p.text}` });
  if ("established" in a) {
    for (const [label, items] of [["Established by the records", a.established], ["Possible only", a.hypotheses], ["Not known yet", a.unknowns], ["Steps", a.steps]] as const) {
      if (!items.length) continue;
      out.push({ kind: "subheading", text: label });
      for (const i of items) out.push({ kind: "bullet", text: `${i.text}${i.refs.length ? ` [${i.refs.join(", ")}]` : ""}` });
    }
    if (a.references.length) {
      out.push({ kind: "subheading", text: "Records" });
      for (const r of a.references) out.push({ kind: "bullet", text: `${r.ref}: ${r.label}` });
    }
  }
  if ("caution" in a && a.caution) out.push({ kind: "small", text: a.caution });
  out.push({ kind: "small", text: `Answered by ${a.provider.label}. ${a.provider.disclosure}` });
  return out;
}

/**
 * A Word document of a whole conversation, or of one answer: what was asked, the answer, the quoted sources, and who
 * answered. It is prepared for the officer to check and edit; it is not an official record until they file it.
 */
export async function exportThreadDocx(db: Db, user: SessionUser, threadId: string, opts: { messageId?: string } = {}): Promise<{ fileName: string; buffer: Buffer }> {
  const t = await getThread(db, user, threadId);
  const messages = opts.messageId ? t.messages.filter((m, i) => m.id === opts.messageId || t.messages[i + 1]?.id === opts.messageId) : t.messages;
  if (opts.messageId && !messages.some((m) => m.id === opts.messageId && m.role === "ASSISTANT")) throw notFoundError("answer");
  const title = opts.messageId ? (messages.find((m) => m.role === "USER")?.text ?? t.title) : t.title;
  const blocks: DocBlock[] = [
    { kind: "title", text: title.length > 120 ? `${title.slice(0, 117)}…` : title },
    { kind: "small", text: `${t.kind === "CASE" ? "Case assistant" : "Procedure assistant"} · prepared ${formatDateTimeIST(now())} for ${user.rank} ${user.displayName}, ${user.stationName}. A working note to check against the cited sources; not an official record until filed.` },
  ];
  for (const m of messages) {
    if (m.role === "USER") {
      blocks.push({ kind: "heading", text: m.text.length > 160 ? `${m.text.slice(0, 157)}…` : m.text });
      for (const at of m.attachments) blocks.push({ kind: "small", text: `Attached: ${at.label} (${at.sub})` });
    } else if (m.answer) blocks.push(...answerBlocks(m.answer, m.text));
    else blocks.push({ kind: "para", text: m.text });
  }
  const buffer = buildDocx(blocks, { title, author: `${user.rank} ${user.displayName}`, created: now() });
  await db.$transaction((tx) => recordAudit(tx, { caseId: t.caseId, actorId: user.id, action: "assistant.document_prepared", objectType: "ChatThread", objectId: threadId, summary: opts.messageId ? `Saved an answer from “${t.title}” as a Word document` : `Exported the conversation “${t.title}” as a Word document` }));
  return { fileName: `${fileStem(title)}.docx`, buffer };
}
