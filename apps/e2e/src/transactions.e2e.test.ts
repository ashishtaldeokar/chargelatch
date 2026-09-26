// Charging transactions end to end: partner API (real Keycloak service-account token) -> MQTT
// -> simulated device -> telemetry processor (real Postgres) -> webhook receiver, in the order
// and with the summaries a tenant would see. The API, processor and dispatcher run in-process,
// wired exactly like their services; only the device is simulated.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createApp } from "@chargelatch/api";
import { createKeycloakVerifier } from "@chargelatch/api/auth";
import { MqttDeviceBus } from "@chargelatch/api/device-bus";
import { createDeviceStore } from "@chargelatch/api/devices";
import { createTelemetryStore } from "@chargelatch/api/telemetry";
import { createTenantStore } from "@chargelatch/api/tenants";
import { createTransactionStore } from "@chargelatch/api/transactions";
import { createUserStore } from "@chargelatch/api/users";
import { createDb, schema } from "@chargelatch/db";
import { runMigrations } from "@chargelatch/db/migrate";
import { DEVICE_STATE_TOPICS, transactionCommandTopic } from "@chargelatch/device-protocol";
import { Ingester } from "@chargelatch/telemetry";
import { TransactionProcessor } from "@chargelatch/telemetry/transactions";
import { WebhookDispatcher, type WebhookEvent } from "@chargelatch/telemetry/webhooks";
import { BatchWriter } from "@chargelatch/telemetry/writer";
import { eq } from "drizzle-orm";
import mqtt, { type MqttClient } from "mqtt";
import { startEmqx, type StartedEmqx } from "./helpers/emqx.ts";
import { startFakeDevice, type FakeDevice } from "./helpers/fake-device.ts";
import { FIXTURE_USERS, getAccessToken, getServiceAccountToken, REALM, startKeycloak, type StartedKeycloak } from "./helpers/keycloak.ts";
import { startPostgres, type StartedPostgres } from "./helpers/postgres.ts";

const SONIK_CLIENT = { id: "chargelatch-partner-sonik", secret: "dev-sonik-secret" };

let postgres: StartedPostgres;
let keycloak: StartedKeycloak;
let emqx: StartedEmqx;
let db: ReturnType<typeof createDb>["db"];
let closeDb: () => Promise<void>;
let bus: MqttDeviceBus;
let app: ReturnType<typeof createApp>;
let subscriber: MqttClient;
let dispatcher: WebhookDispatcher;
let processor: TransactionProcessor;
let receiver: ReturnType<typeof Bun.serve>;
let partnerToken: string;
let adminToken: string;
let device: FakeDevice | undefined;
let deviceId: number;

/** Everything the "tenant" received, in delivery order. */
const received: WebhookEvent[] = [];
let receiverStatus = 200;

const partner = () => ({ authorization: `Bearer ${partnerToken}`, "content-type": "application/json" });
const admin = () => ({ authorization: `Bearer ${adminToken}`, "content-type": "application/json" });
const start = (txId: string, body: object = {}) => app.request("/api/partner/devices/SONIK-1/transactions", { method: "POST", headers: partner(), body: JSON.stringify({ transactionId: txId, ...body }) });
const stop = (txId: string) => app.request(`/api/partner/transactions/${txId}/stop`, { method: "POST", headers: partner() });
const get = async (txId: string) => (await (await app.request(`/api/partner/transactions/${txId}`, { headers: partner() })).json()) as { state: string; stopReason: string | null; summary: Record<string, unknown> | null };

async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const value = await read();
    if (done(value)) return value;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}
/** Runs the dispatcher until the tenant has received `count` events. */
async function deliveredEvents(count: number): Promise<WebhookEvent[]> {
  return eventually(
    async () => {
      await dispatcher.runOnce();
      return received;
    },
    (events) => events.length >= count,
    `${count} webhook events (have ${received.length}: ${received.map((e) => `${e.eventType}:${e.transactionId}`).join(", ")})`,
  );
}

