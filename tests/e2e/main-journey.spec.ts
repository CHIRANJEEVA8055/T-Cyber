import { expect, test } from "@playwright/test";
import { openCase, signIn } from "./helpers";

test.describe("Main journey: partial bank response to updated case", () => {
  test("reviewing Bank B's partial response adds Account E, keeps the request open and proposes a follow-up without changing secured funds", async ({ page }) => {
    await signIn(page, "officer1");
    await openCase(page, "FIR 1/2026");

    const financial = page.locator("#financial");
    await expect(financial.getByText("₹18,00,000")).toBeVisible();
    await expect(financial.getByText("₹2,00,000")).toBeVisible();

    await page.locator("#next-actions").getByRole("link", { name: "Review response" }).first().click();
    await expect(page.getByRole("heading", { name: "Response from Demo Bank B" })).toBeVisible();

    const groups = page.getByRole("group", { name: /^Decision for:/ });
    const count = await groups.count();
    expect(count).toBe(5);
    for (let i = 0; i < count; i++) {
      await page.getByRole("group", { name: /^Decision for:/ }).nth(i).getByRole("button", { name: "Accept", exact: true }).click();
      await expect(page.getByText(`${i + 1} accepted,`)).toBeVisible();
    }

    await expect(page.getByLabel("Record this response as")).toHaveValue("PARTIAL");
    await page.getByRole("button", { name: "Apply reviewed results" }).click();
    const dialog = page.getByRole("dialog", { name: /Apply 5 accepted results/ });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("No change to held or returned amounts.")).toBeVisible();
    await dialog.getByRole("button", { name: "Apply results" }).click();

    await expect(page.getByText("5 results applied")).toBeVisible();
    await page.getByRole("link", { name: "Open the follow-up draft" }).click();
    await expect(page.getByText("Follow-up to R.REQ-412/2026-004")).toBeVisible();
    await expect(page.getByRole("heading", { name: /REQ-412\/2026-\d{3}/ }).first()).toBeVisible();

    // Persistence after reload and accepted results across views.
    await page.reload();
    await expect(page.getByText("Follow-up to R.REQ-412/2026-004")).toBeVisible();
    await page.getByRole("link", { name: "Overview", exact: true }).click();
    await expect(page.locator("#financial").getByText("₹18,00,000")).toBeVisible();
    await expect(page.locator("#next-actions").getByText("Request a debit freeze on Account E")).toBeVisible();

    await page.getByRole("link", { name: /^Requests/ }).click();
    await page.getByRole("link", { name: /^Partial response/ }).click();
    await expect(page).toHaveURL(/view=partial/);
    await expect(page.getByRole("cell", { name: "R.REQ-412/2026-004", exact: true })).toBeVisible();
    await expect(page.getByRole("row")).toHaveCount(2); // header + the one partial request
  });
});
