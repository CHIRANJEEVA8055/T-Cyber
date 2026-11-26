import { describe, expect, it } from "vitest";
import { addressBreakPoints, recipientRole } from "@/lib/recipients";

describe("recipientRole", () => {
  it("drops a leading copy of the organisation", () => {
    expect(recipientRole("Demo Bank A", "Demo Bank A: Nodal Officer")).toBe("Nodal Officer");
  });

  it("matches the organisation without a trailing qualifier", () => {
    expect(recipientRole("Zonal ACP Office (demo)", "Zonal ACP Office: UNICROSS desk (demo)")).toBe("UNICROSS desk (demo)");
  });

  it("capitalises what remains", () => {
    expect(recipientRole("Demo Mail Provider", "Demo Mail Provider: law-enforcement portal")).toBe("Law-enforcement portal");
  });

  it("keeps a name that does not start with the organisation", () => {
    expect(recipientRole("NPCI route (demo)", "NPCI / payment-provider route (demo)")).toBe("NPCI / payment-provider route (demo)");
  });

  it("keeps the name when it is only the organisation", () => {
    expect(recipientRole("Demo Bank A", "Demo Bank A")).toBe("Demo Bank A");
  });
});

describe("addressBreakPoints", () => {
  it("breaks after @ and before each dot without losing characters", () => {
    const parts = addressBreakPoints("nodal.officer@bank-a.example.invalid");
    expect(parts).toEqual(["nodal", ".officer@", "bank-a", ".example", ".invalid"]);
    expect(parts.join("")).toBe("nodal.officer@bank-a.example.invalid");
  });

  it("leaves text without break points whole", () => {
    expect(addressBreakPoints("portal")).toEqual(["portal"]);
  });
});
