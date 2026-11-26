import { beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@/server/db";
import { seedDemo } from "@/server/seed";
import type { SessionUser } from "@/server/auth/session";
import type { GuidanceAnswer } from "@/contracts/assistant";
import { askInThread, createThread, retryLastAnswer } from "@/server/services/chats";
import { askGuidance } from "@/server/services/assistant";
import { now } from "@/server/clock";
import { longDateIST } from "@/domain/conversation";

const db = getDb();
async function user(username: string): Promise<SessionUser> {
  const u = await db.user.findUniqueOrThrow({ where: { username }, include: { station: true } });
  return { id: u.id, username, displayName: u.displayName, rank: u.rank, role: u.role as SessionUser["role"], stationId: u.stationId, stationCode: u.station.code, stationName: u.station.name };
}
type Call = { prompt: string; system?: string; temperature?: number };
function model(reply: string) {
  const calls: Call[] = [];
  const generate = async (c: Call) => {
    calls.push(c);
    return { ok: true as const, text: reply, model: "gemma4:26b", ms: 3 };
  };
  return { calls, generate };
}
const offline = async () => ({ ok: false as const, error: "The local model is not running on this server." });
const ask = async (me: SessionUser, threadId: string, q: string, generate: Parameters<typeof askInThread>[4] extends infer O ? (O extends { generate?: infer G } ? G : never) : never) =>
  (await askInThread(db, me, threadId, q, { generate })) as GuidanceAnswer;

beforeAll(async () => {
  await seedDemo(db, { anchor: "2026-11-09" });
}, 240000);

describe("small talk in the procedure assistant", () => {
  it("answers a greeting by rules, without the library or the model, and records it", async () => {
    const me = await user("officer1");
    const t = await createThread(db, me, { kind: "PROCEDURE" });
    const m = model("should not be used");
    const a = await ask(me, t.id, "hi", m.generate);
    expect(m.calls).toHaveLength(0);
    expect(a).toMatchObject({ mode: "CHAT", kind: "ANSWER", passages: [], superseded: [], provider: { id: "RULES_CHAT" }, question: "hi" });
    expect(a.summary).toMatch(/^Good (morning|afternoon|evening), Krishna\./);
    expect((await db.chatThread.findUniqueOrThrow({ where: { id: t.id } })).title).toBe("hi");
    expect(await db.auditEvent.count({ where: { action: "assistant.guidance_question", summary: { contains: "“hi”" } } })).toBe(1);
  });

  it("tells today's date from the app clock", async () => {
    const me = await user("officer1");
    const t = await createThread(db, me, { kind: "PROCEDURE" });
    expect((await ask(me, t.id, "what's today?", offline)).summary).toBe(`Today is ${longDateIST(now())}.`);
  });

  it("answers the question that follows a greeting", async () => {
    const me = await user("officer1");
    const t = await createThread(db, me, { kind: "PROCEDURE" });
    const a = await ask(me, t.id, "Hello, what fields does a CDR request need under the circular?", offline);
    expect(a.mode).toBeUndefined();
    expect(a.kind).not.toBe("INSUFFICIENT");
    expect(a.passages.length).toBeGreaterThan(0);
    expect(a.question).toBe("Hello, what fields does a CDR request need under the circular?");
  });

  it("does not offer FIR cases to the developer account", async () => {
    const dev = await user("developer");
    const t = await createThread(db, dev, { kind: "PROCEDURE" });
    const a = await ask(dev, t.id, "what can you do?", offline);
    expect(a.mode).toBe("CHAT");
    expect(a.summary).not.toMatch(/FIR case/);
  });
});

describe("general questions go to the local model, labelled as such", () => {
  it("answers from general knowledge, given today's date and the conversation so far", async () => {
    const me = await user("officer1");
    const t = await createThread(db, me, { kind: "PROCEDURE" });
    await ask(me, t.id, "hi", offline);
    const m = model("Why did the computer go to the doctor? **It had a virus.**");
    const a = await ask(me, t.id, "Tell me a joke about computers", m.generate);
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0]!.system).toContain(`Today is ${longDateIST(now())}`);
    expect(m.calls[0]!.prompt).toMatch(/Officer: hi\nAssistant: Good/);
    expect(m.calls[0]!.prompt).toMatch(/Question: Tell me a joke about computers$/);
    expect(a).toMatchObject({ mode: "GENERAL", kind: "ANSWER", passages: [], provider: { id: "LOCAL_MODEL" } });
    // Markdown is kept: the chat shows it formatted.
    expect(a.summary).toBe("Why did the computer go to the doctor? **It had a virus.**");
    expect(a.provider.disclosure).toMatch(/not from the approved sources/i);
    expect(a.caution).toBeUndefined();

    // Asked again, the same history is used, without the answer being replaced.
    const again = model("Another one.");
    await retryLastAnswer(db, me, t.id, { generate: again.generate });
    expect(again.calls[0]!.prompt).toMatch(/Officer: hi\nAssistant: Good/);
    expect(again.calls[0]!.prompt).not.toMatch(/Officer: Tell me a joke/);
  });

  it("adds a caution when a general answer names a legal provision", async () => {
    const m = model("Online identity theft is covered by Section 66C of the IT Act.");
    const a = await askGuidance(db, await user("officer1"), "explain identity theft in simple words", { generate: m.generate });
    expect(a.mode).toBe("GENERAL");
    expect(a.caution).toMatch(/legal provision/);
  });

  it("never answers law or procedure from the model's memory", async () => {
    const m = model("Section 999 of the Zzz Act gives seven years in prison.");
    const a = await askGuidance(db, await user("officer1"), "What is the punishment under section 999 of the Zzz Act?", { generate: m.generate });
    expect(a.kind).toBe("INSUFFICIENT");
    expect(a.mode).toBeUndefined();
    expect(a.summary).not.toMatch(/seven years/);
    expect(a.summary).toMatch(/approved library does not cover this/);
  });

  it("says plainly when the model cannot be used", async () => {
    const a = await askGuidance(db, await user("officer1"), "tell me a joke", { generate: offline });
    expect(a.kind).toBe("INSUFFICIENT");
    expect(a.summary).toMatch(/General questions are answered by the local model on this server, which could not be used: The local model is not running/);
  });
});
