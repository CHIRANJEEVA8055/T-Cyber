import { expect, test } from "@playwright/test";
import { openCase, signIn, signOut } from "./helpers";

test.describe("Assistants", () => {
  test("Case AI answers from this case's records, labelled as a demo, and only opens pages", async ({ page }) => {
    await signIn(page, "officer1");
    await openCase(page, "FIR 1/2026");
    await page.getByRole("link", { name: "Case AI" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Case AI" })).toBeVisible();
    await expect(page.getByText("No language model, external service or official SOP library is connected.").first()).toBeVisible();

    await page.getByRole("button", { name: "How much money is secured?" }).click();
    const money = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "“How much money is secured?”" }) });
    await expect(money.getByText(/Neither returned nor secured: ₹18,00,000 of the ₹20,00,000 reported lost/)).toBeVisible();
    await expect(money.getByRole("heading", { name: "Established by the records" })).toBeVisible();
    await expect(money.getByRole("heading", { name: "Not yet known" })).toBeVisible();
    await expect(money.getByText(/not counted as ₹0/).first()).toBeVisible();

    // Keyboard: Enter asks the typed question.
    const box = page.getByLabel("Your question about this case");
    await box.fill("What do we know about Account D?");
    await box.press("Enter");
    const record = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "“What do we know about Account D?”" }) });
    await expect(record.getByText(/₹8,00,000 from Account A to Account D .*confirmed by a bank record/)).toBeVisible();
    await expect(box).toHaveValue("");

    // Suggestions navigate; they never act.
    await money.getByRole("link", { name: "Open the funds ledger" }).click();
    await expect(page).toHaveURL(/\/funds$/);
  });

  test("AI guidance quotes the library, shows conflicting sources side by side and says when it has nothing", async ({ page }) => {
    await signIn(page, "officer1");
    await page.getByRole("link", { name: "AI guidance" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "AI guidance" })).toBeVisible();

    await page.getByRole("button", { name: "When should I follow up with a bank that has not replied?" }).click();
    const conflict = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "“When should I follow up with a bank that has not replied?”" }) });
    await expect(conflict.getByText("Current sources differ")).toBeVisible();
    await expect(conflict.getByText(/after 5 working days/)).toBeVisible();
    await expect(conflict.getByText(/after 3 working days/)).toBeVisible();
    await conflict.getByText(/Earlier versions that also mention this/).click();
    await expect(conflict.getByText(/after 10 working days/)).toBeVisible();
    await expect(conflict.getByText(/Superseded by version 2\.0/)).toBeVisible();

    await page.getByRole("button", { name: "What is the extradition procedure?" }).click();
    const none = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "“What is the extradition procedure?”" }) });
    await expect(none.getByText("Not covered by the library")).toBeVisible();
    await expect(none.getByText(/does not answer from general knowledge/)).toBeVisible();

    await page.getByRole("button", { name: "Read 7 sections" }).click();
    const drawer = page.getByRole("dialog", { name: "Station procedure: online financial fraud complaints" });
    await expect(drawer.getByRole("heading", { name: "§4 Follow-up interval" })).toBeVisible();
  });

  test("an officer not assigned to the case cannot open its assistant", async ({ page }) => {
    await signIn(page, "officer1");
    await openCase(page, "FIR 1/2026");
    const url = `${page.url()}/assistant`;
    await signOut(page);
    await signIn(page, "officer2");
    await page.goto(url);
    await expect(page.getByRole("heading", { name: "This case does not exist or you do not have access to it" })).toBeVisible();
  });
});
