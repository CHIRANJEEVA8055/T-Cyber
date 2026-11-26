import { describe, expect, it, beforeAll } from "vitest";
import { getDb } from "@/server/db";
import { seedDemo } from "@/server/seed";
import { askCaseAssistant, askGuidance, getGuidanceLibrary } from "@/server/services/assistant";
import type { SessionUser } from "@/server/auth/session";
import type { CaseAnswer } from "@/contracts/assistant";

const db = getDb();
let ids: Awaited<ReturnType<typeof seedDemo>>;

async function user(username: string): Promise<SessionUser> {
  const u = await db.user.findUniqueOrThrow({ where: { username }, include: { station: true } });
  return { id: u.id, username, displayName: u.displayName, rank: u.rank, role: u.role === "SUPERVISOR" ? "SUPERVISOR" : "OFFICER", stationId: u.stationId, stationCode: u.station.code, stationName: u.station.name };
}
const texts = (items: CaseAnswer["established"]) => items.map((i) => i.text).join("\n");
function expectRefsResolve(a: CaseAnswer) {
  for (const item of [...a.steps, ...a.established, ...a.hypotheses, ...a.unknowns]) for (const r of item.refs) expect(a.references.map((x) => x.ref)).toContain(r);
}

beforeAll(async () => {
  ids = await seedDemo(db, { anchor: "2026-11-09" });
}, 120000);

describe("case assistant: rules first, then the local model", () => {
  it("sends a question the rules cannot place to the local model, grounded in numbered case facts it must cite", async () => {
    let seen = "";
    const generate = async (o: { prompt: string; system?: string }) => {
      seen = `${o.system}\n${o.prompt}`;
      const n = /(F\d+)\. [^\n]*Account B/.exec(o.prompt)?.[1] ?? "F1";
      return { ok: true as const, text: `Account B holds the larger share of what is held [${n}].`, model: "gemma4:26b", ms: 5 };
    };
    const a = await askCaseAssistant(db, await user("officer1"), ids.fir412Id, "Give me a two line summary for the supervisor", { generate });
    expect(a.intent).toBe("MODEL");
    expect(a.provider).toMatchObject({ id: "LOCAL_MODEL", label: "Local model · gemma4:26b" });
    expect(a.provider.disclosure).toMatch(/Nothing left this computer/);
    expect(a.summary).toMatch(/^Account B holds/);
    expect(a.established).toHaveLength(1);
    expectRefsResolve(a);
    expect(seen).toMatch(/Answer only from the numbered case facts/);
    expect(seen).toMatch(/F1\. /);
    expect(await db.auditEvent.count({ where: { caseId: ids.fir412Id, action: "assistant.case_question", summary: { contains: "answered by the local model" } } })).toBe(1);
  });

  it("flags a model answer that cites no record as unsupported", async () => {
    const generate = async () => ({ ok: true as const, text: "It is probably a big gang.", model: "gemma4:26b", ms: 5 });
    const a = await askCaseAssistant(db, await user("officer1"), ids.fir412Id, "Tell me a story about this case please", { generate });
    expect(a.intent).toBe("MODEL");
    expect(a.unknowns[0]!.text).toMatch(/cited no recorded fact/);
    expect(a.references).toEqual([]);
  });

  it("says plainly when the local model cannot be used, and keeps the rules' help", async () => {
    const generate = async () => ({ ok: false as const, error: "The local model is not running on this server. An administrator can start it with: sudo systemctl enable --now ollama" });
    const a = await askCaseAssistant(db, await user("officer1"), ids.fir412Id, "Write me a poem about the accused", { generate });
    expect(a.intent).toBe("HELP");
    expect(a.summary).toMatch(/the local model could not be used: The local model is not running/);
  });

  it("never sends a question the rules can answer to the model", async () => {
    let called = false;
    const generate = async () => {
      called = true;
      return { ok: true as const, text: "x", model: "m", ms: 1 };
    };
    const a = await askCaseAssistant(db, await user("officer1"), ids.fir412Id, "How much money is held?", { generate });
    expect(a.intent).toBe("MONEY");
    expect(called).toBe(false);
  });
});

