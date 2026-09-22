import { describe, expect, test } from "bun:test";
import { fakeDeps, fakeDeviceBus } from "../test/fakes.ts";
import { createApp } from "./app.ts";

const as = (roles: string) => ({ authorization: `Bearer ${roles}`, "content-type": "application/json" });

async function setup() {
  const fake = fakeDeviceBus();
  const app = createApp(fakeDeps(fake.bus));
  await app.request("/api/factory/devices", { method: "POST", headers: as("factory"), body: JSON.stringify({ macAddress: "24:6f:28:aa:bb:cc", chipType: "ESP32" }) });
  const setRelay = (identity: string, body: object, roles = "admin") =>
    app.request(`/api/admin/devices/${identity}/relay`, { method: "PUT", headers: as(roles), body: JSON.stringify(body) });
  return { app, ...fake, setRelay };
}

describe("relay control", () => {
  test("switches an online device and returns what the device reported", async () => {
    const { setRelay, deviceSays, app } = await setup();
    deviceSays("SONIK-1", "status", { online: true, firmware: "0.1.0" });

    const res = await setRelay("SONIK-1", { on: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ on: true });

    const current = await app.request("/api/admin/devices/SONIK-1/relay", { headers: as("admin") });
    expect(await current.json()).toMatchObject({ on: true });

    expect(await (await setRelay("SONIK-1", { on: false })).json()).toMatchObject({ on: false });
  });

  test("409 for a device known to be offline, 504 when it never confirms", async () => {
    const { setRelay, deviceSays, unresponsive } = await setup();
    deviceSays("SONIK-1", "status", { online: false });
    expect((await setRelay("SONIK-1", { on: true })).status).toBe(409);

    deviceSays("SONIK-1", "status", { online: true });
    unresponsive.add("SONIK-1");
    const res = await setRelay("SONIK-1", { on: true });
    expect(res.status).toBe(504);
    expect(((await res.json()) as { error: string }).error).toContain("did not confirm");
  });

  test("only admins, only registered devices, only booleans", async () => {
    const { setRelay } = await setup();
    expect((await setRelay("SONIK-1", { on: true }, "factory")).status).toBe(403);
    expect((await setRelay("SONIK-1", { on: true }, "user")).status).toBe(403);
    expect((await setRelay("SONIK-99", { on: true })).status).toBe(404);
    expect((await setRelay("SONIK-1", { on: "yes" })).status).toBe(400);
    expect((await setRelay("SONIK-1", {})).status).toBe(400);
  });

  test("relay state is 404 until the device has reported one", async () => {
    const { app } = await setup();
    expect((await app.request("/api/admin/devices/SONIK-1/relay", { headers: as("admin") })).status).toBe(404);
  });
});

describe("live device state", () => {
  test("joins the registry with what the device reports, without leaking the PoP", async () => {
    const { app, deviceSays } = await setup();
    deviceSays("SONIK-1", "status", { online: true, firmware: "0.1.0" });
    deviceSays("SONIK-1", "meter", { model: "SDM120", phases: 1, ok: true, voltage: 230.5, power: 287.1 });
    // Something unregistered chattering on the anonymous broker is not a device of ours.
    deviceSays("SONIK-666", "status", { online: true });

    const res = await app.request("/api/admin/devices", { headers: as("admin") });
    const body = await res.text();
    expect(body).not.toContain("pop");
    const list = JSON.parse(body) as { identity: string }[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      identity: "SONIK-1",
      macAddress: "24:6f:28:aa:bb:cc",
      online: true,
      firmware: "0.1.0",
      relay: null,
      meter: { model: "SDM120", ok: true, values: { voltage: 230.5, power: 287.1 } },
    });

    expect((await app.request("/api/admin/devices/SONIK-1", { headers: as("admin") })).status).toBe(200);
    expect((await app.request("/api/admin/devices/SONIK-666", { headers: as("admin") })).status).toBe(404);
    expect((await app.request("/api/admin/devices", { headers: as("user") })).status).toBe(403);
  });

});
