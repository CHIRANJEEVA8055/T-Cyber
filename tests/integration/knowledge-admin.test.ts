import { beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@/server/db";
import { seedDemo, wipeAll } from "@/server/seed";
import type { SessionUser } from "@/server/auth/session";
import { loadCaseForUser } from "@/server/auth/access";
import { getDashboard } from "@/server/services/dashboard";
import { searchRecords } from "@/server/services/search";
import { askGuidance } from "@/server/services/assistant";
import { loadLibrary } from "@/server/ai/library";
import { deleteKnowledgeDraft, getKnowledgeDocument, listKnowledge, publishKnowledgeDocument, restoreKnowledgeDocument, retireKnowledgeDocument, startNewVersion, updateKnowledgeDraft, uploadKnowledgeDocument } from "@/server/services/knowledge-admin";
import { deletePromptTemplate, listPromptTemplates, movePromptTemplate, savePromptTemplate } from "@/server/services/prompt-templates";
import { listSystemAudit } from "@/server/services/system-audit";
import { buildDocx } from "@/server/documents/docx-writer";

const db = getDb();
let fir412 = "";
async function user(username: string): Promise<SessionUser> {
  const u = await db.user.findUniqueOrThrow({ where: { username }, include: { station: true } });
  return { id: u.id, username, displayName: u.displayName, rank: u.rank, role: u.role as SessionUser["role"], stationId: u.stationId, stationCode: u.station.code, stationName: u.station.name };
}
const offline = async () => ({ ok: false as const, error: "The local model is not running on this server." });
const meta = (over: Record<string, unknown> = {}) => ({
  title: "Freeze escalation circular",
  docNumber: "Cir. 21/2026",
  issuingBody: "Telangana Police",
  jurisdiction: "Telangana",
  version: "21/2026",
  effectiveFrom: "2026-11-01",
  category: "CIRCULAR",
  summary: "When a bank hold may be escalated to a debit freeze.",
  ...over,
});
const circular = Buffer.from(["Freeze escalation circular", "", "1. Debit freeze", "A debit freeze on a mule account needs the written approval of the SHO and the FIR copy.", "", "2. Review", "The freeze is reviewed every 30 days."].join("\n"));

beforeAll(async () => {
  fir412 = (await seedDemo(db, { anchor: "2026-11-09" })).fir412Id;
}, 240000);

describe("the developer account", () => {
  it("signs in like any account but can open no case, dashboard or search", async () => {
    const dev = await user("developer");
    expect(dev.role).toBe("DEVELOPER");
    await expect(loadCaseForUser(db, dev, fir412)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(getDashboard(db, dev)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(searchRecords(db, dev, "412")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("is the only account that can change the knowledge base", async () => {
    const officer = await user("officer1");
    const supervisor = await user("supervisor");
    for (const u of [officer, supervisor]) {
      await expect(uploadKnowledgeDocument(db, u, { fileName: "c.txt", buffer: circular, meta: meta() })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(listKnowledge(db, u)).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(savePromptTemplate(db, u, null, { title: "x".repeat(5), question: "What is a hold request?" })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(listSystemAudit(db, u)).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
  });
});

describe("keeping the knowledge base", () => {
  it("uploads a file as a draft that is not answered from until it is published", async () => {
    const dev = await user("developer");
    const officer = await user("officer1");
    await expect(uploadKnowledgeDocument(db, dev, { fileName: "c.txt", buffer: circular, meta: meta({ title: "", effectiveFrom: "1 Nov" }) })).rejects.toMatchObject({ code: "VALIDATION", fieldErrors: { title: expect.any(String), effectiveFrom: expect.any(String) } });
    const { id, sections } = await uploadKnowledgeDocument(db, dev, { fileName: "c.txt", buffer: circular, meta: meta() });
    expect(sections).toBe(3);
    const draft = await getKnowledgeDocument(db, dev, id);
    expect(draft).toMatchObject({ status: "DRAFT", fileName: "c.txt", hasOriginal: true });
    expect(draft.sections.map((s) => s.sectionRef)).toEqual(["Intro", "§1", "§2"]);
    await expect(getKnowledgeDocument(db, officer, id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await loadLibrary(db)).some((d) => d.id === id)).toBe(false);

    await updateKnowledgeDraft(db, dev, id, { sections: draft.sections.filter((s) => s.sectionRef !== "Intro") });
    await expect(updateKnowledgeDraft(db, dev, id, { sections: [{ sectionRef: "§1", heading: "A", text: "x" }, { sectionRef: "§1", heading: "B", text: "y" }] })).rejects.toThrow(/share the reference/);
    await publishKnowledgeDocument(db, dev, id);
    await expect(publishKnowledgeDocument(db, dev, id)).rejects.toMatchObject({ code: "CONFLICT" });
    const a = await askGuidance(db, officer, "When does a debit freeze on a mule account need SHO approval?", { generate: offline, scope: "SOP" });
    expect(a.passages[0]).toMatchObject({ documentId: id, sectionRef: "§1" });
  });

  it("reads a Word file, and a new version supersedes the old one when published", async () => {
    const dev = await user("developer");
    const docx = buildDocx(
      [
        { kind: "heading", text: "1. Debit freeze" },
        { kind: "para", text: "A debit freeze needs the written approval of the ACP from 1 December 2026." },
      ],
      { title: "v2", author: "Developer", created: new Date() },
    );
    const old = (await listKnowledge(db, dev, { q: "Freeze escalation" })).rows.find((r) => r.status === "CURRENT")!;
    const fresh = await uploadKnowledgeDocument(db, dev, { fileName: "cir-21-v2.docx", buffer: docx, meta: meta({ version: "21/2026 rev. 1", effectiveFrom: "2026-12-01" }), replacesId: old.id });
    await publishKnowledgeDocument(db, dev, fresh.id);
    const before = await getKnowledgeDocument(db, dev, old.id);
    expect(before).toMatchObject({ status: "SUPERSEDED", successor: { id: fresh.id } });
    expect(before.history.map((h) => h.action)).toContain("knowledge.superseded");
    const started = await startNewVersion(db, dev, fresh.id);
    expect(await startNewVersion(db, dev, fresh.id)).toEqual({ id: started.id, existing: true });
    await deleteKnowledgeDraft(db, dev, started.id);
    await expect(deleteKnowledgeDraft(db, dev, fresh.id)).rejects.toMatchObject({ code: "PRECONDITION" });
  });

  it("retires a document so it is no longer answered from, and restores it", async () => {
    const dev = await user("developer");
    const officer = await user("officer1");
    const cur = (await listKnowledge(db, dev, { q: "Freeze escalation", status: "CURRENT" })).rows[0]!;
    await expect(retireKnowledgeDocument(db, dev, cur.id, "old")).rejects.toMatchObject({ code: "VALIDATION" });
    await retireKnowledgeDocument(db, dev, cur.id, "Withdrawn by the DGP's office on 10 November.");
    expect((await loadLibrary(db)).some((d) => d.id === cur.id)).toBe(false);
    await expect(getKnowledgeDocument(db, officer, cur.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await restoreKnowledgeDocument(db, dev, cur.id);
    expect((await loadLibrary(db)).some((d) => d.id === cur.id)).toBe(true);
  });

  it("keeps the knowledge base, ready questions and their history through a demonstration reset", async () => {
    const dev = await user("developer");
    const t = await savePromptTemplate(db, dev, null, { title: "Debit freeze approvals", question: "Who approves a debit freeze on a mule account?", sourceLabel: "Cir. 21/2026" });
    const docsBefore = await db.knowledgeDocument.count();
    await wipeAll(db);
    await seedDemo(db, { anchor: "2026-11-09" });
    expect(await db.knowledgeDocument.count()).toBe(docsBefore);
    const dev2 = await user("developer");
    expect((await listPromptTemplates(db, dev2)).some((x) => x.id === t.id)).toBe(true);
    const audit = await listSystemAudit(db, dev2, { kind: "KNOWLEDGE" });
    expect(audit.rows.some((r) => r.action === "knowledge.published")).toBe(true);
  }, 240000);
});

describe("ready questions and the audit view", () => {
  it("adds, orders, hides and deletes ready questions; officers see only the shown ones", async () => {
    const dev = await user("developer");
    const officer = await user("officer1");
    await expect(savePromptTemplate(db, dev, null, { title: "a", question: "b" })).rejects.toMatchObject({ fieldErrors: { title: expect.any(String), question: expect.any(String) } });
    const { id } = await savePromptTemplate(db, dev, null, { title: "Hold expiry", question: "When does a CFCFRMS hold lapse?", sourceLabel: "SOP 2026" });
    await movePromptTemplate(db, dev, id, "up");
    const all = await listPromptTemplates(db, dev, { all: true });
    expect(all.at(-2)!.id).toBe(id);
    await savePromptTemplate(db, dev, id, { title: "Hold expiry", question: "When does a CFCFRMS hold lapse?", sourceLabel: "SOP 2026", active: false });
    expect((await listPromptTemplates(db, officer, { all: true })).some((x) => x.id === id)).toBe(false);
    await deletePromptTemplate(db, dev, id);
    const audit = await listSystemAudit(db, dev, { kind: "PROMPT" });
    expect(audit.rows.map((r) => r.action)).toEqual(expect.arrayContaining(["prompt.created", "prompt.updated", "prompt.deleted"]));
  });

  it("shows assistant use without case contents", async () => {
    const dev = await user("developer");
    const audit = await listSystemAudit(db, dev, { kind: "ALL" });
    for (const r of audit.rows.filter((x) => x.caseRef)) expect(r.summary).not.toMatch(/“/);
    expect(audit.rows.some((r) => r.action === "auth.signed_in" || r.kind === "KNOWLEDGE")).toBe(true);
  });
});
