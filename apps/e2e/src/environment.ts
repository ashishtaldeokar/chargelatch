import { runMigrations } from "@chargelatch/db/migrate";
import { seed } from "@chargelatch/db/seed";
import { startEmqx } from "./helpers/emqx.ts";
import { REALM, startKeycloak } from "./helpers/keycloak.ts";
import { startPostgres } from "./helpers/postgres.ts";

export interface Environment {
  /** Env vars handed to the API, the web servers and the Playwright tests. */
  env: Record<string, string>;
  stop(): Promise<void>;
}

/**
 * Backing services for the browser suite, using the same helpers as the `bun test` smoke tests.
 * Add startRedis() here once an app depends on it.
 */
export async function startEnvironment(): Promise<Environment> {
  const [postgres, keycloak, emqx] = await Promise.all([startPostgres(), startKeycloak(), startEmqx()]);
  const databaseUrl = postgres.url();

  await runMigrations(databaseUrl);
  await seed(databaseUrl, "e2e");

  return {
    env: {
      DATABASE_URL: databaseUrl,
      KEYCLOAK_URL: keycloak.baseUrl,
      KEYCLOAK_ISSUER: `${keycloak.baseUrl}/realms/${REALM}`,
      MQTT_URL: emqx.mqttUrl,
    },
    stop: async () => {
      await Promise.all([postgres.stop(), keycloak.stop(), emqx.stop()]);
    },
  };
}