describe("procedure assistant: rules first, then the local model", () => {
  it("answers from the nearest library passages when no section matches by rules, citing them", async () => {
    let prompt = "";
    const generate = async (o: { prompt: string }) => {
      prompt = o.prompt;
      const n = /(S\d+)\. [^\n]*§7\.3/.exec(o.prompt)?.[1] ?? "S1";
      return { ok: true as const, text: `For more than one victim the court route applies [${n}].`, model: "gemma4:26b", ms: 5 };
    };
    // "formula" appears once, in the text of §7.3: too little for the rules, enough to hand the passage to the model.
    const g = await askGuidance(db, await user("officer1"), "zzqx blorf formula", { generate });
    expect(prompt).toMatch(/S1\. [^\n]*§7\.3/);
    expect(g.provider.id).toBe("LOCAL_MODEL");
    expect(g.kind).toBe("ANSWER");
    expect(g.passages.map((p) => p.sectionRef)).toEqual(["§7.3"]);
  });

  it("keeps the rules' 'not covered' answer and says why when the model cannot be used", async () => {
    const generate = async () => ({ ok: false as const, error: "The local model is not running on this server." });
    const g = await askGuidance(db, await user("officer1"), "zzqx blorf wibble", { generate });
    expect(g.kind).toBe("INSUFFICIENT");
    expect(g.summary).toMatch(/General questions are answered by the local model on this server, which could not be used: The local model is not running/);
    const law = await askGuidance(db, await user("officer1"), "Which section of the zzqx Act applies?", { generate });
    expect(law.summary).toMatch(/does not cover this/);
  });
});

