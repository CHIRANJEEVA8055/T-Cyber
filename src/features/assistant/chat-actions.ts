"use server";

import { getDb } from "@/server/db";
import { askInThread, createThread, deleteThread, listThreads, renameThread, retryLastAnswer, setMessageFeedback, setThreadArchived, type ChatKind } from "@/server/services/chats";
import { listAttachables } from "@/server/services/procedure-assistant";
import { getKnowledgeDocument } from "@/server/services/knowledge-admin";
import { prepareDraftFromTask } from "@/server/services/drafting";
import { runAction } from "@/features/shared/run-action";

type One = { kind: "FILE" | "MAIL" | "CASE"; id: string };
type Att = One | One[] | null;

export async function startChatAction(kind: ChatKind, caseId: string | null, scope: string) {
  return runAction(async (user) => ({ id: (await createThread(getDb(), user, { kind, caseId, scope })).id }), { refresh: false });
}
export async function askChatAction(threadId: string, question: string, scope: string, attachment: Att = null) {
  return runAction(async (user) => {
    await askInThread(getDb(), user, threadId, question, { scope, attachments: Array.isArray(attachment) ? attachment.slice(0, 20) : attachment ? [attachment] : [] });
    return null;
  });
}
export async function retryChatAction(threadId: string) {
  return runAction(async (user) => {
    await retryLastAnswer(getDb(), user, threadId);
    return null;
  });
}
export async function searchChatsAction(kind: ChatKind, caseId: string | null, q: string) {
  return runAction(async (user) => listThreads(getDb(), user, { kind, caseId, q }), { refresh: false });
}
export async function listAttachablesAction() {
  return runAction(async (user) => listAttachables(getDb(), user), { refresh: false });
}
export async function sourceDocumentAction(documentId: string) {
  return runAction(async (user) => getKnowledgeDocument(getDb(), user, documentId), { refresh: false });
}
export async function prepareDraftFromChatAction(taskId: string) {
  return runAction(async (user) => {
    const r = await prepareDraftFromTask(getDb(), user, taskId, { asAssistant: true });
    return { requestId: r.id, reference: r.reference, caseId: r.caseId };
  });
}
export async function renameChatAction(threadId: string, title: string) {
  return runAction(async (user) => {
    await renameThread(getDb(), user, threadId, title);
    return null;
  });
}
export async function archiveChatAction(threadId: string, archived: boolean) {
  return runAction(async (user) => {
    await setThreadArchived(getDb(), user, threadId, archived);
    return null;
  });
}
export async function deleteChatAction(threadId: string) {
  return runAction(async (user) => {
    await deleteThread(getDb(), user, threadId);
    return null;
  });
}
export async function rateAnswerAction(messageId: string, feedback: "UP" | "DOWN" | null) {
  return runAction(async (user) => {
    await setMessageFeedback(getDb(), user, messageId, feedback);
    return null;
  });
}
