// The factory API against the real thing: migrations on the baked Postgres image, tokens issued
// and verified against the baked Keycloak realm. All API e2e tests live in this one file (see
// the module-registry trap in CLAUDE.md).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createApp } from "@chargelatch/api";
import { createKeycloakVerifier } from "@chargelatch/api/auth";
import { MqttDeviceBus } from "@chargelatch/api/device-bus";
import { createDeviceStore } from "@chargelatch/api/devices";
import { createUserStore } from "@chargelatch/api/users";
import { createDb } from "@chargelatch/db";
import { runMigrations } from "@chargelatch/db/migrate";
import { startEmqx, type StartedEmqx } from "./helpers/emqx.ts";
import { startFakeDevice, type FakeDevice } from "./helpers/fake-device.ts";
import { FIXTURE_USERS, getAccessToken, REALM, startKeycloak, type StartedKeycloak } from "./helpers/keycloak.ts";
import { startPostgres, type StartedPostgres } from "./helpers/postgres.ts";

let postgres: StartedPostgres;
let keycloak: StartedKeycloak;
let emqx: StartedEmqx;
let bus: MqttDeviceBus;
let closeDb: () => Promise<void>;
let app: ReturnType<typeof createApp>;
let factoryToken: string;

beforeAll(async () => {
  [postgres, keycloak, emqx] = await Promise.all([startPostgres(), startKeycloak(), startEmqx()]);
  await runMigrations(postgres.url());

  const { db, close } = createDb(postgres.url());
  closeDb = close;
  bus = new MqttDeviceBus({ url: emqx.mqttUrl, commandTimeoutMs: 1500 });
  await bus.ready();
  app = createApp({
    users: createUserStore(db),
    devices: createDeviceStore(db),
    bus,
    auth: createKeycloakVerifier(`${keycloak.baseUrl}/realms/${REALM}`, "chargelatch-api"),
  });
  factoryToken = await getAccessToken(keycloak.baseUrl, FIXTURE_USERS.factory);
}, 300_000);

afterAll(async () => {
  await bus?.close();
  await closeDb?.();
  await Promise.all([postgres?.stop(), keycloak?.stop(), emqx?.stop()]);
});

const registerDevice = (macAddress: string, token = factoryToken) =>
  app.request("/api/factory/devices", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ macAddress, chipType: "ESP32-D0WD-V3", chipFeatures: ["WiFi", "BT"], flashSizeBytes: 4194304 }),
  });

describe("factory api", () => {
  test("rejects requests without a Keycloak token", async () => {
    expect((await app.request("/api/factory/devices")).status).toBe(401);
    expect((await registerDevice("24:6f:28:00:00:01", "not.a.jwt")).status).toBe(401);
  });

  test("rejects a real token that lacks the factory role", async () => {
    const userToken = await getAccessToken(keycloak.baseUrl, FIXTURE_USERS.user);
    expect((await registerDevice("24:6f:28:00:00:01", userToken)).status).toBe(403);
  });

  test("issues sequential SONIK identities from the postgres counter", async () => {
    const first = await registerDevice("24:6F:28:00:00:01");
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ identity: "SONIK-1", macAddress: "24:6f:28:00:00:01", created: true });

    const second = await registerDevice("24:6f:28:00:00:02");
    expect(await second.json()).toMatchObject({ identity: "SONIK-2", created: true });
  });

  test("re-flashing a known chip reuses its identity and does not burn a number", async () => {
    const again = await registerDevice("24:6f:28:00:00:01");
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ identity: "SONIK-1", created: false });

    const next = await registerDevice("24:6f:28:00:00:03");
    expect(await next.json()).toMatchObject({ identity: "SONIK-3" });
  });

  test("concurrent registrations of one MAC agree on a single identity", async () => {
    const responses = await Promise.all(Array.from({ length: 5 }, () => registerDevice("24:6f:28:00:00:aa")));
    const identities = await Promise.all(responses.map(async (r) => ((await r.json()) as { identity: string }).identity));
    expect(new Set(identities).size).toBe(1);
  });

  test("serves an NVS partition containing the identity, and records the flash", async () => {
    const headers = { authorization: `Bearer ${factoryToken}`, "content-type": "application/json" };
    const res = await app.request("/api/factory/devices/2/partition?size=24576", { headers });
    expect(res.status).toBe(200);
    const image = Buffer.from(await res.arrayBuffer());
    expect(image.length).toBe(24576);
    expect(image.includes(Buffer.from("SONIK-2\0"))).toBe(true);
    expect(image.includes(Buffer.from("SONIK-1\0"))).toBe(false);

    const flashed = await app.request("/api/factory/devices/2/flashed", { method: "POST", headers, body: JSON.stringify({ firmwareVersion: "0.1.0" }) });
    expect(await flashed.json()).toMatchObject({ identity: "SONIK-2", firmwareVersion: "0.1.0", flashCount: 1 });
  });
});

