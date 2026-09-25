import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Device } from "@chargelatch/db";
import { generateNvsPartition } from "@chargelatch/nvs-partition";
import { requireRole, type AuthEnv, type TokenVerifier } from "./auth.ts";
import { meterOf, type DeviceStore } from "./devices.ts";
import { defaultHook, json } from "./openapi.ts";
import {
  DeviceFlashedSchema,
  DeviceIdParamSchema,
  DeviceSchema,
  ErrorSchema,
  PartitionQuerySchema,
  RegisterDeviceSchema,
  RegisteredDeviceSchema,
} from "./schemas.ts";

/** NVS namespace/key the firmware's device_identity component reads from the `fctry` partition. */
export const FACTORY_NAMESPACE = "factory";
export const IDENTITY_KEY = "identity";
export const POP_KEY = "pop";
/** Meter configuration keys; read by the firmware's device_identity component. */
export const METER_KEYS = { model: "meter_model", address: "meter_addr", baud: "meter_baud", parity: "meter_parity" } as const;

const security = [{ bearerAuth: [] }];
const authErrors = {
  401: json(ErrorSchema, "Missing or invalid bearer token"),
  403: json(ErrorSchema, 'The token lacks the "factory" realm role'),
};
const notFound = { 404: json(ErrorSchema, "No such device") };

// provisioningPop is a secret: it is destructured away so it can never leak through this DTO.
export const toDeviceDto = ({ provisioningPop: _secret, meterModel, meterAddress, meterBaud, meterParity, ...device }: Device) => ({
  ...device,
  meter: meterOf({ meterModel, meterAddress, meterBaud, meterParity }),
  createdAt: device.createdAt.toISOString(),
  lastFlashedAt: device.lastFlashedAt?.toISOString() ?? null,
});

export function createFactoryRoutes(devices: DeviceStore, verifier: TokenVerifier) {
  const base = { tags: ["factory"], security };

  const registerRoute = createRoute({
    ...base,
    method: "post",
    path: "/api/factory/devices",
    summary: "Register a device by MAC address, issuing its identity if it is new",
    request: { body: { ...json(RegisterDeviceSchema, "What was read from the chip"), required: true } },
    responses: {
      200: json(RegisteredDeviceSchema, "The MAC was already known; its existing identity is returned"),
      201: json(RegisteredDeviceSchema, "A new device and identity were created"),
      400: json(ErrorSchema, "The request body is invalid"),
      ...authErrors,
    },
  });

  const listRoute = createRoute({
    ...base,
    method: "get",
    path: "/api/factory/devices",
    summary: "Most recently registered devices",
    responses: { 200: json(z.array(DeviceSchema), "Newest first, at most 50"), ...authErrors },
  });

  const partitionRoute = createRoute({
    ...base,
    method: "get",
    path: "/api/factory/devices/{id}/partition",
    summary: "The device's `fctry` NVS partition image, ready to flash",
    request: { params: DeviceIdParamSchema, query: PartitionQuerySchema },
    responses: {
      200: {
        content: { "application/octet-stream": { schema: z.string().openapi({ format: "binary" }) } },
        description: "NVS image (namespace `factory`: `identity`, `pop`, and `meter_*` when a meter is set), exactly `size` bytes",
      },
      400: json(ErrorSchema, "The size is not a valid NVS partition size"),
      ...authErrors,
      ...notFound,
    },
  });

  const flashedRoute = createRoute({
    ...base,
    method: "post",
    path: "/api/factory/devices/{id}/flashed",
    summary: "Record that the device was flashed successfully",
    request: { params: DeviceIdParamSchema, body: { ...json(DeviceFlashedSchema, "What was flashed"), required: true } },
    responses: { 200: json(DeviceSchema, "The updated device"), 400: json(ErrorSchema, "Invalid request"), ...authErrors, ...notFound },
  });

  const routes = new OpenAPIHono<AuthEnv>({ defaultHook });
  // The partition carries the device's provisioning secret, so everything here is role-gated.
  // Every factory route needs the realm role; the routes declare it via `security` above.
  routes.use("/api/factory/*", requireRole(verifier, "factory"));

  return routes
    .openapi(registerRoute, async (c) => {
      const { device, created } = await devices.register(c.req.valid("json"));
      return c.json({ ...toDeviceDto(device), created }, created ? 201 : 200);
    })
    .openapi(listRoute, async (c) => c.json((await devices.list(50)).map(toDeviceDto), 200))
    .openapi(partitionRoute, async (c) => {
      const device = await devices.get(c.req.valid("param").id);
      if (!device) return c.json({ error: "No such device" }, 404);

      let image: Uint8Array;
      try {
        const meter = meterOf(device);
        image = generateNvsPartition(
          {
            [FACTORY_NAMESPACE]: {
              [IDENTITY_KEY]: device.identity,
              [POP_KEY]: device.provisioningPop,
              ...(meter && {
                [METER_KEYS.model]: meter.model,
                [METER_KEYS.address]: { type: "u8", value: meter.address },
                [METER_KEYS.baud]: { type: "u32", value: meter.baud },
                [METER_KEYS.parity]: meter.parity,
              }),
            },
          },
          c.req.valid("query").size,
        );
      } catch (error) {
        return c.json({ error: (error as Error).message }, 400);
      }
      return c.body(image as Uint8Array<ArrayBuffer>, 200, {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename="${device.identity}-fctry.bin"`,
        // Later this will carry per-device secrets: never let it be cached.
        "cache-control": "no-store",
      }) as never;
    })
    .openapi(flashedRoute, async (c) => {
      const device = await devices.markFlashed(c.req.valid("param").id, c.req.valid("json").firmwareVersion);
      if (!device) return c.json({ error: "No such device" }, 404);
      return c.json(toDeviceDto(device), 200);
    });
}
