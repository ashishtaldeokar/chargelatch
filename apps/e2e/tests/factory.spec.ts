import { schema } from "@chargelatch/db";
import { factoryUrl } from "../playwright.config.ts";
import { expect, test } from "./fixtures.ts";
import { signIn as signInTo } from "./helpers.ts";

const signIn = (page: Parameters<typeof signInTo>[0], username: string, password: string) => signInTo(page, factoryUrl, username, password);

// Flashing itself needs a chip on a serial port, so it is covered by the factory app's unit
// tests against a fake connection. Here: the real Keycloak login, role gating, and the API.

test("a factory operator signs in through keycloak and sees registered devices", async ({ page, db }) => {
  await db.insert(schema.devices).values({ macAddress: "24:6f:28:aa:bb:cc", chipType: "ESP32-D0WD-V3" });

  await signIn(page, "factory@chargelatch.dev", "factory");

  await expect(page.getByText("factory@chargelatch.dev")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Recent devices" })).toBeVisible();
  // Loaded from the API with the operator's bearer token.
  await expect(page.getByRole("cell", { name: "SONIK-1" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "24:6f:28:aa:bb:cc" })).toBeVisible();
});

test("a user without the factory role cannot use the station", async ({ page }) => {
  await signIn(page, "user@chargelatch.dev", "user");

  await expect(page.getByRole("alert")).toContainText("does not have the factory role");
  await expect(page.getByRole("button", { name: /flash/i })).toHaveCount(0);
});

test("signed-out visitors only get the sign-in prompt", async ({ page }) => {
  await page.goto(factoryUrl);
  await expect(page.getByRole("heading", { name: "Sign in to flash devices" })).toBeVisible();
});