beforeAll(async () => {
  [postgres, keycloak, emqx] = await Promise.all([startPostgres(), startKeycloak(), startEmqx()]);
  await runMigrations(postgres.url());
  ({ db, close: closeDb } = createDb(postgres.url()));

  // The tenant receives webhooks here (plain host-to-host: no container involved).
  receiver = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      received.push((await req.json()) as WebhookEvent);
      return new Response(null, { status: receiverStatus });
    },
  });
  await db.insert(schema.tenants).values({ id: "sonik", name: "Sonik", keycloakClientId: SONIK_CLIENT.id, webhookUrl: `http://127.0.0.1:${receiver.port}/hook` });

  bus = new MqttDeviceBus({ url: emqx.mqttUrl, commandTimeoutMs: 2000 });
  await bus.ready();
  app = createApp({
    users: createUserStore(db),
    devices: createDeviceStore(db),
    bus,
    telemetry: createTelemetryStore(db),
    tenants: createTenantStore(db),
    transactions: createTransactionStore(db),
    auth: createKeycloakVerifier(`${keycloak.baseUrl}/realms/${REALM}`, "chargelatch-api"),
  });
  partnerToken = await getServiceAccountToken(keycloak.baseUrl, SONIK_CLIENT);
  adminToken = await getAccessToken(keycloak.baseUrl, FIXTURE_USERS.admin);

  // Register SONIK-1 and hand it to the tenant.
  const factoryToken = await getAccessToken(keycloak.baseUrl, FIXTURE_USERS.factory);
  const registered = (await (
    await app.request("/api/factory/devices", { method: "POST", headers: { authorization: `Bearer ${factoryToken}`, "content-type": "application/json" }, body: JSON.stringify({ macAddress: "24:6f:28:aa:bb:01", chipType: "ESP32" }) })
  ).json()) as { id: number };
  deviceId = registered.id;
  await app.request("/api/admin/devices/SONIK-1/tenant", { method: "PUT", headers: admin(), body: JSON.stringify({ tenantId: "sonik" }) });

  // The telemetry service's core, wired like apps/telemetry/src/index.ts.
  subscriber = await mqtt.connectAsync(emqx.mqttUrl, { clientId: "telemetry-tx-e2e" });
  processor = new TransactionProcessor(
    db,
    async (identity, command) => {
      await subscriber.publishAsync(transactionCommandTopic(identity), JSON.stringify({ ...command, id: crypto.randomUUID() }), { qos: 1 });
    },
    () => {},
  );
  dispatcher = new WebhookDispatcher(db, { log: () => {} });
  const txRowIds = new Map<string, string>();
  const ingester = new Ingester(() => deviceId, (id, txId) => txRowIds.get(`${id}:${txId}`));
  const writer = new BatchWriter(db, { maxDelayMs: 100 });
  let chain = Promise.resolve();
  subscriber.on("message", (topic, payload) => {
    const now = new Date();
    const result = ingester.ingest(topic, payload.toString(), now);
    if (!result) return;
    if ("reading" in result) writer.addReading(result.reading);
    else if ("event" in result) writer.addEvent(result.event);
    else
      chain = chain.then(async () => {
        if ("transaction" in result) {
          await processor.onState(deviceId, "SONIK-1", result.transaction);
          if (result.transaction.active && result.transaction.txId) {
            const row = await processor.find(deviceId, result.transaction.txId);
            if (row) txRowIds.set(`${deviceId}:${result.transaction.txId}`, row.id);
          }
        } else if ("transactionEnd" in result) await processor.onEnd(deviceId, "SONIK-1", result.transactionEnd);
        else if ("meterValue" in result) await processor.onMeterValue(deviceId, "SONIK-1", result.meterValue, now);
      });
  });
  await subscriber.subscribeAsync(DEVICE_STATE_TOPICS, { qos: 1 });
}, 300_000);

afterAll(async () => {
  await device?.stop();
  await subscriber?.endAsync(true);
  await bus?.close();
  receiver?.stop(true);
  await closeDb?.();
  await Promise.all([postgres?.stop(), keycloak?.stop(), emqx?.stop()]);
});

