// The third-party (tenant) API: charging transactions on the tenant's own devices.
// Start/stop are asynchronous: the response is 202 and the outcome arrives on the tenant's
// webhook (TransactionStarted / TransactionStopped / TransactionFailed / MeterValues).
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Device, Transaction } from "@chargelatch/db";
import { createMiddleware } from "hono/factory";
import { requireRole, type AuthEnv, type TokenVerifier } from "./auth.ts";
import { BusUnavailableError, DeviceOfflineError, type DeviceBus } from "./device-bus.ts";
import type { DeviceStore } from "./devices.ts";
import { defaultHook, json } from "./openapi.ts";
import { DeviceIdentityParamSchema, ErrorSchema, PartnerDeviceSchema, StartTransactionSchema, TransactionIdParamSchema, TransactionSchema } from "./schemas.ts";
import type { TenantStore } from "./tenants.ts";
import type { TransactionStore } from "./transactions.ts";

export const PARTNER_TAG = "partner";

const security: Record<string, string[]>[] = [{ partnerAuth: [] }, { bearerAuth: [] }];
const base = { tags: [PARTNER_TAG], security };
const authErrors = {
  401: json(ErrorSchema, "Missing or invalid token"),
  403: json(ErrorSchema, "The token is not a tenant service account (role `partner`, known client)"),
};

export const toTransactionDto = (tx: Transaction, deviceIdentity: string) => ({
  transactionId: tx.transactionId,
  deviceIdentity,
  state: tx.state,
  meterValueIntervalSeconds: tx.meterValueIntervalSeconds,
  requestedAt: tx.requestedAt.toISOString(),
  startedAt: tx.startedAt?.toISOString() ?? null,
  stoppedAt: tx.stoppedAt?.toISOString() ?? null,
  stopReason: tx.stopReason,
  summary:
    tx.state === "stopped"
      ? {
          energyWh: tx.energyWh,
          energyQuality: tx.energyQuality as "metered" | "partial" | null,
          meterStartKwh: tx.meterStartKwh,
          meterStopKwh: tx.meterStopKwh,
          durationSeconds: tx.startedAt && tx.stoppedAt ? Math.round((tx.stoppedAt.getTime() - tx.startedAt.getTime()) / 1000) : null,
          powerAvgW: tx.powerAvgW,
          powerMaxW: tx.powerMaxW,
          currentMaxA: tx.currentMaxA,
          voltageMinV: tx.voltageMinV,
          voltageMaxV: tx.voltageMaxV,
          sampleCount: tx.sampleCount,
          meterUnreadableSamples: tx.meterUnreadableSamples,
        }
      : null,
  failureReason: tx.failureReason,
});

type PartnerEnv = AuthEnv & { Variables: { tenant: { id: string; meterValueIntervalSeconds: number } } };

