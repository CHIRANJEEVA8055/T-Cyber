import { afterEach, describe, expect, it, vi } from "vitest";
import { newId } from "@/lib/browser";

// The app is opened over plain HTTP on the station network, where browsers do not offer crypto.randomUUID
// (it needs HTTPS or localhost). Ids made in the browser must not depend on it.
describe("ids made in the browser", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("still works where crypto.randomUUID is missing (plain HTTP)", () => {
    vi.stubGlobal("crypto", { getRandomValues: (b: Uint8Array) => b.map((_, i) => (i * 37 + 11) % 256) });
    const id = newId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("works with no crypto object at all", () => {
    vi.stubGlobal("crypto", undefined);
    const a = newId();
    const b = newId();
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(a).not.toBe(b);
  });

  it("uses crypto.randomUUID where the browser has it", () => {
    vi.stubGlobal("crypto", { randomUUID: () => "11111111-2222-4333-8444-555555555555" });
    expect(newId()).toBe("11111111-2222-4333-8444-555555555555");
  });
});