describe("admin provisioning api", () => {
  const provisioning = (identity: string, token: string) =>
    app.request(`/api/admin/devices/${identity}/provisioning`, { headers: { authorization: `Bearer ${token}` } });

  test("an admin gets exactly the PoP that is flashed into the device", async () => {
    const adminToken = await getAccessToken(keycloak.baseUrl, FIXTURE_USERS.admin);
    const res = await provisioning("SONIK-1", adminToken);
    expect(res.status).toBe(200);
    const info = (await res.json()) as { identity: string; securityVersion: number; pop: string };
    expect(info).toMatchObject({ identity: "SONIK-1", securityVersion: 1 });
    expect(info.pop).toMatch(/^[0-9a-f]{32}$/);

    const partition = await app.request("/api/factory/devices/1/partition?size=24576", { headers: { authorization: `Bearer ${factoryToken}` } });
    const image = Buffer.from(await partition.arrayBuffer());
    expect(image.includes(Buffer.from(`${info.pop}\0`))).toBe(true);
  });

  test("every device gets its own PoP", async () => {
    const adminToken = await getAccessToken(keycloak.baseUrl, FIXTURE_USERS.admin);
    const pops = await Promise.all(
      ["SONIK-1", "SONIK-2", "SONIK-3"].map(async (id) => ((await (await provisioning(id, adminToken)).json()) as { pop: string }).pop),
    );
    expect(new Set(pops).size).toBe(3);
  });

  test("the factory role cannot read PoPs, and factory responses never contain them", async () => {
    expect((await provisioning("SONIK-1", factoryToken)).status).toBe(403);
    expect((await provisioning("SONIK-1", await getAccessToken(keycloak.baseUrl, FIXTURE_USERS.user))).status).toBe(403);

    const list = await app.request("/api/factory/devices", { headers: { authorization: `Bearer ${factoryToken}` } });
    expect(await list.text()).not.toMatch(/pop/i);
  });

  test("404 for a device that was never registered", async () => {
    const adminToken = await getAccessToken(keycloak.baseUrl, FIXTURE_USERS.admin);
    expect((await provisioning("SONIK-999", adminToken)).status).toBe(404);
  });
});

describe("device control over mqtt", () => {
  let adminToken: string;
  let device: FakeDevice;
  const admin = () => ({ authorization: `Bearer ${adminToken}`, "content-type": "application/json" });
  const setRelay = (identity: string, on: boolean) =>
    app.request(`/api/admin/devices/${identity}/relay`, { method: "PUT", headers: admin(), body: JSON.stringify({ on }) });
  const liveState = async (identity: string) =>
    (await (await app.request(`/api/admin/devices/${identity}`, { headers: admin() })).json()) as {
      online: boolean | null;
      relay: { on: boolean } | null;
      meter: { ok: boolean; error?: string; values: Record<string, number> } | null;
    };
  /** MQTT is asynchronous: poll the API until it has caught up. */
  async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
    for (let i = 0; i < 100; i++) {
      const value = await read();
      if (done(value)) return value;
      await Bun.sleep(50);
    }
    throw new Error("state never arrived");
  }

  beforeAll(async () => {
    adminToken = await getAccessToken(keycloak.baseUrl, FIXTURE_USERS.admin);
    device = await startFakeDevice(emqx.mqttUrl, "SONIK-1"); // registered by the factory tests above
  });

  afterAll(async () => {
    await device?.stop();
  });

  test("the api learns a device's state from its retained messages", async () => {
    const state = await eventually(() => liveState("SONIK-1"), (s) => s.online === true && s.relay !== null);
    expect(state).toMatchObject({ online: true, firmware: "0.1.0", relay: { on: false } });
  });

  test("PUT relay reaches the device, and 200 means the device confirmed", async () => {
    const res = await setRelay("SONIK-1", true);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ on: true });
    expect(device.relayOn()).toBe(true);

    expect(await (await app.request("/api/admin/devices/SONIK-1/relay", { headers: admin() })).json()).toMatchObject({ on: true });

    await setRelay("SONIK-1", false);
    expect(device.relayOn()).toBe(false);
  });

  test("meter readings published by the device show up over http", async () => {
    await device.publishMeter({ voltage: 231.4, current: 6.2, power: 1430.5, total_energy: 1234.75 });
    const state = await eventually(() => liveState("SONIK-1"), (s) => s.meter?.values.power === 1430.5);
    expect(state.meter).toMatchObject({ ok: true, values: { voltage: 231.4, current: 6.2, total_energy: 1234.75 } });

    await device.publishMeterFailure("timeout");
    const failed = await eventually(() => liveState("SONIK-1"), (s) => s.meter?.ok === false);
    expect(failed.meter).toMatchObject({ ok: false, error: "timeout", values: {} });
  });

  test("relay control requires the admin role and a real keycloak token", async () => {
    const put = (token: string) =>
      app.request("/api/admin/devices/SONIK-1/relay", { method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ on: true }) });
    expect((await put(factoryToken)).status).toBe(403);
    expect((await put("not.a.jwt")).status).toBe(401);
    expect(device.relayOn()).toBe(false);
  });

  test("a registered device that never connected times out with 504", async () => {
    expect((await setRelay("SONIK-2", true)).status).toBe(504);
  });

  test("a hung device gives 504, and one that dropped off the network gives 409", async () => {
    device.ignoreCommands();
    expect((await setRelay("SONIK-1", true)).status).toBe(504);

    device.dropOffNetwork(); // the broker publishes the last will
    await eventually(() => liveState("SONIK-1"), (s) => s.online === false);
    expect((await setRelay("SONIK-1", true)).status).toBe(409);
  });
});
