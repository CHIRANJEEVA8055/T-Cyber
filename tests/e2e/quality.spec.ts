import { expect, test, type Page } from "@playwright/test";
import { openCase, signIn, signOut } from "./helpers";

/** A real 1×1 PNG, so the upload passes the file-signature check and reaches the "not read" path honestly. */
const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

async function caseBase(page: Page, reference: string) {
  await openCase(page, reference);
  return new URL(page.url()).pathname;
}

async function openRequest(page: Page, reference: string) {
  await page.goto(`/search?q=${encodeURIComponent(reference)}`);
  await page.getByRole("link", { name: reference, exact: true }).click();
  // The case reference is the page's level-1 heading; the request is the level-2 heading under it.
  await expect(page.getByRole("heading", { name: reference, exact: true })).toBeVisible();
}

test.describe("Quality gates", () => {
  test("every request the app makes stays on this application", async ({ page }) => {
    const external: string[] = [];
    page.on("request", (r) => {
      const url = new URL(r.url());
      if (url.protocol === "data:" || url.protocol === "blob:") return;
      if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") external.push(r.url());
    });
    await signIn(page, "officer1");
    const base = await caseBase(page, "FIR 1/2026");
    for (const p of ["", "/investigation", "/investigation/identifiers", "/funds", "/requests", "/evidence", "/graph", "/activity", "/activity/handover", "/assistant"]) {
      await page.goto(`${base}${p}`);
      await page.waitForLoadState("networkidle");
    }
    await page.getByRole("button", { name: "What is still missing?" }).click();
    await expect(page.getByRole("heading", { name: "“What is still missing?”" })).toBeVisible();
    for (const p of ["/correspondence", "/work-queue", "/guidance", "/settings", "/search?q=Account"]) {
      await page.goto(p);
      await page.waitForLoadState("networkidle");
    }
    expect(external).toEqual([]);
  });

  test("no main screen scrolls sideways on a 390 px phone", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page, "officer1");
    const base = await caseBase(page, "FIR 1/2026");
    const paths = ["/cases", "/cases/new", base, `${base}/investigation`, `${base}/investigation/people`, `${base}/investigation/identifiers`, `${base}/funds`, `${base}/funds/holds`, `${base}/funds/returns`, `${base}/requests`, `${base}/evidence`, `${base}/graph`, `${base}/activity`, `${base}/activity/reports`, `${base}/activity/handover`, `${base}/assistant`, "/correspondence", "/correspondence/import", "/work-queue", "/guidance", "/settings", "/settings/directory", "/settings/routes", "/search?q=0937"];
    for (const p of paths) {
      await page.goto(p);
      await page.waitForLoadState("networkidle");
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `horizontal overflow on ${p}`).toBeLessThanOrEqual(0);
    }
  });

  test("dialogs work from the keyboard: focus moves in and stays in, Escape closes, focus returns", async ({ page }) => {
    await signIn(page, "officer1");
    const base = await caseBase(page, "FIR 1/2026");
    await page.goto(`${base}/activity`);
    const trigger = page.getByRole("button", { name: "Record a correction" }).first();
    await trigger.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Record a correction" });
    await expect(dialog).toBeVisible();
    expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
    for (let i = 0; i < 8; i++) await page.keyboard.press("Tab");
    expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test("an edit after approval withdraws the approval", async ({ page }) => {
    await signIn(page, "officer1");
    await openRequest(page, "R.REQ-412/2026-008");
    await page.getByRole("button", { name: "Request approval" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Request approval" }).click();
    await expect(page.getByText(/Waiting for approval of version \d+/)).toBeVisible();
    const url = page.url();

    await signOut(page);
    await signIn(page, "supervisor");
    await page.goto(url);
    await page.getByRole("button", { name: /^Approve version \d+$/ }).click();
    await page.getByRole("dialog").getByRole("button", { name: /^Approve version \d+$/ }).click();
    await expect(page.getByRole("button", { name: "Submit request" })).toBeVisible();

    await signOut(page);
    await signIn(page, "officer1");
    await page.goto(url);
    await expect(page.getByRole("button", { name: "Submit request" })).toBeVisible();
    const subject = page.getByLabel("Subject");
    await subject.fill(`${await subject.inputValue()} (period corrected)`);
    await expect(page.getByText("Saving creates a new version and withdraws the current approval or approval request.")).toBeVisible();
    await page.getByRole("button", { name: "Save as new version" }).click();
    await expect(page.getByRole("button", { name: "Request approval" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Submit request" })).toHaveCount(0);
  });

  test("unsaved edits are protected when leaving the page", async ({ page }) => {
    await signIn(page, "officer1");
    await openRequest(page, "H.REQ-405/2026-001");
    const url = page.url();
    const subject = page.getByLabel("Subject");
    await subject.fill(`${await subject.inputValue()} (draft change)`);
    await page.getByRole("link", { name: "All cases" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Leave without saving your changes?" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(page).toHaveURL(url);
    await expect(subject).toHaveValue(/\(draft change\)$/);
    await page.getByRole("button", { name: "Discard changes" }).click();
    await expect(subject).not.toHaveValue(/\(draft change\)$/);
  });

  test("an incomplete FIR form says what to fix instead of submitting", async ({ page }) => {
    await signIn(page, "officer1");
    await page.goto("/cases/new");
    await page.getByRole("button", { name: "Create FIR workspace" }).click();
    await expect(page.locator("[aria-invalid='true']").first()).toBeVisible();
    await expect(page).toHaveURL(/\/cases\/new$/);
  });

  test("an image is stored as evidence but not read, and the page says so", async ({ page }) => {
    await signIn(page, "officer1");
    const base = await caseBase(page, "FIR 1/2026");
    await page.goto(`${base}/evidence`);
    await page.getByRole("button", { name: "Upload document" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Upload a document" });
    await dialog.getByLabel("File").setInputFiles({ name: "chat-screenshot.png", mimeType: "image/png", buffer: PNG_1X1 });
    await dialog.getByLabel("Kind of document").selectOption({ label: "Screenshot" });
    await dialog.getByLabel(/^Source\*?$/).fill("Shared by the complainant on WhatsApp (synthetic)");
    await dialog.getByRole("button", { name: "Upload document" }).click();
    await expect(page).toHaveURL(/\/evidence\/[^/?]+$/);
    await expect(page.getByText(/Text recognition \(OCR\) is not available in this build, so nothing was extracted/).first()).toBeVisible();
  });

  test("importing the same response twice does not create a second copy", async ({ page }) => {
    await signIn(page, "officer1");
    const fill = async () => {
      await page.goto("/correspondence/import");
      await page.getByLabel(/^Case\*?$/).selectOption({ label: "FIR 1/2026: Investment fraud through a fake trading group" });
      await page.getByLabel(/^From\*?$/).fill("nodal@bank-c.example.invalid");
      await page.getByLabel("Received at (IST)").fill("2026-10-28T11:15");
      await page.getByLabel(/^Subject\*?$/).fill("Reg: account statement");
      await page.getByLabel("Message text").fill("Dear Sir, the statement for the account will be shared shortly. Regards, LEA Desk (synthetic demonstration message).");
      await page.getByRole("button", { name: "Import response" }).click();
    };
    await fill();
    await expect(page).toHaveURL(/\/responses\/[^/]+$/);
    await fill();
    await expect(page.getByText("This message was already imported")).toBeVisible();
  });

  test("a source link opens the document at the cited row", async ({ page }) => {
    await signIn(page, "officer1");
    const base = await caseBase(page, "FIR 1/2026");
    await page.goto(`${base}/graph`);
    await page.locator(".react-flow").getByText("₹8,00,000").click();
    await page.getByRole("dialog", { name: "Transfer to Account D" }).getByRole("link", { name: /BankA_statement_XXXX4821\.csv, row 3/ }).click();
    await expect(page).toHaveURL(/\/evidence\/[^?]+\?row=3$/);
    const cited = page.getByRole("row").filter({ has: page.getByText("(cited row)") });
    await expect(cited).toHaveCount(1);
    await expect(cited).toContainText("8,00,000.00");
  });
});
