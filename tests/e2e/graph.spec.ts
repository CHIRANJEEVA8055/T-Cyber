import { expect, test } from "@playwright/test";
import { openCase, signIn } from "./helpers";

test.describe("Case graph", () => {
  test("shows the money trail with exact amounts, opens details from the keyboard and focuses a branch", async ({ page }) => {
    await signIn(page, "officer1");
    await openCase(page, "FIR 1/2026");
    await page.getByRole("link", { name: "Graph", exact: true }).click();
    await expect(page).toHaveURL(/\/graph$/);

    const canvas = page.locator(".react-flow");
    await expect(canvas.getByText("₹8,00,000")).toBeVisible();
    await expect(canvas.getByText("Held ₹2,00,000")).toBeVisible();

    // Keyboard: focus a record and open its details with Enter; Escape returns focus to it.
    const accountA = page.locator(".react-flow__node-record").filter({ hasText: "Account A" });
    await accountA.focus();
    await page.keyboard.press("Enter");
    const drawer = page.getByRole("dialog", { name: "Account A" });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByText("₹2,00,000", { exact: false }).first()).toBeVisible();
    await expect(drawer.getByText(/^Extracted from/)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(accountA).toBeFocused();

    // A connection opens its exact transfer, provenance and source document.
    await canvas.getByText("₹8,00,000").click();
    const transfer = page.getByRole("dialog", { name: "Transfer to Account D" });
    await expect(transfer).toBeVisible();
    await expect(transfer.getByRole("link", { name: /Demo Bank A response to R.REQ-412\/2026-002/ })).toBeVisible();
    await expect(transfer.getByRole("link", { name: /BankA_statement/ })).toBeVisible();
    await transfer.getByRole("button", { name: "Close" }).click();

    // Branch focus narrows the list to where the money came from and where it went.
    await accountA.click();
    await page.getByRole("dialog", { name: "Account A" }).getByRole("button", { name: "Focus on this branch" }).click();
    await expect(page).toHaveURL(/focus=/);
    await page.getByRole("button", { name: "List", exact: true }).click();
    const table = page.getByRole("table", { name: "Transfers in this view" });
    await expect(table.getByRole("row")).toHaveCount(3); // header + victim to A + A to D
    await page.getByRole("button", { name: "Clear focus on Account A" }).click();
    await expect(table.getByRole("row")).toHaveCount(5);

    // Discovery explains which response revealed each later record.
    await page.getByRole("button", { name: "Discovery", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Phase 1" })).toBeVisible();
    await expect(page.getByText("Transfer recipient of Account A, from the Demo Bank A response to R.REQ-412/2026-002")).toBeVisible();

    // Marking the graph as reviewed starts "new since review" tracking.
    await page.getByRole("button", { name: "Mark as reviewed" }).click();
    await expect(page.getByText("Graph marked as reviewed")).toBeVisible();
    await expect(page.getByLabel("Only new since my last review (0)")).toBeVisible();
  });
});
