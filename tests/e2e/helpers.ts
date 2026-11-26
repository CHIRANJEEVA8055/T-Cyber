import { expect, type Page } from "@playwright/test";

export async function signIn(page: Page, username: "officer1" | "officer2" | "supervisor") {
  await page.goto("/login");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill("tcyber-demo");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/cases$/);
}

export async function signOut(page: Page) {
  await page.getByRole("button", { name: /Account menu/ }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);
}

export async function openCase(page: Page, reference: string) {
  await page.goto("/cases");
  await page.getByRole("link", { name: new RegExp(`^${reference.replace("/", "\\/")}`) }).first().click();
  // The case is named in the case sidebar (wide screens) or the case header (narrow); the page title is the section.
  await expect(page.getByText(reference, { exact: true }).locator("visible=true").first()).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Case overview" })).toBeVisible();
}