describe("case assistant (rules)", () => {
  it("answers money questions from the ledger and keeps unknown amounts apart", async () => {
    const a = await askCaseAssistant(db, await user("officer1"), ids.fir412Id, "How much money is secured?");
    expect(a.intent).toBe("MONEY");
    expect(a.summary).toContain("₹80,000 of the ₹1,00,000 reported lost is confirmed held");
    expect(a.summary).toContain("₹20,000 is neither held nor returned");
    expect(a.summary).toContain("None of the held money is allocated to a victim yet");
    expect(texts(a.established)).toContain("₹50,000 confirmed held in Account B (Bank B)");
    expect(texts(a.established)).toContain("₹0 confirmed held in Account A (Bank A)");
    expect(a.provider).toMatchObject({ id: "DEMO_LOCAL", label: "Rules" });
    expect(a.provider.disclosure).toMatch(/fixed rules over this case's records/);
    expectRefsResolve(a);
  });

  it("separates what the records establish from what is only reported or possible", async () => {
    const a = await askCaseAssistant(db, await user("officer1"), ids.fir412Id, "Which facts are supported by evidence?");
    expect(a.intent).toBe("SUPPORTED");
    expect(texts(a.established)).toMatch(/₹70,000 from Account A to Account B .*confirmed by a bank record/);
    expect(texts(a.established)).toMatch(/₹20,000 from Account B to Cash, ATM Kukatpally/);
    expect(texts(a.hypotheses)).toMatch(/That P2 operated Account B .*does not by itself show/);
    expect(texts(a.established)).not.toMatch(/\.\./);
    expect(a.established.every((i) => i.refs.length > 0)).toBe(true);
    expectRefsResolve(a);
  });

  it("lists what is still missing, with links that only open pages in this case", async () => {
    const a = await askCaseAssistant(db, await user("officer1"), ids.fir412Id, "What is still missing?");
    expect(a.intent).toBe("MISSING");
    expect(a.unknowns.length).toBeGreaterThan(3);
    expect(a.suggestions.length).toBeGreaterThan(0);
    expect(a.suggestions.every((s) => s.href.startsWith(`/cases/${ids.fir412Id}`))).toBe(true);
    expectRefsResolve(a);
  });

  it("puts responses waiting for review first in what to review next", async () => {
    const a = await askCaseAssistant(db, await user("officer1"), ids.fir412Id, "What should I review next?");
    expect(a.intent).toBe("NEXT");
    expect(a.steps[0]!.text).toMatch(/response/i);
    // The unmatched message and its review task are one step, not two.
    expect(a.steps.filter((s) => s.text.includes("nodal.officer@bank-c.example.invalid"))).toHaveLength(1);
    expectRefsResolve(a);
  });

  it("answers about a named record without implying involvement", async () => {
    const a = await askCaseAssistant(db, await user("officer1"), ids.fir412Id, "What do we know about P2?");
    expect(a.intent).toBe("RECORD");
    expect(texts(a.established)).toMatch(/KYC record lists P2 as the holder of Account B/);
    expect(texts(a.hypotheses)).toMatch(/does not by itself show/);
    expect(a.suggestions.some((s) => s.href.includes("/graph?focus="))).toBe(true);
    expectRefsResolve(a);
  });

  it("reports changes to the case, not who looked at it or report housekeeping", async () => {
    const officer = await user("officer1");
    await askCaseAssistant(db, officer, ids.fir412Id, "How much money is secured?");
    const a = await askCaseAssistant(db, officer, ids.fir412Id, "What changed recently?");
    expect(a.intent).toBe("WHAT_CHANGED");
    expect(a.established.length).toBeGreaterThan(0);
    expect(texts(a.established)).not.toMatch(/Asked the demo assistant/);
    expect(a.summary).not.toMatch(/Asked the demo assistant/);
  });

  it("says what it can answer instead of guessing", async () => {
    const a = await askCaseAssistant(db, await user("officer1"), ids.fir412Id, "Write the chargesheet for me");
    expect(a.intent).toBe("HELP");
    expect([...a.established, ...a.hypotheses, ...a.unknowns]).toEqual([]);
    expect(a.summary).toMatch(/cannot/);
  });

  it("is limited to cases the officer may see, and records each question", async () => {
    await expect(askCaseAssistant(db, await user("officer2"), ids.fir412Id, "How much money is secured?")).rejects.toMatchObject({ code: "NOT_FOUND" });
    const ev = await db.auditEvent.findFirst({ where: { caseId: ids.fir412Id, action: "assistant.case_question" }, orderBy: { at: "desc" } });
    expect(ev?.summary).toContain("Write the chargesheet for me");
  });

  it("asks for a real question", async () => {
    await expect(askCaseAssistant(db, await user("officer1"), ids.fir412Id, "  ")).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

describe("general guidance (demo)", () => {
  it("answers from the approved library only and never reads case files", async () => {
    const g = await askGuidance(db, await user("officer1"), "What fields does a CDR request need under the circular?");
    expect(g.kind).toBe("ANSWER");
    expect(g.passages[0]).toMatchObject({ docNumber: "Cir. 14/2026" });
    expect(g.superseded.map((p) => p.docNumber)).toEqual(expect.arrayContaining(["Cir. 09/2025"]));
    expect(JSON.stringify(g)).not.toMatch(/FIR 412\/2026|Account A|XXXXXXXX/);
    const ev = await db.auditEvent.findFirst({ where: { action: "assistant.guidance_question" }, orderBy: { at: "desc" } });
    expect(ev?.caseId).toBeNull();
  });

  it("lists the library with versions, effective dates and superseded status", async () => {
    const lib = await getGuidanceLibrary(db, await user("officer1"));
    const cir = lib.filter((d) => d.docNumber.startsWith("Cir.")).map((d) => [d.docNumber, d.status]);
    expect(cir).toEqual(expect.arrayContaining([["Cir. 14/2026", "CURRENT"], ["Cir. 09/2025", "SUPERSEDED"]]));
    expect(lib).toHaveLength(6);
    expect(lib.every((d) => d.effectiveFrom && d.jurisdiction)).toBe(true);
  });
});
