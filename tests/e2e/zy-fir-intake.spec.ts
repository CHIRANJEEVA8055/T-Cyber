import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";
import { fir412Pdf } from "../../src/server/seed/documents";
import { demoAnchor, makeTimeline } from "../../src/server/seed/timeline";

const fir1Pdf = () => fir412Pdf(makeTimeline(demoAnchor()));

// Runs late (zy-): it adds a case, which would change counts other specs check.
test("an officer reads the FIR, creates the case, confirms what was read, and the requests are drafted for review", async ({ page }) => {
  await signIn(page, "officer1");
  await page.goto("/cases/new");

  const fir = fir1Pdf();
  await page.getByLabel(/^FIR copy/).setInputFiles({ name: fir.fileName, mimeType: "application/pdf", buffer: fir.buffer });
  await page.getByRole("button", { name: "Read FIR and fill the form" }).click();
  await expect(page.getByText(`Filled 8 details from ${fir.fileName}`)).toBeVisible();
  await expect(page.getByLabel(/^FIR number/)).toHaveValue("1");
  await expect(page.getByLabel(/^Incident from/)).toHaveValue("2026-10-03T11:42");
  await expect(page.getByText("Found in the FIR")).toBeVisible();
  await expect(page.getByText("+91-XXXXXX4512", { exact: true })).toBeVisible();

  // FIR 1/2026 and its complaint reference already exist in the demonstration data.
  await page.getByLabel(/^FIR number/).fill("90");
  await page.getByLabel(/^Complaint or NCRP reference/).fill("");
  await page.getByLabel(/^Case title/).fill("Investment fraud through a fake trading group (intake)");
  await page.getByRole("button", { name: "Create FIR workspace" }).click();
  await expect(page).toHaveURL(/\/review$/);

  await page.getByRole("button", { name: /^Confirm \d+ items read clearly$/ }).click();
  await expect(page.getByText(/items confirmed as read correctly; 1 left to review/)).toBeVisible();
  await expect(page.getByLabel(/^Payments were made from/)).toContainText("The complainant’s own account in this document (XXXXXXXX3390)");
  await page.getByRole("button", { name: "Apply reviewed items" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Apply items" }).click();
  await expect(page.getByText("Reviewed items added to the case. 8 requests drafted for your review; nothing was sent")).toBeVisible();

  await page.getByRole("link", { name: "Requests & inbox" }).click();
  await page.getByRole("link", { name: /^Drafts/ }).click();
  for (const recipient of ["Demo Bank A", "Demo Bank B", "Demo Bank C", "Zonal ACP Office (demo)", "Demo Mail Provider"]) {
    await expect(page.getByText(recipient, { exact: false }).locator("visible=true").first()).toBeVisible();
  }
});
