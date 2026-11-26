import { beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@/server/db";
import { seedDemo } from "@/server/seed";
import type { SessionUser } from "@/server/auth/session";
import { askInThread, createThread, deleteThread, exportThread, getThread, listThreads, renameThread, setThreadArchived } from "@/server/services/chats";

const db = getDb();
let fir412 = "";
async function user(username: string): Promise<SessionUser> {
  const u = await db.user.findUniqueOrThrow({ where: { username }, include: { station: true } });
  return { id: u.id, username, displayName: u.displayName, rank: u.rank, role: u.role === "SUPERVISOR" ? "SUPERVISOR" : "OFFICER", stationId: u.stationId, stationCode: u.station.code, stationName: u.station.name };
}
const offline = async () => ({ ok: false as const, error: "The local model is not running on this server." });

beforeAll(async () => {
  fir412 = (await seedDemo(db, { anchor: "2026-11-09" })).fir412Id;
}, 240000);

describe("saved assistant conversations", () => {
  it("keeps the question and the answer, names the chat after the first question, and scopes procedure answers", async () => {
    const me = await user("officer1");
    const t = await createThread(db, me, { kind: "PROCEDURE", scope: "LAW" });
    const a = await askInThread(db, me, t.id, "What does a section 63 certificate need?", { generate: offline });
    expect("passages" in a && a.passages.every((p) => /Sakshya/.test(p.documentTitle))).toBe(true);
    const v = await getThread(db, me, t.id);
    expect(v).toMatchObject({ title: "What does a section 63 certificate need?", scope: "LAW" });
    expect(v.messages.map((m) => m.role)).toEqual(["USER", "ASSISTANT"]);
    expect((await listThreads(db, me, { kind: "PROCEDURE" })).groups[0]!.threads[0]!.id).toBe(t.id);
  });

  it("keeps each officer's chats private, and case chats behind case access", async () => {
    const me = await user("officer1");
    const t = await createThread(db, me, { kind: "CASE", caseId: fir412 });
    await askInThread(db, me, t.id, "What is still missing?", { generate: offline });
    await expect(getThread(db, await user("officer2"), t.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(createThread(db, await user("officer2"), { kind: "CASE", caseId: fir412 })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("renames, archives, restores, exports and deletes a chat", async () => {
    const me = await user("officer1");
    const t = await createThread(db, me, { kind: "PROCEDURE" });
    await askInThread(db, me, t.id, "What does a CDR request need?", { generate: offline });
    await renameThread(db, me, t.id, "CDR request fields");
    await setThreadArchived(db, me, t.id, true);
    expect((await listThreads(db, me, { kind: "PROCEDURE" })).archived.map((x) => x.title)).toContain("CDR request fields");
    await expect(askInThread(db, me, t.id, "And the period?", { generate: offline })).rejects.toMatchObject({ code: "PRECONDITION" });
    await setThreadArchived(db, me, t.id, false);
    const f = await exportThread(db, me, t.id);
    expect(f.fileName).toBe("CDR_request_fields.txt");
    expect(f.text).toContain("Source: UNICROSS request circular, Cir. 14/2026");
    await deleteThread(db, me, t.id);
    await expect(getThread(db, me, t.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await db.auditEvent.count({ where: { action: "assistant.conversation_deleted", objectId: t.id } })).toBe(1);
  });
});
