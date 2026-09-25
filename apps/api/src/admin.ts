import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Device } from "@chargelatch/db";
import { requireRole, type AuthEnv, type TokenVerifier } from "./auth.ts";
import { BusUnavailableError, DeviceOfflineError, DeviceTimeoutError, type DeviceBus, type LiveDeviceState } from "./device-bus.ts";
import { meterOf, type DeviceStore } from "./devices.ts";
import type { TelemetryStore } from "./telemetry.ts";
import { defaultHook, json } from "./openapi.ts";
import {
  DeviceIdentityParamSchema,
  ErrorSchema,
  LiveDeviceSchema,
  PowerHistoryQuerySchema,
  PowerSampleSchema,
  ProvisioningInfoSchema,
  RelayStateSchema,
  SetRelaySchema,
} from "./schemas.ts";

const base = { tags: ["admin"], security: [{ bearerAuth: [] }] };
const authErrors = {
  401: json(ErrorSchema, "Missing or invalid bearer token"),
  403: json(ErrorSchema, 'The token lacks the "admin" realm role'),
};
const notFound = { 404: json(ErrorSchema, "No such device") };

const toLiveDevice = (device: Device, live: LiveDeviceState) => ({
  identity: device.identity,
  macAddress: device.macAddress,
  chipType: device.chipType,
  firmwareVersion: device.firmwareVersion,
  meterConfig: meterOf(device),
  online: live.online,
  firmware: live.firmware,
  relay: live.relay,
  meter: live.meter,
});

export function createAdminRoutes(devices: DeviceStore, bus: DeviceBus, telemetry: TelemetryStore, verifier: TokenVerifier) {
  const provisioningRoute = createRoute({
    ...base,
    method: "get",
    path: "/api/admin/devices/{identity}/provisioning",
    summary: "What the admin app needs to pair a device to Wi-Fi over BLE",
    description:
      "The admin app scans for a device advertising its identity as BLE name, then fetches the per-device " +
      "proof-of-possession here to open the security 1 provisioning session.",
    request: { params: DeviceIdentityParamSchema },
    responses: {
      200: json(ProvisioningInfoSchema, "Provisioning parameters, including the secret PoP"),
      400: json(ErrorSchema, "Malformed identity"),
      ...authErrors,
      ...notFound,
    },
  });

  const listRoute = createRoute({
    ...base,
    method: "get",
    path: "/api/admin/devices",
    summary: "Registered devices with their live state",
    responses: { 200: json(z.array(LiveDeviceSchema), "Newest first, at most 200"), ...authErrors },
  });

  const getRoute = createRoute({
    ...base,
    method: "get",
    path: "/api/admin/devices/{identity}",
    summary: "One device: online status, relay state and latest meter reading",
    request: { params: DeviceIdentityParamSchema },
    responses: { 200: json(LiveDeviceSchema, "The device"), 400: json(ErrorSchema, "Malformed identity"), ...authErrors, ...notFound },
  });

  const getRelayRoute = createRoute({
    ...base,
    method: "get",
    path: "/api/admin/devices/{identity}/relay",
    summary: "Current relay (contactor) state as last reported by the device",
    request: { params: DeviceIdentityParamSchema },
    responses: {
      200: json(RelayStateSchema, "The relay state"),
      400: json(ErrorSchema, "Malformed identity"),
      ...authErrors,
      404: json(ErrorSchema, "No such device, or it has not reported a relay state yet"),
    },
  });

  const setRelayRoute = createRoute({
    ...base,
    method: "put",
    path: "/api/admin/devices/{identity}/relay",
    summary: "Switch the relay (contactor) on or off",
    description:
      "Sends the command over MQTT and waits for the device to report the new state, so 200 means the device " +
      "really switched. Idempotent: asking for the state it is already in also succeeds.",
    request: { params: DeviceIdentityParamSchema, body: { ...json(SetRelaySchema, "Desired state"), required: true } },
    responses: {
      200: json(RelayStateSchema, "The state the device reported after executing the command"),
      400: json(ErrorSchema, "Invalid request"),
      ...authErrors,
      ...notFound,
      409: json(ErrorSchema, "The device is offline"),
      503: json(ErrorSchema, "The API is not connected to the MQTT broker"),
      504: json(ErrorSchema, "The device did not confirm in time; its state is unknown"),
    },
  });

  const powerRoute = createRoute({
    ...base,
    method: "get",
    path: "/api/admin/devices/{identity}/power",
    summary: "Recent active power samples from the stored meter readings",
    description: "Raw readings as ingested by the telemetry service (one every ~5 s), oldest first. Live continuation comes from the MQTT feed.",
    request: { params: DeviceIdentityParamSchema, query: PowerHistoryQuerySchema },
    responses: { 200: json(z.array(PowerSampleSchema), "Samples, oldest first"), 400: json(ErrorSchema, "Invalid request"), ...authErrors, ...notFound },
  });

  const routes = new OpenAPIHono<AuthEnv>({ defaultHook });
  routes.use("/api/admin/*", requireRole(verifier, "admin"));

  return routes
    .openapi(provisioningRoute, async (c) => {
      const device = await devices.getByIdentity(c.req.valid("param").identity);
      if (!device) return c.json({ error: "No such device" }, 404);

      c.header("cache-control", "no-store");
      return c.json({ identity: device.identity, securityVersion: 1 as const, pop: device.provisioningPop }, 200);
    })
    .openapi(listRoute, async (c) => c.json((await devices.list(200)).map((device) => toLiveDevice(device, bus.getState(device.identity))), 200))
    .openapi(getRoute, async (c) => {
      const device = await devices.getByIdentity(c.req.valid("param").identity);
      if (!device) return c.json({ error: "No such device" }, 404);
      return c.json(toLiveDevice(device, bus.getState(device.identity)), 200);
    })
    .openapi(powerRoute, async (c) => {
      const device = await devices.getByIdentity(c.req.valid("param").identity);
      if (!device) return c.json({ error: "No such device" }, 404);
      const since = new Date(Date.now() - c.req.valid("query").minutes * 60_000);
      return c.json(await telemetry.recentPower(device.id, since), 200);
    })
    .openapi(getRelayRoute, async (c) => {
      const device = await devices.getByIdentity(c.req.valid("param").identity);
      const relay = device && bus.getState(device.identity).relay;
      if (!relay) return c.json({ error: device ? "The device has not reported a relay state yet" : "No such device" }, 404);
      return c.json(relay, 200);
    })
    .openapi(setRelayRoute, async (c) => {
      // Only registered devices can be commanded, whatever else is talking on the broker.
      const device = await devices.getByIdentity(c.req.valid("param").identity);
      if (!device) return c.json({ error: "No such device" }, 404);

      const { on } = c.req.valid("json");
      try {
        const relay = await bus.setRelay(device.identity, on);
        console.log(`relay ${device.identity} -> ${on ? "on" : "off"} by ${c.var.auth.email ?? c.var.auth.sub}`);
        return c.json(relay, 200);
      } catch (error) {
        if (error instanceof DeviceOfflineError) return c.json({ error: error.message }, 409);
        if (error instanceof DeviceTimeoutError) return c.json({ error: error.message }, 504);
        if (error instanceof BusUnavailableError) return c.json({ error: error.message }, 503);
        throw error;
      }
    });
}
