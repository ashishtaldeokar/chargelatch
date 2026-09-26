import { schema } from "@chargelatch/db";
import { startFakeDevice, type FakeDevice } from "../src/helpers/fake-device.ts";
import { expect, test } from "./fixtures.ts";
import { signIn } from "./helpers.ts";

// The whole chain for real. Commands: browser -> API (Keycloak token) -> EMQX -> device. Live data:
// device -> EMQX -> browser, over MQTT-over-WebSocket. Only the device is simulated
// (src/helpers/fake-device.ts).

const adminUrl = "http://localhost:5273";
let device: FakeDevice | undefined;

test.afterEach(async () => {
  await device?.stop();
  device = undefined;
});

test("an admin sees live meter readings and switches the contactor", async ({ page, db }) => {
  await db.insert(schema.devices).values({ macAddress: "24:6f:28:aa:bb:cc", chipType: "ESP32-D0WD-V3" });
  device = await startFakeDevice(process.env.MQTT_URL!, "SONIK-1");
  await device.publishMeter({ voltage: 230.5, current: 6.25, power: 1430.4, total_energy: 1234.756 });

  await signIn(page, adminUrl, "admin@chargelatch.dev", "admin");

  const card = page.getByRole("article", { name: "SONIK-1" });
  await expect(card.getByText("online", { exact: true })).toBeVisible();
  await expect(card.getByRole("definition").filter({ hasText: "1,430 W" })).toBeVisible();
  await expect(card.getByText("230.5 V")).toBeVisible();
  await expect(page.getByText("Live", { exact: true })).toBeVisible();

  // A new reading reaches the open page by itself, and extends the power chart.
  await device.publishMeter({ voltage: 229.8, current: 31.3, power: 7200, total_energy: 1234.9 });
  await expect(card.getByText("7,200 W", { exact: true }).first()).toBeVisible();
  const chart = card.getByRole("figure", { name: "Active power, last 10 minutes" });
  await expect(chart.locator("path.line, circle.point")).not.toHaveCount(0);
  await expect(chart.getByText("7,200 W")).toBeVisible();

  // Switch on: the UI shows "closed" only once the device has confirmed.
  const contactor = card.getByRole("switch", { name: "SONIK-1 contactor" });
  await expect(contactor).toHaveAttribute("aria-checked", "false");
  await contactor.click();
  await expect(card.getByTestId("relay-state")).toHaveText("Closed (on)");
  await expect(contactor).toHaveAttribute("aria-checked", "true");
  expect(device.relayOn()).toBe(true);

  await contactor.click();
  await expect(card.getByTestId("relay-state")).toHaveText("Open (off)");
  expect(device.relayOn()).toBe(false);
});

test("a device that drops off the network goes offline in the open page and cannot be switched", async ({ page, db }) => {
  await db.insert(schema.devices).values({ macAddress: "24:6f:28:aa:bb:cc", chipType: "ESP32-D0WD-V3" });
  device = await startFakeDevice(process.env.MQTT_URL!, "SONIK-1");

  await signIn(page, adminUrl, "admin@chargelatch.dev", "admin");
  const card = page.getByRole("article", { name: "SONIK-1" });
  await expect(card.getByText("online", { exact: true })).toBeVisible();

  device.dropOffNetwork(); // the broker publishes the device's last will
  await expect(card.getByText("offline", { exact: true })).toBeVisible();
  await expect(card.getByRole("switch")).toBeDisabled();
});

test("a hung device: the switch reports the timeout and stays where it was", async ({ page, db }) => {
  await db.insert(schema.devices).values({ macAddress: "24:6f:28:aa:bb:cc", chipType: "ESP32-D0WD-V3" });
  device = await startFakeDevice(process.env.MQTT_URL!, "SONIK-1");
  device.ignoreCommands();

  await signIn(page, adminUrl, "admin@chargelatch.dev", "admin");
  const card = page.getByRole("article", { name: "SONIK-1" });
  await card.getByRole("switch").click();

  await expect(card.getByRole("alert")).toContainText("did not confirm", { timeout: 15_000 });
  await expect(card.getByRole("switch")).toHaveAttribute("aria-checked", "false");
});

test("an admin registers a tenant and assigns a device to it from the portal", async ({ page, db }) => {
  await db.insert(schema.devices).values({ macAddress: "24:6f:28:aa:bb:cc", chipType: "ESP32-D0WD-V3" });
  await signIn(page, adminUrl, "admin@chargelatch.dev", "admin");

  await page.getByRole("button", { name: "Tenants" }).click();
  const form = page.getByRole("form", { name: "Add tenant" });
  await form.getByLabel("Id", { exact: true }).fill("sonik");
  await form.getByLabel("Name").fill("Sonik");
  await form.getByLabel("Keycloak client id").fill("chargelatch-partner-sonik");
  await form.getByLabel("Webhook URL").fill("https://sonik.example/hook");
  await form.getByRole("button", { name: "Add tenant" }).click();
  await expect(page.getByRole("row", { name: /sonik/ })).toBeVisible();

  await page.getByRole("button", { name: "Devices" }).click();
  const select = page.getByRole("combobox", { name: "SONIK-1 tenant" });
  await select.selectOption("sonik");
  await expect(select).toHaveValue("sonik");

  // Persisted: reload and it is still assigned, and the tenant exists in the database.
  await page.reload();
  await expect(page.getByRole("combobox", { name: "SONIK-1 tenant" })).toHaveValue("sonik");
  const [tenant] = await db.select().from(schema.tenants);
  expect(tenant).toMatchObject({ id: "sonik", keycloakClientId: "chargelatch-partner-sonik", webhookUrl: "https://sonik.example/hook" });
});

test("accounts without the admin role are turned away", async ({ page }) => {
  await signIn(page, adminUrl, "factory@chargelatch.dev", "factory");
  await expect(page.getByRole("alert")).toContainText("does not have the admin role");
  await expect(page.getByRole("switch")).toHaveCount(0);
});
