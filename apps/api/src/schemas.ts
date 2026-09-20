import { z } from "@hono/zod-openapi";

export const UserSchema = z
  .object({
    id: z.uuid().openapi({ example: "2a1b8df7-06e3-4920-a3c9-66727a916050" }),
    email: z.email().openapi({ example: "ada@example.com" }),
    name: z.string().openapi({ example: "Ada Lovelace" }),
    createdAt: z.iso.datetime().openapi({ example: "2026-09-19T05:25:50.340Z" }),
  })
  .openapi("User");

export const NewUserSchema = z
  .object({
    email: z.email().openapi({ example: "ada@example.com" }),
    name: z.string().min(1).openapi({ example: "Ada Lovelace" }),
  })
  .openapi("NewUser");

export const HealthSchema = z.object({ status: z.literal("ok") }).openapi("Health");

export const ErrorSchema = z
  .object({
    error: z.string().openapi({ example: "Invalid request" }),
    issues: z
      .array(z.object({ path: z.string(), message: z.string() }))
      .optional()
      .openapi({ description: "Present on validation errors" }),
  })
  .openapi("Error");

const MAC_ADDRESS = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i;

export const DeviceSchema = z
  .object({
    id: z.int().openapi({ example: 1 }),
    identity: z.string().openapi({ example: "SONIK-1", description: "Human-readable identity flashed into the device" }),
    macAddress: z.string().openapi({ example: "24:6f:28:aa:bb:cc" }),
    chipType: z.string().openapi({ example: "ESP32-D0WD-V3" }),
    chipRevision: z.string().nullable().openapi({ example: "v3.1" }),
    chipFeatures: z.array(z.string()).openapi({ example: ["WiFi", "BT", "Dual Core"] }),
    crystalMhz: z.int().nullable().openapi({ example: 40 }),
    flashSizeBytes: z.int().nullable().openapi({ example: 4194304 }),
    firmwareVersion: z.string().nullable().openapi({ example: "0.1.0" }),
    flashCount: z.int().openapi({ example: 1 }),
    lastFlashedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
  })
  .openapi("Device");

export const RegisterDeviceSchema = z
  .object({
    macAddress: z
      .string()
      .regex(MAC_ADDRESS, "Expected a MAC address like 24:6f:28:aa:bb:cc")
      .transform((mac) => mac.toLowerCase())
      .openapi({ example: "24:6f:28:aa:bb:cc", description: "The chip's base MAC address, read over serial" }),
    chipType: z.string().min(1).openapi({ example: "ESP32-D0WD-V3" }),
    chipRevision: z.string().optional(),
    chipFeatures: z.array(z.string()).optional(),
    crystalMhz: z.int().positive().optional(),
    flashSizeBytes: z.int().positive().optional(),
  })
  .openapi("RegisterDevice");

export const RegisteredDeviceSchema = DeviceSchema.extend({
  created: z.boolean().openapi({ description: "false when this MAC was already known and its identity was reused" }),
}).openapi("RegisteredDevice");

export const DeviceFlashedSchema = z
  .object({ firmwareVersion: z.string().min(1).openapi({ example: "0.1.0" }) })
  .openapi("DeviceFlashed");

export const DeviceIdParamSchema = z.object({
  id: z.coerce.number().int().positive().openapi({ param: { name: "id", in: "path" }, example: 1 }),
});

export const PartitionQuerySchema = z.object({
  size: z.coerce
    .number()
    .int()
    .openapi({ param: { name: "size", in: "query" }, example: 24576, description: "Size in bytes of the fctry partition in the firmware's partition table" }),
});

export const DeviceIdentityParamSchema = z.object({
  identity: z
    .string()
    .regex(/^[A-Z]+-\d+$/, "Expected an identity like SONIK-42")
    .openapi({ param: { name: "identity", in: "path" }, example: "SONIK-42" }),
});

export const ProvisioningInfoSchema = z
  .object({
    identity: z.string().openapi({ example: "SONIK-42", description: "Also the device's BLE name while it is unprovisioned" }),
    securityVersion: z.literal(1).openapi({ description: "protocomm security scheme the firmware expects" }),
    pop: z.string().openapi({ description: "Proof-of-possession for the security 1 handshake. Secret: never log or persist it." }),
  })
  .openapi("ProvisioningInfo");

export const RelayStateSchema = z
  .object({
    on: z.boolean(),
    updatedAt: z.iso.datetime().openapi({ description: "When the API last heard this state from the device" }),
  })
  .openapi("RelayState");

export const MeterReadingSchema = z
  .object({
    model: z.string().openapi({ example: "SDM120" }),
    phases: z.int().openapi({ example: 1 }),
    ok: z.boolean().openapi({ description: "false when the meter could not be read (fully or partly); see `error`" }),
    error: z.string().optional().openapi({ example: "timeout" }),
    values: z.record(z.string(), z.number()).openapi({
      description: "V, A, W, VA, VAr, degrees, Hz, kWh, kVArh. 3-phase meters add *_l1.._l3.",
      example: { voltage: 230.5, current: 1.25, power: 287.1, frequency: 50.02, total_energy: 1234.75 },
    }),
    receivedAt: z.iso.datetime(),
  })
  .openapi("MeterReading");

export const LiveDeviceSchema = z
  .object({
    identity: z.string().openapi({ example: "SONIK-1" }),
    macAddress: z.string(),
    chipType: z.string(),
    firmwareVersion: z.string().nullable().openapi({ description: "Firmware recorded when the device was flashed" }),
    online: z.boolean().nullable().openapi({ description: "null = not heard from since the API connected to the broker" }),
    firmware: z.string().nullable().openapi({ description: "Firmware version the device itself reports" }),
    relay: RelayStateSchema.nullable(),
    meter: MeterReadingSchema.nullable(),
  })
  .openapi("LiveDevice");

export const SetRelaySchema = z.object({ on: z.boolean().openapi({ description: "true closes the contactor" }) }).openapi("SetRelay");
