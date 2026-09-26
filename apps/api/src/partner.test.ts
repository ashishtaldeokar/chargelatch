import { describe, expect, test } from "bun:test";
import { fakeDeps, fakeDeviceBus, fakeTransactionStore, SONIK } from "../test/fakes.ts";
import { createApp } from "./app.ts";

const as = (roles: string) => ({ authorization: `Bearer ${roles}`, "content-type": "application/json" });
const sonik = as("partner@chargelatch-partner-sonik");

async function setup() {
  const fake = fakeDeviceBus();
  const transactions = fakeTransactionStore();
  const app = createApp(fakeDeps(fake.bus, undefined, { transactions }));
  for (const mac of ["24:6f:28:aa:bb:01", "24:6f:28:aa:bb:02"]) {
    await app.request("/api/factory/devices", { method: "POST", headers: as("factory"), body: JSON.stringify({ macAddress: mac, chipType: "ESP32" }) });
  }
  // SONIK-1 belongs to sonik, SONIK-2 to nobody.
  await app.request("/api/admin/devices/SONIK-1/tenant", { method: "PUT", headers: as("admin"), body: JSON.stringify({ tenantId: "sonik" }) });
  fake.deviceSays("SONIK-1", "status", { online: true, firmware: "0.1.0" });
  fake.deviceSays("SONIK-2", "status", { online: true, firmware: "0.1.0" });
  const start = (identity: string, body: object, headers = sonik) => app.request(`/api/partner/devices/${identity}/transactions`, { method: "POST", headers, body: JSON.stringify(body) });
  const stop = (id: string) => app.request(`/api/partner/transactions/${id}/stop`, { method: "POST", headers: sonik });
  return { app, ...fake, transactions, start, stop };
}

describe("partner auth and tenancy", () => {
  test("only partner service accounts registered as tenants get in", async () => {
    const { start } = await setup();
    expect((await start("SONIK-1", { transactionId: "T1" }, as("admin"))).status).toBe(403);
    expect((await start("SONIK-1", { transactionId: "T1" }, as("partner@unknown-client"))).status).toBe(403);
    expect((await start("SONIK-1", { transactionId: "T1" }, { "content-type": "application/json" } as unknown as ReturnType<typeof as>)).status).toBe(401);
  });

  test("another tenant's or unassigned device is not found, never forbidden", async () => {
    const { start } = await setup();
    expect((await start("SONIK-2", { transactionId: "T1" })).status).toBe(404);
    expect((await start("SONIK-99", { transactionId: "T1" })).status).toBe(404);
  });
});

describe("transactions", () => {
  test("start is accepted, sends the command with the interval, and is idempotent", async () => {
    const { start, commands } = await setup();
    const res = await start("SONIK-1", { transactionId: "T1", meterValueIntervalSeconds: 15 });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ transactionId: "T1", deviceIdentity: "SONIK-1", state: "starting", meterValueIntervalSeconds: 15, summary: null });
    expect(commands).toEqual([{ identity: "SONIK-1", command: { op: "start", txId: "T1", intervalSeconds: 15 } }]);

    const again = await start("SONIK-1", { transactionId: "T1" });
    expect(again.status).toBe(200);
    expect(commands).toHaveLength(1);
  });

  test("the tenant's default interval applies when none is given", async () => {
    const { start, commands } = await setup();
    await start("SONIK-1", { transactionId: "T1" });
    expect(commands[0]!.command.intervalSeconds).toBe(SONIK.meterValueIntervalSeconds);
  });

  test("an offline device refuses the start, and nothing is recorded", async () => {
    const { start, deviceSays, transactions } = await setup();
    deviceSays("SONIK-1", "status", { online: false });
    expect((await start("SONIK-1", { transactionId: "T1" })).status).toBe(409);
    expect(transactions.rows).toHaveLength(0);
  });

  test("stop flags the transaction and sends the command; offline queues it", async () => {
    const { start, stop, commands, deviceSays } = await setup();
    await start("SONIK-1", { transactionId: "T1" });
    const res = await stop("T1");
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ state: "stopping" });
    expect(commands.at(-1)).toEqual({ identity: "SONIK-1", command: { op: "stop", txId: "T1" } });

    await start("SONIK-1", { transactionId: "T2" });
    deviceSays("SONIK-1", "status", { online: false });
    const queued = await stop("T2");
    expect(queued.status).toBe(202);
    expect(await queued.json()).toMatchObject({ state: "stopping" });
    expect(commands.filter((c) => c.command.txId === "T2" && c.command.op === "stop")).toHaveLength(0);
  });

  test("stopping a finished transaction just returns it; unknown ids are 404", async () => {
    const { start, stop, transactions, app } = await setup();
    await start("SONIK-1", { transactionId: "T1" });
    Object.assign(transactions.rows[0]!, { state: "stopped", stoppedAt: new Date(), startedAt: new Date(Date.now() - 60_000), energyWh: 500, energyQuality: "metered" });
    const res = await stop("T1");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: "stopped", summary: { energyWh: 500, energyQuality: "metered", durationSeconds: 60 } });
    expect((await stop("NOPE")).status).toBe(404);
    expect((await app.request("/api/partner/transactions/T1", { headers: sonik })).status).toBe(200);
    expect(((await (await app.request("/api/partner/transactions", { headers: sonik })).json()) as unknown[]).length).toBe(1);
  });

  test("rejects a bad transaction id", async () => {
    const { start } = await setup();
    expect((await start("SONIK-1", { transactionId: "has spaces" })).status).toBe(400);
    expect((await start("SONIK-1", { transactionId: "T1", meterValueIntervalSeconds: 1 })).status).toBe(400);
  });

  test("partner device list shows live state of the tenant's devices only", async () => {
    const { app, deviceSays } = await setup();
    deviceSays("SONIK-1", "tx", { state: "active", txId: "T9", meterStart: 1, interval: 30 });
    deviceSays("SONIK-1", "relay", { on: true });
    const list = (await (await app.request("/api/partner/devices", { headers: sonik })).json()) as unknown[];
    expect(list).toEqual([{ identity: "SONIK-1", online: true, contactorOn: true, activeTransactionId: "T9", meter: null }]);
  });
});

