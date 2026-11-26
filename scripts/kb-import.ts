import fs from "node:fs";
import path from "node:path";
import { getDb } from "../src/server/db";
import { importKnowledgeFolder } from "../src/server/services/knowledge-admin";
import { savePromptTemplate } from "../src/server/services/prompt-templates";
import type { SessionUser } from "../src/server/auth/session";

/**
 * Imports a folder of prepared knowledge-base documents (Markdown with front-matter) as the developer account:
 *   npm run kb:import -- "data/Knowledge Base" [--retire-illustrative] [--templates] [--resection]
 * (--resection re-reads unchanged documents into sections in place, after the sectioning rules improve.)
 * Unchanged documents are skipped; a changed document becomes a new version. Every action is in the audit log.
 */
const STARTER_QUESTIONS = [
  { title: "Refund of a Put-on-Hold amount", question: "How is a Put-on-Hold amount refunded to the victim, and what does the court application need?", sourceLabel: "Refund SOP, 17.02.2024" },
  { title: "Freezing and unfreezing an account", question: "When can a bank account be frozen or unfrozen, and who must approve it?", sourceLabel: "Defreeze SOP, 13.04.2024" },
  { title: "Reading a Telegram response", question: "What does a Telegram username LEARs response contain and how do I follow it up?", sourceLabel: "Telegram LEARs guide" },
  { title: "Tracing an investment-fraud money trail", question: "How do I trace the money trail in an investment-app fraud?", sourceLabel: "Investment fraud case studies" },
  { title: "Collecting WhatsApp group details", question: "How do I collect WhatsApp call and group information from the victim's phone?", sourceLabel: "WhatsApp video guide" },
  { title: "Details to collect in an ATM fraud", question: "What details do I collect for an ATM fraud transaction?", sourceLabel: "ATM fraud video guide" },
];

async function main() {
  const folder = process.argv.slice(2).find((a) => !a.startsWith("--"));
  if (!folder || !fs.existsSync(folder)) {
    console.error('Give the folder of prepared documents, e.g. npm run kb:import -- "data/Knowledge Base"');
    process.exit(1);
  }
  const db = getDb();
  const dev = await db.user.findFirst({ where: { role: "DEVELOPER", active: true }, include: { station: true } });
  if (!dev) {
    console.error("No active developer account. Reset or seed the demonstration first.");
    process.exit(1);
  }
  const user: SessionUser = { id: dev.id, username: dev.username, displayName: dev.displayName, rank: dev.rank, role: "DEVELOPER", stationId: dev.stationId, stationCode: dev.station.code, stationName: dev.station.name };
  const files = fs.readdirSync(folder).filter((f) => fs.statSync(path.join(folder, f)).isFile()).map((f) => ({ fileName: f, buffer: fs.readFileSync(path.join(folder, f)) }));
  const r = await importKnowledgeFolder(db, user, files, { retireIllustrative: process.argv.includes("--retire-illustrative"), resection: process.argv.includes("--resection") });
  console.log(`Imported ${r.imported.length}, updated ${r.updated.length}, unchanged ${r.unchanged.length}, skipped ${r.skipped.length}, retired ${r.retired.length}.`);
  for (const s of r.skipped) console.log(`  skipped ${s.file}: ${s.why}`);
  for (const t of r.retired) console.log(`  retired ${t}`);
  if (process.argv.includes("--templates")) {
    const current = await db.promptTemplate.findMany({ where: { active: true } });
    for (const t of current) await savePromptTemplate(db, user, t.id, { title: t.title, question: t.question, sourceLabel: t.sourceLabel, active: false });
    for (const q of STARTER_QUESTIONS) await savePromptTemplate(db, user, null, q);
    console.log(`Ready questions: ${current.length} hidden, ${STARTER_QUESTIONS.length} added for the imported knowledge base.`);
  }
}
main();
