import { describe, expect, test } from "bun:test";
import { fakeDeps, fakeDeviceBus, fakeTelemetryStore } from "../test/fakes.ts";
import { createApp } from "./app.ts";

const as = (roles: string) => ({ authorization: `Bearer ${roles}`, "content-type": "application/json" });
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

async function setup() {
  const samples = { 1: [{ time: minutesAgo(30), power: 100 }, { time: minutesAgo(5), power: 250 }, { time: minutesAgo(1), power: null }] };
  const app = createApp(fakeDeps(fakeDeviceBus().bus, fakeTelemetryStore(samples)));
  await app.request("/api/factory/devices", { method: "POST", headers: as("factory"), body: JSON.stringify({ macAddress: "24:6f:28:aa:bb:cc", chipType: "ESP32" }) });
  return app;
}

describe("power history", () => {
  test("returns the last 10 minutes by default, nulls kept as gaps", async () => {
    const res = await (await setup()).request("/api/admin/devices/SONIK-1/power", { headers: as("admin") });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { power: number | null }[]).map((s) => s.power)).toEqual([250, null]);
  });

  test("the window is adjustable and capped at a day", async () => {
    const app = await setup();
    expect(((await (await app.request("/api/admin/devices/SONIK-1/power?minutes=60", { headers: as("admin") })).json()) as unknown[]).length).toBe(3);
    expect((await app.request("/api/admin/devices/SONIK-1/power?minutes=0", { headers: as("admin") })).status).toBe(400);
    expect((await app.request("/api/admin/devices/SONIK-1/power?minutes=99999", { headers: as("admin") })).status).toBe(400);
  });

  test("admin only, registered devices only", async () => {
    const app = await setup();
    expect((await app.request("/api/admin/devices/SONIK-1/power", { headers: as("factory") })).status).toBe(403);
    expect((await app.request("/api/admin/devices/SONIK-9/power", { headers: as("admin") })).status).toBe(404);
  });
});
