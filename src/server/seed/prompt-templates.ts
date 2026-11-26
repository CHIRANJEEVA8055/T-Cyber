import type { Db } from "../db";

/** The procedure assistant's ready questions. Each names the source it is answered from; the developer edits them. */
const TEMPLATES = [
  { title: "Required fields for a CDR request", question: "What fields does a CDR request need under the current circular?", sourceLabel: "Cir. 14/2026" },
  { title: "BSA s. 63 certificate checklist", question: "What does the BSA section 63 certificate need?", sourceLabel: "BSA 2023, Schedule" },
  { title: "When can an account be restricted, not just held?", question: "When can an account be restricted rather than just held?", sourceLabel: "SOP 2026 §5" },
  { title: "Can an emergency request be used for a financial loss?", question: "Can I use an emergency request to a platform when the victim is losing money fast?", sourceLabel: "Provider policies" },
  { title: "Restoring held funds with two victims", question: "What is the route for restoring held funds when there are two victims?", sourceLabel: "Restoration guide" },
  { title: "Preservation or disclosure first?", question: "How does a preservation request differ from a disclosure request to a platform?", sourceLabel: "Provider policies" },
];

export async function seedPromptTemplates(db: Db, developerId: string, at: Date) {
  await db.promptTemplate.createMany({ data: TEMPLATES.map((t, i) => ({ ...t, sortOrder: i, active: true, createdById: developerId, createdAt: at, updatedAt: at })) });
}