export function createPartnerRoutes(devices: DeviceStore, transactions: TransactionStore, tenants: TenantStore, bus: DeviceBus, verifier: TokenVerifier) {
  const startRoute = createRoute({
    ...base,
    method: "post",
    path: "/api/partner/devices/{identity}/transactions",
    summary: "Start a charging transaction (closes the contactor)",
    description:
      "Accepted immediately; the device confirms asynchronously and you receive `TransactionStarted` on your webhook " +
      "(or `TransactionFailed` if it never confirms). If another transaction is active on the device it is stopped first " +
      "(`TransactionStopped`, reason `superseded`), then this one starts. Starting an id that already exists returns it unchanged.",
    request: { params: DeviceIdentityParamSchema, body: { ...json(StartTransactionSchema, "The session to start"), required: true } },
    responses: {
      202: json(TransactionSchema, "Command sent to the device; state `starting`"),
      200: json(TransactionSchema, "This transaction id already exists; nothing was sent"),
      400: json(ErrorSchema, "Invalid request"),
      ...authErrors,
      404: json(ErrorSchema, "No such device in your fleet"),
      409: json(ErrorSchema, "The device is offline"),
      503: json(ErrorSchema, "The API is not connected to the device broker; retry"),
    },
  });

  const stopRoute = createRoute({
    ...base,
    method: "post",
    path: "/api/partner/transactions/{transactionId}/stop",
    summary: "Stop a charging transaction (opens the contactor)",
    description:
      "Accepted immediately; `TransactionStopped` with the session summary arrives on your webhook once the device confirms. " +
      "If the device is offline the stop is queued and sent as soon as it reconnects (state `stopping` meanwhile). " +
      "Stopping a transaction that already ended returns it with 200.",
    request: { params: TransactionIdParamSchema },
    responses: {
      202: json(TransactionSchema, "Stop sent or queued; state `stopping`"),
      200: json(TransactionSchema, "Already stopped or failed"),
      ...authErrors,
      404: json(ErrorSchema, "No such transaction"),
      503: json(ErrorSchema, "The API is not connected to the device broker; retry"),
    },
  });

  const getRoute = createRoute({
    ...base,
    method: "get",
    path: "/api/partner/transactions/{transactionId}",
    summary: "A transaction and, once stopped, its summary",
    description: "Use this to reconcile if a webhook was missed.",
    request: { params: TransactionIdParamSchema },
    responses: { 200: json(TransactionSchema, "The transaction"), ...authErrors, 404: json(ErrorSchema, "No such transaction") },
  });

  const listRoute = createRoute({
    ...base,
    method: "get",
    path: "/api/partner/transactions",
    summary: "Your most recent transactions",
    responses: { 200: json(z.array(TransactionSchema), "Newest first, at most 100"), ...authErrors },
  });

  const devicesRoute = createRoute({
    ...base,
    method: "get",
    path: "/api/partner/devices",
    summary: "Your devices with their live state",
    responses: { 200: json(z.array(PartnerDeviceSchema), "Devices assigned to your tenant"), ...authErrors },
  });

  /** After the role check: resolves the tenant from the token's client id. */
  const requireTenant = createMiddleware<PartnerEnv>(async (c, next) => {
    const clientId = c.var.auth.clientId;
    const tenant = clientId ? await tenants.getByClientId(clientId) : undefined;
    if (!tenant) return c.json({ error: "This service account is not registered as a tenant" }, 403);
    c.set("tenant", { id: tenant.id, meterValueIntervalSeconds: tenant.meterValueIntervalSeconds });
    await next();
  });

  const routes = new OpenAPIHono<PartnerEnv>({ defaultHook });
  routes.use("/api/partner/*", requireRole(verifier, "partner"));
  routes.use("/api/partner/*", requireTenant);

  const ownDevice = async (tenantId: string, identity: string): Promise<Device | undefined> => {
    const device = await devices.getByIdentity(identity);
    // Another tenant's device is "not found", never "forbidden": identities are not leaked.
    return device && device.tenantId === tenantId ? device : undefined;
  };

  return routes
    .openapi(startRoute, async (c) => {
      const tenant = c.var.tenant;
      const device = await ownDevice(tenant.id, c.req.valid("param").identity);
      if (!device) return c.json({ error: "No such device" }, 404);
      const { transactionId, meterValueIntervalSeconds = tenant.meterValueIntervalSeconds } = c.req.valid("json");

      const existing = await transactions.get(tenant.id, transactionId);
      if (existing) return c.json(toTransactionDto(existing, device.identity), 200);

      // The device ends a still-open transaction itself when it gets a start for a new id
      // (superseded); the telemetry service records that from the device's tx/end message.
      try {
        await bus.sendTransactionCommand(device.identity, { op: "start", txId: transactionId, intervalSeconds: meterValueIntervalSeconds });
      } catch (error) {
        if (error instanceof DeviceOfflineError) return c.json({ error: error.message }, 409);
        if (error instanceof BusUnavailableError) return c.json({ error: error.message }, 503);
        throw error;
      }
      const tx = await transactions.create({ tenantId: tenant.id, transactionId, deviceId: device.id, meterValueIntervalSeconds });
      console.log(`tx ${transactionId} start requested on ${device.identity} by tenant ${tenant.id}`);
      return c.json(toTransactionDto(tx, device.identity), 202);
    })
    .openapi(stopRoute, async (c) => {
      const tenant = c.var.tenant;
      const tx = await transactions.get(tenant.id, c.req.valid("param").transactionId);
      if (!tx) return c.json({ error: "No such transaction" }, 404);
      const device = (await devices.get(tx.deviceId))!;
      if (tx.state === "stopped" || tx.state === "failed") return c.json(toTransactionDto(tx, device.identity), 200);

      // Flag first: if the device is offline the telemetry service re-sends the stop when it
      // comes back, so the request is never lost.
      const stopping = (await transactions.markStopping(tx.id)) ?? tx;
      try {
        await bus.sendTransactionCommand(device.identity, { op: "stop", txId: tx.transactionId });
      } catch (error) {
        if (error instanceof BusUnavailableError) return c.json({ error: error.message }, 503);
        if (!(error instanceof DeviceOfflineError)) throw error;
        console.log(`tx ${tx.transactionId} stop queued: ${device.identity} is offline`);
      }
      return c.json(toTransactionDto(stopping, device.identity), 202);
    })
    .openapi(getRoute, async (c) => {
      const tx = await transactions.get(c.var.tenant.id, c.req.valid("param").transactionId);
      if (!tx) return c.json({ error: "No such transaction" }, 404);
      return c.json(toTransactionDto(tx, (await devices.get(tx.deviceId))!.identity), 200);
    })
    .openapi(listRoute, async (c) => {
      const list = await transactions.listForTenant(c.var.tenant.id, 100);
      const ids = new Map<number, string>();
      for (const tx of list) if (!ids.has(tx.deviceId)) ids.set(tx.deviceId, (await devices.get(tx.deviceId))!.identity);
      return c.json(list.map((tx) => toTransactionDto(tx, ids.get(tx.deviceId)!)), 200);
    })
    .openapi(devicesRoute, async (c) =>
      c.json(
        (await devices.listForTenant(c.var.tenant.id)).map((device) => {
          const live = bus.getState(device.identity);
          return { identity: device.identity, online: live.online, contactorOn: live.relay?.on ?? null, activeTransactionId: live.transaction?.txId ?? null, meter: live.meter };
        }),
        200,
      ),
    );
}
