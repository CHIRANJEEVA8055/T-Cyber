import type { AssistantProviderInfo } from "@/contracts/assistant";
import { answerFromLibrary, type GuidanceResult, type LibraryDocument } from "@/domain/guidance";
import type { Db } from "../db";
import type { CaseContext } from "./context";
import { composeCaseAnswer, type CaseAnswerBody } from "./demo-case";

/**
 * The seam for an assistant provider. A provider only receives what the server has already assembled for an
 * authorised user (one case's context, or the guidance library); it cannot query records itself and cannot act.
 */
export interface AssistantProvider {
  info: AssistantProviderInfo;
  answerCaseQuestion(question: string, context: CaseContext): Promise<CaseAnswerBody>;
  answerGuidanceQuestion(question: string, library: LibraryDocument[]): Promise<GuidanceResult>;
}

export const demoLocalProvider: AssistantProvider = {
  info: {
    id: "DEMO_LOCAL",
    label: "Rules",
    disclosure:
      "Answered by fixed rules over this case's records. A question the rules cannot place goes to the local model on this server, when it is running; no external service is used. The assistant cannot send anything or change a case.",
  },
  answerCaseQuestion: async (question, context) => composeCaseAnswer(question, context),
  answerGuidanceQuestion: async (question, library) => answerFromLibrary(question, library),
};

/**
 * Only the local demo provider is implemented, and nothing is sent outside the application. A model-backed
 * provider would implement the same interface and be selected here from the AI_PROVIDER integration setting.
 */
export async function getAssistantProvider(_db: Db): Promise<AssistantProvider> {
  return demoLocalProvider;
}