describe("admin relay vs transactions", () => {
  test("switching off during a transaction is refused unless forced", async () => {
    const { app, deviceSays } = await setup();
    deviceSays("SONIK-1", "tx", { state: "active", txId: "T1", meterStart: 1, interval: 30 });
    deviceSays("SONIK-1", "relay", { on: true });
    const off = await app.request("/api/admin/devices/SONIK-1/relay", { method: "PUT", headers: as("admin"), body: JSON.stringify({ on: false }) });
    expect(off.status).toBe(409);
    expect(((await off.json()) as { error: string }).error).toContain("active charging transaction");

    const forced = await app.request("/api/admin/devices/SONIK-1/relay", { method: "PUT", headers: as("admin"), body: JSON.stringify({ on: false, force: true }) });
    expect(forced.status).toBe(200);
    expect(await forced.json()).toMatchObject({ on: false });
  });
});

describe("tenant admin", () => {
  test("create, list, update, assign", async () => {
    const { app } = await setup();
    const created = await app.request("/api/admin/tenants", { method: "POST", headers: as("admin"), body: JSON.stringify({ id: "acme", name: "Acme", keycloakClientId: "chargelatch-partner-acme" }) });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ id: "acme", webhookUrl: null, meterValueIntervalSeconds: 30 });
    expect((await app.request("/api/admin/tenants", { method: "POST", headers: as("admin"), body: JSON.stringify({ id: "acme", name: "Dup", keycloakClientId: "x" }) })).status).toBe(409);
    expect((await app.request("/api/admin/tenants", { method: "POST", headers: as("admin"), body: JSON.stringify({ id: "Bad Slug", name: "x", keycloakClientId: "y" }) })).status).toBe(400);

    const patched = await app.request("/api/admin/tenants/acme", { method: "PATCH", headers: as("admin"), body: JSON.stringify({ webhookUrl: "https://acme.example/hook" }) });
    expect(await patched.json()).toMatchObject({ webhookUrl: "https://acme.example/hook" });

    expect(((await (await app.request("/api/admin/tenants", { headers: as("admin") })).json()) as unknown[]).length).toBe(2);
    expect((await app.request("/api/admin/devices/SONIK-2/tenant", { method: "PUT", headers: as("admin"), body: JSON.stringify({ tenantId: "nope" }) })).status).toBe(404);
    const assigned = await app.request("/api/admin/devices/SONIK-2/tenant", { method: "PUT", headers: as("admin"), body: JSON.stringify({ tenantId: "acme" }) });
    expect(await assigned.json()).toMatchObject({ identity: "SONIK-2", tenantId: "acme" });
    expect((await app.request("/api/admin/tenants", { headers: as("factory") })).status).toBe(403);
  });
});

describe("docs", () => {
  test("the partner spec contains only partner operations and the OAuth2 scheme", async () => {
    const app = createApp(fakeDeps());
    const spec = (await (await app.request("/api/partner/openapi.json")).json()) as { info: { title: string }; paths: Record<string, unknown>; components: { securitySchemes: Record<string, { type: string }> } };
    expect(spec.info.title).toBe("chargelatch partner API");
    expect(Object.keys(spec.paths).sort()).toEqual(["/api/partner/devices", "/api/partner/devices/{identity}/transactions", "/api/partner/transactions", "/api/partner/transactions/{transactionId}", "/api/partner/transactions/{transactionId}/stop"]);
    expect(spec.components.securitySchemes.partnerAuth).toMatchObject({ type: "oauth2" });
    expect((await app.request("/api/partner/docs")).status).toBe(200);
  });
});
