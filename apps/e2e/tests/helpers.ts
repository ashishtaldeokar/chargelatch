import type { Page } from "@playwright/test";

/** Signs in through Keycloak's real login page (rendered with the chargelatch theme). */
export async function signIn(page: Page, appUrl: string, username: string, password: string) {
  await page.goto(appUrl);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByLabel("Username or email").fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign In" }).click();
  await page.waitForURL(`${appUrl}/**`);
}
