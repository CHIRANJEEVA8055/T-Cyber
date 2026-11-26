import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

const file = path.resolve(import.meta.dirname, "../../config/t-cyber.config.json");

test("station details and recipient addresses follow the configuration file without a restart", async ({ page }) => {
  const original = fs.readFileSync(file, "utf8");
  try {
    await signIn(page, "officer1");
    await expect(page.getByRole("banner")).toContainText("Cyber Crime Police Station (Demo)");

    const cfg = JSON.parse(original);
    cfg.station.name = "Cyber Crime PS, Example Zone (Demo)";
    const bankD = cfg.directory.find((d: { key: string }) => d.key === "bank-d");
    bankD.address = "lea.cell@bank-d.example.invalid";
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2));

    await page.reload();
    await expect(page.getByRole("banner")).toContainText("Cyber Crime PS, Example Zone (Demo)");

    // The directory shows the new address and asks for re-verification before anything is sent to it.
    // (Checked in Settings, which always reflects the file, rather than on a request whose status other tests change.)
    await page.goto("/settings/directory");
    const bankDRow = page.getByRole("row").filter({ hasText: "Demo Bank D" });
    await expect(bankDRow).toContainText("lea.cell@bank-d.example.invalid");
    await expect(bankDRow).toContainText("Unverified");
    await expect(bankDRow).toContainText("Address changed in the configuration file");
  } finally {
    fs.writeFileSync(file, original);
  }
});
