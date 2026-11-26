import { describe, expect, it } from "vitest";
import { checkModelMo, decideMo } from "@/server/ai/mo-classify";
import type { GenerateOptions } from "@/server/ai/local-model";

// Synthetic FIR wording only.
const model = (text: string) => {
  const calls: GenerateOptions[] = [];
  const generate = async (o: GenerateOptions) => {
    calls.push(o);
    return { ok: true as const, text, model: "test-model", ms: 5 };
  };
  return { calls, generate };
};
const offline = async () => ({ ok: false as const, error: "The local model is not running on this server." });

describe("placing an FIR in a vertical of the MO table", () => {
  it("takes what the FIR states, without asking the model", async () => {
    const m = model('{"vertical":"OTP","subtype":null,"reason":"x"}');
    const d = await decideMo({ firText: "Category: Online Financial Fraud\nSub Category: Investment Scam / Trading Scam", facts: "The complainant shared an OTP.", sections: null }, { generate: m.generate });
    expect(d).toMatchObject({ key: "INVESTMENT", subtype: "Trading", basis: "FIR" });
    expect(d.reason).toContain("Sub Category: Investment Scam / Trading Scam");
    expect(m.calls).toHaveLength(0);
  });

  it("has the local model decide when the FIR states nothing, from the MO table only", async () => {
    const m = model('{"vertical":"SOCIAL_MEDIA","subtype":"WhatsApp DP","reason":"A WhatsApp account used the officer’s photo to ask for gift cards."}');
    const d = await decideMo({ firText: "3. Brief facts", facts: "A WhatsApp account with the Collector's photo asked staff to buy gift cards.", sections: "BNS 319(2); IT Act 66D" }, { generate: m.generate });
    expect(d).toMatchObject({ key: "SOCIAL_MEDIA", subtype: "WhatsApp DP", basis: "MODEL", model: "test-model" });
    const p = m.calls[0]!;
    expect(p.format).toBe("json");
    expect(p.prompt).toContain("INVESTMENT: Investment Frauds.");
    expect(p.prompt).toContain("Sections stated in the FIR: BNS 319(2); IT Act 66D");
    expect(p.prompt).toContain("Collector's photo");
    expect(p.system).toMatch(/not instructions/);
    // The model is given the FIR's own sections only; no section list of any vertical is put to it.
    expect(p.prompt).not.toMatch(/usual sections|BNS 318\(4\), 319\(2\), 336/i);
  });

  it("does not accept an answer outside the table, and falls back to the rules", async () => {
    expect(checkModelMo('{"vertical":"CRYPTO_SCAM","reason":"x"}')).toBeNull();
    expect(checkModelMo("not json")).toBeNull();
    expect(checkModelMo('{"vertical":"otp","subtype":"Made-up kind","reason":"r"}')).toEqual({ key: "OTP", subtype: null, reason: "r" });
    const m = model('{"vertical":"CRYPTO_SCAM"}');
    const d = await decideMo({ firText: "", facts: "The caller from customer care asked for the OTP, which was shared.", sections: null }, { generate: m.generate });
    expect(d).toMatchObject({ key: "OTP", basis: "FACTS" });
    expect(d.reason).toMatch(/^The local model's answer was not one of the MO table's verticals; read by the rules from the facts/);
  });

  it("always ends in one vertical, saying why, even with the model off and nothing to go on", async () => {
    const d = await decideMo({ firText: "", facts: "The facts are being verified.", sections: "BNS 318(4)" }, { generate: offline });
    expect(d).toMatchObject({ key: "MISC", subtype: null, basis: "DEFAULT" });
    expect(d.reason).toMatch(/The local model was not available, and nothing in the FIR points to another vertical/);
  });

  it("uses a stated section whose title names the class when the model is off and the facts show nothing", async () => {
    const d = await decideMo({ firText: "", facts: "Details awaited.", sections: "IT Act 66C" }, { generate: offline });
    expect(d).toMatchObject({ key: "SOCIAL_MEDIA", subtype: "Identity Theft", basis: "SECTIONS" });
  });
});
