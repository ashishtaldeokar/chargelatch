import { describe, expect, test } from "bun:test";
import { fakeDeps } from "../test/fakes.ts";
import { createApp } from "./app.ts";

const as = (roles: string) => ({ authorization: `Bearer ${roles}`, "content-type": "application/json" });

async function appWithDevice() {
  const app = createApp(fakeDeps());
  await app.request("/api/factory/devices", {
    method: "POST",
    headers: as("factory"),
    body: JSON.stringify({ macAddress: "24:6f:28:aa:bb:cc", chipType: "ESP32" }),
  });
  return app;
}

describe("provisioning info", () => {
  test("admins get the device's PoP", async () => {
    const res = await (await appWithDevice()).request("/api/admin/devices/SONIK-1/provisioning", { headers: as("admin") });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ identity: "SONIK-1", securityVersion: 1, pop: "pop-for-1" });
  });

  test("the factory role alone cannot read it, nor can anonymous callers", async () => {
    const app = await appWithDevice();
    expect((await app.request("/api/admin/devices/SONIK-1/provisioning", { headers: as("factory") })).status).toBe(403);
    expect((await app.request("/api/admin/devices/SONIK-1/provisioning")).status).toBe(401);
  });

  test("404 for unknown devices, 400 for malformed identities", async () => {
    const app = await appWithDevice();
    expect((await app.request("/api/admin/devices/SONIK-99/provisioning", { headers: as("admin") })).status).toBe(404);
    expect((await app.request("/api/admin/devices/not-an-id/provisioning", { headers: as("admin") })).status).toBe(400);
  });
});

describe("the PoP never leaks through factory responses", () => {
  test("register, list and flashed omit it", async () => {
    const app = await appWithDevice();
    const bodies = await Promise.all([
      app.request("/api/factory/devices", { headers: as("factory") }),
      app.request("/api/factory/devices", { method: "POST", headers: as("factory"), body: JSON.stringify({ macAddress: "24:6f:28:aa:bb:cc", chipType: "ESP32" }) }),
      app.request("/api/factory/devices/1/flashed", { method: "POST", headers: as("factory"), body: JSON.stringify({ firmwareVersion: "0.1.0" }) }),
    ].map(async (r) => (await r).text()));
    for (const body of bodies) {
      expect(body).toContain("SONIK-1");
      expect(body).not.toContain("pop-for-1");
      expect(body).not.toContain("provisioningPop");
    }
  });
});
