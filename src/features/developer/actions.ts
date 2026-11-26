"use server";

import { getDb } from "@/server/db";
import { deleteKnowledgeDraft, publishKnowledgeDocument, restoreKnowledgeDocument, retireKnowledgeDocument, startNewVersion, updateKnowledgeDraft } from "@/server/services/knowledge-admin";
import { deletePromptTemplate, movePromptTemplate, savePromptTemplate } from "@/server/services/prompt-templates";
import { runAction } from "@/features/shared/run-action";

export async function saveDraftAction(id: string, input: { meta?: unknown; sections?: unknown }) {
  return runAction(async (user) => {
    await updateKnowledgeDraft(getDb(), user, id, input);
    return null;
  });
}
export async function publishAction(id: string) {
  return runAction(async (user) => {
    await publishKnowledgeDocument(getDb(), user, id);
    return null;
  });
}
export async function newVersionAction(id: string) {
  return runAction(async (user) => startNewVersion(getDb(), user, id));
}
export async function retireAction(id: string, reason: string) {
  return runAction(async (user) => {
    await retireKnowledgeDocument(getDb(), user, id, reason);
    return null;
  });
}
export async function restoreAction(id: string) {
  return runAction(async (user) => {
    await restoreKnowledgeDocument(getDb(), user, id);
    return null;
  });
}
export async function deleteDraftAction(id: string) {
  return runAction(async (user) => {
    await deleteKnowledgeDraft(getDb(), user, id);
    return null;
  });
}
export async function savePromptAction(id: string | null, input: unknown) {
  return runAction(async (user) => savePromptTemplate(getDb(), user, id, input));
}
export async function movePromptAction(id: string, direction: "up" | "down") {
  return runAction(async (user) => {
    await movePromptTemplate(getDb(), user, id, direction);
    return null;
  });
}
export async function deletePromptAction(id: string) {
  return runAction(async (user) => {
    await deletePromptTemplate(getDb(), user, id);
    return null;
  });
}
