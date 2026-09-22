import { createDb, requireDatabaseUrl } from "@chargelatch/db";
import { DEVICE_STATE_TOPICS } from "@chargelatch/device-protocol";
import mqtt from "mqtt";
import { Ingester } from "./ingest.ts";
import { DeviceRegistry } from "./registry.ts";
import { BatchWriter } from "./writer.ts";

// No top-level await in this file: PM2's Bun wrapper loads the entrypoint with require(), which
// cannot load an async module ("require() async module ... is unsupported").
async function main() {
  const mqttUrl = process.env.MQTT_URL;
  if (!mqttUrl) throw new Error("MQTT_URL is not set");

  const { db, close: closeDb } = createDb(requireDatabaseUrl());
  const registry = new DeviceRegistry(db);
  await registry.start();
  console.log(`telemetry: ${registry.size} registered devices`);

  const ingester = new Ingester((identity) => registry.resolve(identity));
  const writer = new BatchWriter(db);

  let received = 0;
  let stored = 0;
  const client = mqtt.connect(mqttUrl, {
    clientId: `chargelatch-telemetry-${crypto.randomUUID().slice(0, 8)}`,
    // A persistent session: the broker queues QoS 1 messages published while this service is down
    // (status/relay events are QoS 1; meter readings are QoS 0 by the firmware and are not).
    clean: false,
    reconnectPeriod: 2000,
  });
  client.on("connect", () => {
    console.log(`telemetry: connected to ${mqttUrl}`);
    client.subscribe(DEVICE_STATE_TOPICS, { qos: 1 });
  });
  client.on("error", (error) => console.error(`mqtt: ${error.message}`));
  client.on("message", (topic, payload) => {
    received++;
    const result = ingester.ingest(topic, payload.toString(), new Date());
    if (!result) return;
    stored++;
    if ("reading" in result) writer.addReading(result.reading);
    else writer.addEvent(result.event);
  });

  setInterval(() => console.log(`telemetry: ${received} messages received, ${stored} rows stored, ${writer.pending} pending`), 60_000);

  let stopping = false;
  async function shutdown(signal: string) {
    if (stopping) return;
    stopping = true;
    console.log(`${signal} received, shutting down`);
    registry.stop();
    await client.endAsync();
    await writer.flush();
    await closeDb();
    process.exit(0);
  }
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error: Error) => {
  console.error(`telemetry failed to start: ${error.message}`);
  process.exit(1);
});
