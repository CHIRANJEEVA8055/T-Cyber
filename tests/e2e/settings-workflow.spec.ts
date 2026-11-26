import { expect, test } from "@playwright/test";
import { signIn, signOut } from "./helpers";

test.describe("Work queue and settings", () => {
  test("a supervisor rehearses a failed submission; the officer sees it fail once and succeed on retry", async ({ page }) => {
    await signIn(page, "supervisor");

    // The queue lists exactly what the navigation count says.
    const nav = page.getByRole("link", { name: /^Work queue/ });
    const badge = Number((await nav.innerText()).match(/\d+/)?.[0]);
    await nav.click();
    await expect(page.getByText(new RegExp(`^${badge} items? need action`))).toBeVisible();

    // Arm one simulated failure on the email route.
    await page.getByRole("link", { name: "Settings" }).click();
    await page.getByRole("navigation", { name: "Settings sections" }).getByRole("link", { name: "Integrations" }).click();
    const email = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: "Bank nodal / LEA email" }) });
    await email.getByRole("button", { name: "Make the next submission fail" }).click();
    await expect(email.getByText(/will fail once, then the setting clears itself/)).toBeVisible();

    // Approve the waiting request from the work queue.
    await page.getByRole("link", { name: /^Work queue/ }).click();
    await page.getByRole("link", { name: "Review and approve" }).first().click();
    await page.getByRole("button", { name: /^Approve version \d+$/ }).click();
    await page.getByRole("dialog").getByRole("button", { name: /^Approve version \d+$/ }).click();
    await expect(page.getByRole("button", { name: "Submit request" })).toBeVisible();
    const requestUrl = page.url();

    // The officer's first attempt fails, visibly; the retry succeeds.
    await signOut(page);
    await signIn(page, "officer1");
    await page.goto(requestUrl);
    await page.getByRole("button", { name: "Submit request" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Submit request" }).click();
    await expect(page.getByText("The last simulated submission failed")).toBeVisible();
    await page.getByRole("button", { name: "Retry submission" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Submit request" }).click();
    await expect(page.getByText(/Submitted through the simulation adapter/)).toBeVisible();
    await expect(page.getByText(/Follow up from/)).toBeVisible();
  });

  test("an officer can read settings but not change them, and search covers only their own cases", async ({ page }) => {
    await signIn(page, "officer2");
    await page.goto("/settings/routes");
    await expect(page.getByText("You can read the routes. Only a supervisor can change them.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Edit route" })).toHaveCount(0);
    await page.goto("/settings/demo");
    await expect(page.getByRole("button", { name: "Reset demonstration data" })).toHaveCount(0);

    // FIR 1/2026 belongs to another officer: its accounts and documents are not searched.
    const search = page.getByRole("banner").getByRole("searchbox");
    await search.fill("0937");
    await search.press("Enter");
    await expect(page).toHaveURL(/\/search\?q=0937$/);
    await expect(page.getByRole("heading", { name: "No matches for “0937” in your cases" })).toBeVisible();
  });
});