describe("a charging session", () => {
  test("start: 202, the device closes the contactor, the tenant gets TransactionStarted", async () => {
    device = await startFakeDevice(emqx.mqttUrl, "SONIK-1");
    await eventually(() => Promise.resolve(bus.getState("SONIK-1").online), (o) => o === true, "device online");

    const res = await start("T1", { meterValueIntervalSeconds: 10 });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ transactionId: "T1", state: "starting", meterValueIntervalSeconds: 10 });

    await eventually(() => get("T1"), (t) => t.state === "active", "T1 active");
    expect(device.transaction()).toEqual({ txId: "T1", meterStart: 100 });
    expect(device.relayOn()).toBe(true);

    const [started] = await deliveredEvents(1);
    expect(started).toMatchObject({ eventType: "TransactionStarted", tenantId: "sonik", deviceIdentity: "SONIK-1", transactionId: "T1", sequence: 1, data: { meterStartKwh: 100, meterValueIntervalSeconds: 10 } });
  });

  test("meter values during the session reach the tenant as MeterValues", async () => {
    device!.setMeterKwh(100.25);
    await device!.publishTransactionMeter({ voltage: 230.1, current: 7.5, power: 1725 });
    const events = await deliveredEvents(2);
    expect(events[1]).toMatchObject({ eventType: "MeterValues", transactionId: "T1", sequence: 2, data: { seq: 1, energyWh: 250, meterKwh: 100.25, reading: { ok: true, values: { power: 1725 } } } });
  });

  test("starting another id supersedes the running one: Stopped(T1) then Started(T2), in order", async () => {
    device!.setMeterKwh(100.5);
    expect((await start("T2")).status).toBe(202);
    await eventually(() => get("T2"), (t) => t.state === "active", "T2 active");
    expect(await get("T1")).toMatchObject({ state: "stopped", stopReason: "superseded", summary: { energyWh: 500, energyQuality: "metered", meterStartKwh: 100, meterStopKwh: 100.5 } });

    const events = await deliveredEvents(4);
    expect(events.slice(2).map((e) => [e.eventType, e.transactionId, e.sequence])).toEqual([
      ["TransactionStopped", "T1", 3],
      ["TransactionStarted", "T2", 1],
    ]);
    expect(device!.transaction()).toEqual({ txId: "T2", meterStart: 100.5 });
  });

  test("stop: 202, the contactor opens, the summary includes statistics from stored readings", async () => {
    // Readings the ingest stored while T2 was active: they carry T2's row id.
    await device!.publishMeter({ voltage: 229, current: 30, power: 6900, total_energy: 101 });
    await device!.publishMeter({ voltage: 231, current: 31.3, power: 7200, total_energy: 101.5 });
    await eventually(async () => (await db.select().from(schema.meterReadings).where(eq(schema.meterReadings.deviceId, deviceId))).filter((r) => r.transactionId).length, (n) => n >= 2, "readings tied to T2");
    device!.setMeterKwh(101.5);

    const res = await stop("T2");
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ state: "stopping" });

    const tx = await eventually(() => get("T2"), (t) => t.state === "stopped", "T2 stopped");
    expect(tx).toMatchObject({ stopReason: "remote", summary: { energyWh: 1000, meterStartKwh: 100.5, meterStopKwh: 101.5, powerMaxW: 7200, currentMaxA: 31.3, voltageMinV: 229, voltageMaxV: 231, sampleCount: 2, meterUnreadableSamples: 0 } });
    expect(device!.relayOn()).toBe(false);
    expect(device!.transaction()).toBeNull();
    const events = await deliveredEvents(5);
    expect(events[4]).toMatchObject({ eventType: "TransactionStopped", transactionId: "T2", data: { energyWh: 1000, stopReason: "remote", sampleCount: 2 } });

    // Stopping again is harmless.
    expect((await stop("T2")).status).toBe(200);
  });

  test("the same transaction id started twice is one transaction", async () => {
    expect((await start("T3")).status).toBe(202);
    await eventually(() => get("T3"), (t) => t.state === "active", "T3 active");
    expect((await start("T3")).status).toBe(200);
    expect(device!.transaction()?.txId).toBe("T3");
    await deliveredEvents(6);
  });

  test("an admin cannot switch the contactor off under a session unless forced; forcing ends it properly", async () => {
    const off = await app.request("/api/admin/devices/SONIK-1/relay", { method: "PUT", headers: admin(), body: JSON.stringify({ on: false }) });
    expect(off.status).toBe(409);
    expect(device!.relayOn()).toBe(true);

    const forced = await app.request("/api/admin/devices/SONIK-1/relay", { method: "PUT", headers: admin(), body: JSON.stringify({ on: false, force: true }) });
    expect(forced.status).toBe(200);
    expect(await eventually(() => get("T3"), (t) => t.state === "stopped", "T3 stopped")).toMatchObject({ stopReason: "admin" });
    expect((await deliveredEvents(7))[6]).toMatchObject({ eventType: "TransactionStopped", transactionId: "T3", data: { stopReason: "admin" } });
  });

  test("a stop requested while the device is offline is queued and sent when it returns", async () => {
    expect((await start("T4")).status).toBe(202);
    await eventually(() => get("T4"), (t) => t.state === "active", "T4 active");
    await deliveredEvents(8);

    device!.dropOffNetwork(); // power cut: the broker publishes the last will
    await eventually(() => Promise.resolve(bus.getState("SONIK-1").online), (o) => o === false, "device offline");
    expect((await stop("T4")).status).toBe(202);
    expect(await get("T4")).toMatchObject({ state: "stopping" });

    // The device comes back still running T4 (persisted in its NVS): the processor sends the stop.
    device = await startFakeDevice(emqx.mqttUrl, "SONIK-1", { activeTransaction: { txId: "T4", meterStart: 101.5 }, meterKwh: 103 });
    expect(await eventually(() => get("T4"), (t) => t.state === "stopped", "T4 stopped after reconnect")).toMatchObject({ stopReason: "remote", summary: { energyWh: 1500 } });
    expect(device.transaction()).toBeNull();
    expect((await deliveredEvents(9))[8]).toMatchObject({ eventType: "TransactionStopped", transactionId: "T4" });
  });

  test("a device running a transaction the backend does not know is told to stop", async () => {
    await device!.stop();
    device = await startFakeDevice(emqx.mqttUrl, "SONIK-1", { activeTransaction: { txId: "GHOST", meterStart: 50 } });
    await eventually(() => Promise.resolve(device!.transaction()), (t) => t === null, "ghost transaction stopped");
    expect(device.relayOn()).toBe(false);
  });

  test("a start the device never confirms fails after the deadline, with TransactionFailed", async () => {
    device!.ignoreCommands();
    expect((await start("T5")).status).toBe(202);
    expect(await processor.sweepStartTimeouts(new Date(Date.now() + 61_000))).toBe(1);
    expect(await get("T5")).toMatchObject({ state: "failed", stopReason: "failed" });
    expect((await deliveredEvents(10))[9]).toMatchObject({ eventType: "TransactionFailed", transactionId: "T5", data: { reason: "the device did not confirm the start" } });
  });

  test("a failing webhook endpoint is retried with backoff; MeterValues are not", async () => {
    await device!.stop();
    device = await startFakeDevice(emqx.mqttUrl, "SONIK-1");
    await eventually(() => Promise.resolve(bus.getState("SONIK-1").online), (o) => o === true, "device online");
    receiverStatus = 500;
    expect((await start("T6")).status).toBe(202);
    await eventually(() => get("T6"), (t) => t.state === "active", "T6 active");
    await device.publishTransactionMeter({ power: 100 });
    await eventually(async () => (await db.select().from(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.eventType, "MeterValues"))).length, (n) => n >= 2, "meter value queued");

    await dispatcher.runOnce(); // one attempt, answered 500
    const before = received.length;
    const rows = await db.select().from(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.status, "pending"));
    const started = rows.find((r) => r.eventType === "TransactionStarted" && (r.payload as WebhookEvent).transactionId === "T6")!;
    expect(started).toMatchObject({ attempts: 1, lastStatusCode: 500 });
    expect(started.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 50_000);
    // The meter value waited for the start (per-transaction order) and was never attempted.
    const meterValue = (await db.select().from(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.eventType, "MeterValues"))).find((r) => (r.payload as WebhookEvent).transactionId === "T6")!;
    expect(meterValue).toMatchObject({ status: "pending", attempts: 0 });

    // The endpoint recovers; a dispatcher whose clock has moved past the backoff delivers both, in order.
    receiverStatus = 200;
    const later = new WebhookDispatcher(db, { now: () => new Date(Date.now() + 120_000), log: () => {} });
    await later.runOnce();
    expect(received.slice(before).map((e) => e.eventType)).toEqual(["TransactionStarted", "MeterValues"]);
  });
});
