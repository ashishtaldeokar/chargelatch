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

/** Energy meter wired to the unit; flashed into the fctry partition with the identity. */
export const MeterConfigSchema = z
  .object({
    model: z.string().regex(/^[A-Z0-9]{2,15}$/, "Model names are upper-case, e.g. SDM120").openapi({ example: "SDM120", description: "Must be a model the flashed firmware implements (its manifest lists them)" }),
    address: z.int().min(1).max(247).openapi({ example: 1, description: "Modbus slave address" }),
    baud: z.int().refine((b) => [1200, 2400, 4800, 9600, 19200, 38400].includes(b), "Unsupported baud rate").openapi({ example: 2400, description: "1200, 2400, 4800, 9600, 19200 or 38400" }),
    parity: z.enum(["none", "even", "odd"]).openapi({ example: "none" }),
  })
  .openapi("MeterConfig");

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
    meter: MeterConfigSchema.nullable().openapi({ description: "null on units flashed before meter selection existed" }),
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
    meter: MeterConfigSchema.optional().openapi({ description: "Recorded on the device and written into its partition. Omit to leave a known device's meter unchanged." }),
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
    tenantId: z.string().nullable().openapi({ description: "Tenant allowed to run transactions on this device" }),
    meterConfig: MeterConfigSchema.nullable().openapi({ description: "The meter chosen at the factory; `meter` below is what it is currently reporting" }),
    online: z.boolean().nullable().openapi({ description: "null = not heard from since the API connected to the broker" }),
    firmware: z.string().nullable().openapi({ description: "Firmware version the device itself reports" }),
    relay: RelayStateSchema.nullable(),
    meter: MeterReadingSchema.nullable(),
  })
  .openapi("LiveDevice");

export const SetRelaySchema = z
  .object({
    on: z.boolean().openapi({ description: "true closes the contactor" }),
    force: z.boolean().optional().openapi({ description: "Switching off during a charging transaction is refused (409) unless force is true, which ends the transaction properly (stop reason `admin`)" }),
  })
  .openapi("SetRelay");

// ---- Tenants and transactions ----

export const TenantSchema = z
  .object({
    id: z.string().openapi({ example: "sonik" }),
    name: z.string().openapi({ example: "Sonik" }),
    keycloakClientId: z.string().openapi({ example: "chargelatch-partner-sonik", description: "Service-account client whose tokens act for this tenant" }),
    webhookUrl: z.string().nullable().openapi({ example: "https://partner.example.com/chargelatch/webhook" }),
    meterValueIntervalSeconds: z.int().openapi({ example: 30 }),
    createdAt: z.iso.datetime(),
  })
  .openapi("Tenant");

export const CreateTenantSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,31}$/, "lower-case slug").openapi({ example: "sonik" }),
    name: z.string().min(1),
    keycloakClientId: z.string().min(1).openapi({ example: "chargelatch-partner-sonik" }),
    webhookUrl: z.url().nullable().default(null),
    meterValueIntervalSeconds: z.int().min(5).max(3600).default(30),
  })
  .openapi("CreateTenant");

export const UpdateTenantSchema = CreateTenantSchema.omit({ id: true }).partial().openapi("UpdateTenant");

export const TenantIdParamSchema = z.object({ id: z.string().openapi({ param: { name: "id", in: "path" }, example: "sonik" }) });

export const AssignTenantSchema = z.object({ tenantId: z.string().nullable().openapi({ example: "sonik", description: "null unassigns" }) }).openapi("AssignTenant");

export const TransactionIdParamSchema = z.object({
  transactionId: z.string().min(1).max(64).openapi({ param: { name: "transactionId", in: "path" }, example: "TX-2026-000123" }),
});

export const StartTransactionSchema = z
  .object({
    transactionId: z
      .string()
      .regex(/^[A-Za-z0-9._:-]{1,63}$/, "1-63 characters: letters, digits, . _ : -")
      .openapi({ example: "TX-2026-000123", description: "Your identifier for the session; unique per tenant. Starting the same id again is idempotent." }),
    meterValueIntervalSeconds: z.int().min(5).max(3600).optional().openapi({ example: 30, description: "How often MeterValues are sent while the session is active; defaults to the tenant setting" }),
  })
  .openapi("StartTransaction");

export const TransactionSchema = z
  .object({
    transactionId: z.string().openapi({ example: "TX-2026-000123" }),
    deviceIdentity: z.string().openapi({ example: "SONIK-42" }),
    state: z.enum(["starting", "active", "stopping", "stopped", "failed"]).openapi({
      description:
        "starting: command sent, waiting for the device · active: contactor closed · stopping: stop sent, waiting (or queued until the device is back online) · stopped: ended, summary final · failed: the device never confirmed the start",
    }),
    meterValueIntervalSeconds: z.int(),
    requestedAt: z.iso.datetime(),
    startedAt: z.iso.datetime().nullable().openapi({ description: "When the device confirmed the contactor closed" }),
    stoppedAt: z.iso.datetime().nullable(),
    stopReason: z.string().nullable().openapi({ example: "remote", description: "remote | superseded | admin | failed" }),
    summary: z
      .object({
        energyWh: z.number().nullable().openapi({ example: 7420.5, description: "From the meter's own cumulative counter, exact even if samples were missed" }),
        energyQuality: z.enum(["metered", "partial"]).nullable().openapi({ description: "partial: the counter could not be read at start or stop" }),
        meterStartKwh: z.number().nullable(),
        meterStopKwh: z.number().nullable(),
        durationSeconds: z.number().nullable(),
        powerAvgW: z.number().nullable(),
        powerMaxW: z.number().nullable(),
        currentMaxA: z.number().nullable(),
        voltageMinV: z.number().nullable(),
        voltageMaxV: z.number().nullable(),
        sampleCount: z.int().nullable(),
        meterUnreadableSamples: z.int().nullable(),
      })
      .nullable()
      .openapi({ description: "Present once the transaction is stopped" }),
    failureReason: z.string().nullable(),
  })
  .openapi("Transaction");

export const PartnerDeviceSchema = z
  .object({
    identity: z.string().openapi({ example: "SONIK-42" }),
    online: z.boolean().nullable(),
    contactorOn: z.boolean().nullable(),
    activeTransactionId: z.string().nullable().openapi({ description: "The device's own view; null when idle" }),
    meter: MeterReadingSchema.nullable(),
  })
  .openapi("PartnerDevice");

export const PowerSampleSchema = z
  .object({
    time: z.iso.datetime(),
    power: z.number().nullable().openapi({ description: "Active power in W; null where the meter could not be read" }),
  })
  .openapi("PowerSample");

export const PowerHistoryQuerySchema = z.object({
  minutes: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 60)
    .default(10)
    .openapi({ param: { name: "minutes", in: "query" }, example: 10, description: "How far back, at most 1440 (raw readings expire after 30 days)" }),
});
