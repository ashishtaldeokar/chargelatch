import { createDb, requireDatabaseUrl } from "@chargelatch/db";
import { createApp } from "./app.ts";
import { createKeycloakVerifier } from "./auth.ts";
import { MqttDeviceBus } from "./device-bus.ts";
import { createDeviceStore } from "./devices.ts";
import { createUserStore } from "./users.ts";

const { db } = createDb(requireDatabaseUrl());

const issuer = process.env.KEYCLOAK_ISSUER;
if (!issuer) throw new Error("KEYCLOAK_ISSUER is not set");

const mqttUrl = process.env.MQTT_URL;
if (!mqttUrl) throw new Error("MQTT_URL is not set");

const app = createApp({
  users: createUserStore(db),
  devices: createDeviceStore(db),
  // Connects in the background and keeps retrying; relay commands answer 503 until it is up.
  bus: new MqttDeviceBus({ url: mqttUrl }),
  auth: createKeycloakVerifier(issuer, process.env.KEYCLOAK_AUDIENCE ?? "chargelatch-api"),
});

const port = Number(process.env.PORT ?? 3000);
console.log(`api listening on http://localhost:${port}`);

// idleTimeout 0: the device event stream is a long-lived response (Bun closes idle ones after 10 s).
export default { port, fetch: app.fetch, idleTimeout: 0 };
