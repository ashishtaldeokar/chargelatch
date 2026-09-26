import { createDb, requireDatabaseUrl } from "@chargelatch/db";
import { createApp } from "./app.ts";
import { createKeycloakVerifier } from "./auth.ts";
import { MqttDeviceBus } from "./device-bus.ts";
import { createDeviceStore } from "./devices.ts";
import { createTelemetryStore } from "./telemetry.ts";
import { createTenantStore } from "./tenants.ts";
import { createTransactionStore } from "./transactions.ts";
import { createUserStore } from "./users.ts";

const { db, close: closeDb } = createDb(requireDatabaseUrl());

const issuer = process.env.KEYCLOAK_ISSUER;
if (!issuer) throw new Error("KEYCLOAK_ISSUER is not set");

const mqttUrl = process.env.MQTT_URL;
if (!mqttUrl) throw new Error("MQTT_URL is not set");

// Connects in the background and keeps retrying; relay commands answer 503 until it is up.
const bus = new MqttDeviceBus({ url: mqttUrl });

const app = createApp({
  users: createUserStore(db),
  devices: createDeviceStore(db),
  bus,
  telemetry: createTelemetryStore(db),
  tenants: createTenantStore(db),
  transactions: createTransactionStore(db),
  tokenUrl: `${issuer}/protocol/openid-connect/token`,
  auth: createKeycloakVerifier(issuer, process.env.KEYCLOAK_AUDIENCE ?? "chargelatch-api"),
});

const server = Bun.serve({ port: Number(process.env.PORT ?? 3000), fetch: app.fetch });
console.log(`api listening on ${server.url}`);

// Graceful shutdown for `pm2 reload` / SIGTERM: stop accepting connections, let requests that are
// in flight finish (a relay command waits up to 5 s for its device), then release the broker and
// the database. PM2 sends SIGINT and force-kills after `kill_timeout` (ecosystem.config.cjs).
let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal} received, shutting down`);
  await server.stop();
  await Promise.allSettled([bus.close(), closeDb()]);
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
