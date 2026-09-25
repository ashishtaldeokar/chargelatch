import { describe, expect, test } from "bun:test";
import { generateNvsPartition } from "@chargelatch/nvs-partition";
import { fakeDeps } from "../test/fakes.ts";
import { createApp } from "./app.ts";

const esp32 = { macAddress: "24:6F:28:AA:BB:CC", chipType: "ESP32-D0WD-V3", chipFeatures: ["WiFi", "BT"], flashSizeBytes: 4194304 };

const as = (roles: string) => ({ authorization: `Bearer ${roles}`, "content-type": "application/json" });
const register = (app: ReturnType<typeof createApp>, body: object = esp32, roles = "factory") =>
  app.request("/api/factory/devices", { method: "POST", headers: as(roles), body: JSON.stringify(body) });

describe("factory auth", () => {
  test("401 without a token", async () => {
    const res = await createApp(fakeDeps()).request("/api/factory/devices");
    expect(res.status).toBe(401);
  });

  test("401 with an invalid token", async () => {
    expect((await register(createApp(fakeDeps()), esp32, "bad")).status).toBe(401);
  });

  test("403 without the factory role", async () => {
    expect((await register(createApp(fakeDeps()), esp32, "user")).status).toBe(403);
  });
});

describe("device registration", () => {
  test("issues SONIK-<n> identities and normalises the MAC", async () => {
    const app = createApp(fakeDeps());
    const first = await register(app);
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ identity: "SONIK-1", macAddress: "24:6f:28:aa:bb:cc", created: true });

    const second = await register(app, { ...esp32, macAddress: "24:6f:28:00:00:01" });
    expect(await second.json()).toMatchObject({ identity: "SONIK-2", created: true });
  });

  test("re-registering a known MAC returns the same identity", async () => {
    const app = createApp(fakeDeps());
    await register(app);
    const again = await register(app, { ...esp32, macAddress: esp32.macAddress.toLowerCase() });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ identity: "SONIK-1", created: false });
  });

  test("rejects a malformed MAC", async () => {
    const res = await register(createApp(fakeDeps()), { ...esp32, macAddress: "not-a-mac" });
    expect(res.status).toBe(400);
  });
});

describe("meter configuration", () => {
  const sdm630 = { model: "SDM630", address: 2, baud: 9600, parity: "none" as const };

  test("is recorded at registration and written into the partition", async () => {
    const app = createApp(fakeDeps());
    const res = await register(app, { ...esp32, meter: sdm630 });
    expect(await res.json()).toMatchObject({ identity: "SONIK-1", meter: sdm630 });

    const image = new Uint8Array(await (await app.request("/api/factory/devices/1/partition?size=24576", { headers: as("factory") })).arrayBuffer());
    const expected = generateNvsPartition(
      { factory: { identity: "SONIK-1", pop: "pop-for-1", meter_model: "SDM630", meter_addr: { type: "u8", value: 2 }, meter_baud: { type: "u32", value: 9600 }, meter_parity: "none" } },
      24576,
    );
    expect(Buffer.from(image).equals(Buffer.from(expected))).toBe(true);
  });

  test("a re-flash with a different meter updates the device; without one it keeps the old", async () => {
    const app = createApp(fakeDeps());
    await register(app, { ...esp32, meter: sdm630 });
    const changed = await register(app, { ...esp32, meter: { model: "SDM120", address: 1, baud: 2400, parity: "even" } });
    expect(await changed.json()).toMatchObject({ identity: "SONIK-1", created: false, meter: { model: "SDM120", parity: "even" } });
    const unchanged = await register(app, esp32);
    expect(await unchanged.json()).toMatchObject({ meter: { model: "SDM120" } });
  });

  test("rejects an invalid meter", async () => {
    const app = createApp(fakeDeps());
    expect((await register(app, { ...esp32, meter: { ...sdm630, address: 0 } })).status).toBe(400);
    expect((await register(app, { ...esp32, meter: { ...sdm630, baud: 1234 } })).status).toBe(400);
    expect((await register(app, { ...esp32, meter: { ...sdm630, model: "sdm 630" } })).status).toBe(400);
  });

  test("units without a meter have meter: null everywhere", async () => {
    const app = createApp(fakeDeps());
    await register(app);
    expect(await (await app.request("/api/admin/devices/SONIK-1", { headers: as("admin") })).json()).toMatchObject({ meterConfig: null, meter: null });
  });
});

describe("factory partition", () => {
  test("is the NVS image holding the device identity and PoP", async () => {
    const app = createApp(fakeDeps());
    await register(app);

    const res = await app.request("/api/factory/devices/1/partition?size=24576", { headers: as("factory") });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("cache-control")).toBe("no-store");

    const image = new Uint8Array(await res.arrayBuffer());
    expect(image.length).toBe(24576);
    expect(Buffer.from(image).equals(Buffer.from(generateNvsPartition({ factory: { identity: "SONIK-1", pop: "pop-for-1" } }, 24576)))).toBe(true);
  });

  test("400 for an impossible partition size, 404 for an unknown device", async () => {
    const app = createApp(fakeDeps());
    await register(app);
    expect((await app.request("/api/factory/devices/1/partition?size=1000", { headers: as("factory") })).status).toBe(400);
    expect((await app.request("/api/factory/devices/99/partition?size=24576", { headers: as("factory") })).status).toBe(404);
  });
});

describe("flash bookkeeping", () => {
  test("records firmware version and counts flashes", async () => {
    const app = createApp(fakeDeps());
    await register(app);
    const flashed = (body: object) =>
      app.request("/api/factory/devices/1/flashed", { method: "POST", headers: as("factory"), body: JSON.stringify(body) });

    await flashed({ firmwareVersion: "0.1.0" });
    const res = await flashed({ firmwareVersion: "0.2.0" });
    expect(await res.json()).toMatchObject({ firmwareVersion: "0.2.0", flashCount: 2 });

    const list = (await (await app.request("/api/factory/devices", { headers: as("factory") })).json()) as unknown[];
    expect(list).toHaveLength(1);
  });
});
