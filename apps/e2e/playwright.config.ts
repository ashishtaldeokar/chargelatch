import { defineConfig, devices } from "@playwright/test";

if (!process.env.DATABASE_URL || !process.env.KEYCLOAK_URL || !process.env.KEYCLOAK_ISSUER || !process.env.MQTT_URL) {
  throw new Error("DATABASE_URL / KEYCLOAK_URL are not set. Run the suite with `pnpm test:e2e:browser` so containers are started first.");
}

// Off the default dev ports so the suite can run next to `pnpm dev`.
const apiPort = 3100;
const webPort = 5273;
// Registered as a redirect URI of the chargelatch-factory Keycloak client.
const factoryPort = 5274;
export const factoryUrl = `http://localhost:${factoryPort}`;

export default defineConfig({
  testDir: "./tests",
  // All tests share one database that is reset before each test.
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${webPort}`,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "pnpm --filter @chargelatch/api start",
      url: `http://localhost:${apiPort}/api/health`,
      env: { PORT: String(apiPort), DATABASE_URL: process.env.DATABASE_URL, KEYCLOAK_ISSUER: process.env.KEYCLOAK_ISSUER, MQTT_URL: process.env.MQTT_URL },
      reuseExistingServer: false,
    },
    {
      command: `pnpm --filter @chargelatch/admin-web exec vite --port ${webPort} --strictPort`,
      url: `http://localhost:${webPort}`,
      env: { API_URL: `http://localhost:${apiPort}`, VITE_KEYCLOAK_URL: process.env.KEYCLOAK_URL },
      reuseExistingServer: false,
    },
    {
      command: `pnpm --filter @chargelatch/factory exec vite --port ${factoryPort} --strictPort`,
      url: factoryUrl,
      env: { API_URL: `http://localhost:${apiPort}`, VITE_KEYCLOAK_URL: process.env.KEYCLOAK_URL },
      reuseExistingServer: false,
    },
  ],
});
