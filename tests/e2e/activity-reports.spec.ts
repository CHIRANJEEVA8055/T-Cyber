import { expect, test } from "@playwright/test";
import { openCase, signIn, signOut } from "./helpers";

test.describe("Activity and reports", () => {
  test("records a correction without changing history, then drafts, edits, reviews and exports a case summary", async ({ page }) => {
    await signIn(page, "officer1");
    await openCase(page, "FIR 1/2026");
    await page.getByRole("link", { name: "Activity & audit" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Activity" })).toBeVisible();

    // A correction is a new entry; the original stays exactly as recorded.
    const officerEntries = page.locator("li[id^=entry-]").filter({ hasText: "SI S. Meera" });
    const original = officerEntries.first();
    const originalId = await original.getAttribute("id");
    const originalSummary = await original.locator("p").first().innerText();
    await original.getByRole("button", { name: "Record a correction" }).click();
    const dialog = page.getByRole("dialog", { name: "Record a correction" });
    await dialog.getByRole("button", { name: "Record correction" }).click();
    await expect(dialog.getByText("Describe the correction in at least 10 characters.")).toBeVisible();
    await dialog.getByLabel("Correction").fill("The step was recorded against the wrong request; it concerns R.REQ-412/2026-004.");
    await dialog.getByRole("button", { name: "Record correction" }).click();
    await expect(page.getByText("Correction recorded")).toBeVisible();
    await expect(page.locator(`li#${originalId}`)).toContainText(originalSummary);
    await expect(page.locator(`li#${originalId}`)).toContainText("Corrected by SI S. Meera");
    await expect(page.getByText(/^Correction to the entry of .*R.REQ-412\/2026-004\.$/)).toBeVisible();

    // Draft a case summary from the records.
    await page.getByRole("navigation", { name: "Activity and reports sections" }).getByRole("link", { name: "Reports" }).click();
    await page.getByRole("button", { name: "Draft case summary" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Case summary: FIR 1/2026" })).toBeVisible();
    const article = page.locator("article");
    await expect(article.getByText(/neither returned nor secured ₹18,00,000/)).toBeVisible();
    await expect(article.getByRole("link", { name: "Source S1", exact: true })).toBeVisible();
    const reportUrl = page.url();

    // An edit is saved as version 2; review applies to that exact version.
    await page.getByRole("button", { name: "Edit report" }).click();
    const text = page.getByLabel("Report text");
    await text.fill(`${await text.inputValue()}\n- Officer note: Demo Bank B was called on 21 Oct 2026.`);
    await page.getByLabel("What changed").fill("Added the call to Demo Bank B");
    await page.getByRole("button", { name: "Save as version 2" }).click();
    await expect(page.getByText("Saved as version 2")).toBeVisible();
    await expect(article.getByText("Officer note: Demo Bank B was called on 21 Oct 2026.")).toBeVisible();
    await page.getByRole("button", { name: "Mark version 2 as reviewed" }).click();
    await page.getByRole("dialog", { name: /Mark version 2 of the case summary as reviewed/ }).getByRole("button", { name: "Mark as reviewed" }).click();
    await expect(page.getByText("Version 2 marked as reviewed")).toBeVisible();
    await expect(page.getByRole("button", { name: /Mark version 2 as reviewed/ })).toHaveCount(0);

    // Version 1 is kept unchanged and can be exported.
    await page.getByRole("link", { name: /^Version 1/ }).click();
    await expect(page.getByText("You are viewing version 1")).toBeVisible();
    await expect(article.getByText("Officer note: Demo Bank B was called on 21 Oct 2026.")).toHaveCount(0);
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Download PDF" }).click()]);
    expect(download.suggestedFilename()).toBe("FIR-1-2026-case-summary-v1.pdf");

    // Handover shows what is pending.
    await page.getByRole("navigation", { name: "Activity and reports sections" }).getByRole("link", { name: "Handover" }).click();
    await expect(page.getByRole("heading", { name: /^Pending requests \(\d+\)$/ })).toBeVisible();
    await expect(page.getByRole("heading", { name: /^Unresolved leads \(\d+\)$/ })).toBeVisible();

    // An officer who is not assigned to the case can neither open nor export the report.
    await signOut(page);
    await signIn(page, "officer2");
    await page.goto(reportUrl);
    await expect(page.getByRole("heading", { name: "This case does not exist or you do not have access to it" })).toBeVisible();
    const reportId = new URL(reportUrl).pathname.split("/").at(-1);
    const res = await page.request.get(`/api/reports/${reportId}/pdf?version=1`);
    expect(res.status()).toBe(404);
  });
});
