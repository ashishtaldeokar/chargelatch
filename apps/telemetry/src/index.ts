import { createDb, requireDatabaseUrl } from "@chargelatch/db";
import { DEVICE_STATE_TOPICS, transactionCommandTopic } from "@chargelatch/device-protocol";
import mqtt from "mqtt";
import { Ingester } from "./ingest.ts";
import { DeviceRegistry } from "./registry.ts";
import { TransactionProcessor } from "./transactions.ts";
import { WebhookDispatcher } from "./webhooks.ts";
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

  // Transaction ids are looked up through a small cache so every meter reading does not cost a query.
  const txRowIds = new Map<string, string>();
  const ingester = new Ingester(
    (identity) => registry.resolve(identity),
    (deviceId, txId) => txRowIds.get(`${deviceId}:${txId}`),
  );
  const writer = new BatchWriter(db);
  const processor = new TransactionProcessor(db, async (identity, command) => {
    const id = crypto.randomUUID();
    await client.publishAsync(transactionCommandTopic(identity), JSON.stringify({ op: command.op, txId: command.txId, id, ...(command.intervalSeconds && { interval: command.intervalSeconds }) }), { qos: 1 });
  });
  const dispatcher = new WebhookDispatcher(db);

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
  // Transaction handling is serialised per device: acks and ends must be applied in order.
  const chains = new Map<string, Promise<void>>();
  const serial = (identity: string, work: () => Promise<void>) => {
    const next = (chains.get(identity) ?? Promise.resolve()).then(work).catch((e: Error) => console.error(`transaction handling failed for ${identity}: ${e.message}`));
    chains.set(identity, next);
  };

  client.on("message", (topic, payload) => {
    received++;
    const now = new Date();
    const result = ingester.ingest(topic, payload.toString(), now);
    if (!result) return;
    stored++;
    const identity = topic.split("/")[1]!;
    const deviceId = registry.resolve(identity)!;
    if ("reading" in result) writer.addReading(result.reading);
    else if ("event" in result) writer.addEvent(result.event);
    else if ("transaction" in result) {
      const tx = result.transaction;
      serial(identity, async () => {
        await processor.onState(deviceId, identity, tx);
        if (tx.active && tx.txId) {
          const row = await processor.find(deviceId, tx.txId);
          if (row) txRowIds.set(`${deviceId}:${tx.txId}`, row.id);
        }
      });
    } else if ("transactionEnd" in result) {
      const end = result.transactionEnd;
      serial(identity, () => processor.onEnd(deviceId, identity, end));
    } else if ("meterValue" in result) {
      const value = result.meterValue;
      serial(identity, () => processor.onMeterValue(deviceId, identity, value, now));
    }
  });

  dispatcher.start();
  const sweeper = setInterval(() => void processor.sweepStartTimeouts().catch((e: Error) => console.error(`sweep failed: ${e.message}`)), 15_000);

  setInterval(() => console.log(`telemetry: ${received} messages received, ${stored} rows stored, ${writer.pending} pending`), 60_000);

  let stopping = false;
  async function shutdown(signal: string) {
    if (stopping) return;
    stopping = true;
    console.log(`${signal} received, shutting down`);
    registry.stop();
    dispatcher.stop();
    clearInterval(sweeper);
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
