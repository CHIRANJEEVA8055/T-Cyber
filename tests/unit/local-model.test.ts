import { describe, expect, it } from "vitest";
import { generateBody } from "@/server/ai/local-model";

describe("the request sent to the local model", () => {
  it("turns thinking off and keeps sourced answers at temperature 0 by default", () => {
    expect(generateBody("gemma4:26b", { prompt: "p", system: "s" })).toEqual({ model: "gemma4:26b", prompt: "p", system: "s", images: undefined, stream: false, think: false, options: { temperature: 0 } });
  });
  it("passes a chat temperature and a length cap, and thinking when asked for", () => {
    const body = generateBody("gemma4:26b", { prompt: "p", temperature: 0.3, maxTokens: 700, think: true, images: [Buffer.from("x")] });
    expect(body).toMatchObject({ think: true, images: ["eA=="], options: { temperature: 0.3, num_predict: 700 } });
  });
});
