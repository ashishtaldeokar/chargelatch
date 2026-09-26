import { sql } from "drizzle-orm";
import { boolean, doublePrecision, index, integer, jsonb, macaddr, pgEnum, pgTable, real, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

/** Every ESP32 that has been through the factory app. */
export const devices = pgTable("devices", {
  // The counter behind the human-readable identity. Identity columns cannot be written by
  // inserts, so ids are only ever issued by Postgres.
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  // "SONIK-<id>": what is flashed into the device's `fctry` NVS partition.
  identity: text("identity")
    .notNull()
    .unique()
    .generatedAlwaysAs(sql`'SONIK-' || id::text`),
  // Proof-of-possession for BLE Wi-Fi provisioning (protocomm security 1). Issued by Postgres like
  // the identity, flashed next to it, and only ever handed out to admins. 122 random bits.
  provisioningPop: text("provisioning_pop")
    .notNull()
    .default(sql`replace(gen_random_uuid()::text, '-', '')`),
  // The chip's factory-programmed base MAC: the natural key a device is recognised by.
  macAddress: macaddr("mac_address").notNull().unique(),
  chipType: text("chip_type").notNull(),
  chipRevision: text("chip_revision"),
  chipFeatures: text("chip_features").array().notNull().default(sql`'{}'`),
  crystalMhz: integer("crystal_mhz"),
  flashSizeBytes: integer("flash_size_bytes"),
  // Energy meter wired to this unit, chosen at the factory and flashed into fctry with the
  // identity. Null on units flashed before meter selection existed (firmware defaults apply).
  meterModel: text("meter_model"),
  meterAddress: integer("meter_address"),
  meterBaud: integer("meter_baud"),
  meterParity: text("meter_parity"),
  /** The tenant allowed to run transactions on this device (assigned via the admin API). */
  tenantId: text("tenant_id"),
  firmwareVersion: text("firmware_version"),
  flashCount: integer("flash_count").notNull().default(0),
  lastFlashedAt: timestamp("last_flashed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Device = typeof devices.$inferSelect;
export type NewDevice = typeof devices.$inferInsert;

// ---- Telemetry (TimescaleDB) ----------------------------------------------------------------
// Hypertables, retention and the aggregation job are created in migration 0004 with raw SQL;
// drizzle only knows the columns. `time` is when the API/telemetry service received the message
// (devices have no clock).

/** One row per devices/<id>/meter message. Retention: 30 days. */
export const meterReadings = pgTable("meter_readings", {
  time: timestamp("time", { withTimezone: true }).notNull(),
  deviceId: integer("device_id").notNull(),
  /** Our transactions.id when the reading was published as part of a session (tx/meter). */
  transactionId: uuid("transaction_id"),
  model: text("model").notNull(),
  ok: boolean("ok").notNull(),
  error: text("error"),
  // Totals (1-phase values, or system totals on a 3-phase meter). Nullable: a partial read
  // carries only the fields that arrived.
  voltage: real("voltage"),
  current: real("current"),
  power: real("power"),
  apparentPower: real("apparent_power"),
  reactivePower: real("reactive_power"),
  powerFactor: real("power_factor"),
  phaseAngle: real("phase_angle"),
  frequency: real("frequency"),
  importEnergy: doublePrecision("import_energy"),
  exportEnergy: doublePrecision("export_energy"),
  totalEnergy: doublePrecision("total_energy"),
  importReactiveEnergy: doublePrecision("import_reactive_energy"),
  exportReactiveEnergy: doublePrecision("export_reactive_energy"),
  totalReactiveEnergy: doublePrecision("total_reactive_energy"),
  // Per phase (3-phase meters only).
  voltageL1: real("voltage_l1"),
  voltageL2: real("voltage_l2"),
  voltageL3: real("voltage_l3"),
  currentL1: real("current_l1"),
  currentL2: real("current_l2"),
  currentL3: real("current_l3"),
  powerL1: real("power_l1"),
  powerL2: real("power_l2"),
  powerL3: real("power_l3"),
  powerFactorL1: real("power_factor_l1"),
  powerFactorL2: real("power_factor_l2"),
  powerFactorL3: real("power_factor_l3"),
  // Any field a future meter model publishes that has no column yet: nothing is ever dropped.
  extra: jsonb("extra").$type<Record<string, number>>(),
});

export const deviceEventKind = pgEnum("device_event_kind", ["online", "offline", "relay_on", "relay_off"]);

/** Online/offline and relay changes, so meter data can be explained. No retention. */
export const deviceEvents = pgTable("device_events", {
  time: timestamp("time", { withTimezone: true }).notNull(),
  deviceId: integer("device_id").notNull(),
  kind: deviceEventKind("kind").notNull(),
  /** Firmware version for online events, request id for relay events. */
  detail: text("detail"),
});

/** Filled by the `aggregate_meter_readings` job every 15 min. Never expires. */
export const meterReadings15m = pgTable("meter_readings_15m", {
  bucket: timestamp("bucket", { withTimezone: true }).notNull(),
  deviceId: integer("device_id").notNull(),
  samples: integer("samples").notNull(),
  failedSamples: integer("failed_samples").notNull(),
  powerAvg: real("power_avg"),
  powerMin: real("power_min"),
  powerMax: real("power_max"),
  voltageAvg: real("voltage_avg"),
  voltageMin: real("voltage_min"),
  voltageMax: real("voltage_max"),
  currentAvg: real("current_avg"),
  currentMin: real("current_min"),
  currentMax: real("current_max"),
  powerFactorAvg: real("power_factor_avg"),
  frequencyAvg: real("frequency_avg"),
  /** Wh consumed in the bucket: last total_energy - first, or null if fewer than 2 readings. */
  energyWh: real("energy_wh"),
  totalEnergyEnd: doublePrecision("total_energy_end"),
});

export type MeterReadingRow = typeof meterReadings.$inferInsert;
export type DeviceEventRow = typeof deviceEvents.$inferInsert;

// ---- Tenants, charging transactions, webhooks -----------------------------------------------

/** A third-party platform that runs charging sessions on its devices through /api/partner/*. */
export const tenants = pgTable("tenants", {
  /** Short slug, e.g. "sonik". Appears in webhook payloads. */
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** Keycloak service-account client whose tokens (azp) map to this tenant. */
  keycloakClientId: text("keycloak_client_id").notNull().unique(),
  /** Where every event for this tenant is POSTed; null disables delivery. */
  webhookUrl: text("webhook_url"),
  /** Default meter-value interval for its transactions, overridable per start. */
  meterValueIntervalSeconds: integer("meter_value_interval_seconds").notNull().default(30),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const transactionState = pgEnum("transaction_state", ["starting", "active", "stopping", "stopped", "failed"]);

/**
 * One charging session. The tenant's `transactionId` is the public handle (unique per tenant);
 * `id` is ours. State is written only by the telemetry service from device events, except
 * `starting` (API, on request) and `stopping` (API, on a stop request).
 */
export const transactions = pgTable(
  "transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    transactionId: text("transaction_id").notNull(),
    deviceId: integer("device_id").notNull().references(() => devices.id),
    state: transactionState("state").notNull().default("starting"),
    meterValueIntervalSeconds: integer("meter_value_interval_seconds").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    /** Set when the device acknowledged the start. */
    startedAt: timestamp("started_at", { withTimezone: true }),
    stopRequestedAt: timestamp("stop_requested_at", { withTimezone: true }),
    /** Set when the device acknowledged the end. */
    stoppedAt: timestamp("stopped_at", { withTimezone: true }),
    /** remote | superseded | admin | failed */
    stopReason: text("stop_reason"),
    /** The meter's cumulative kWh counter at start/stop, as reported by the device. */
    meterStartKwh: doublePrecision("meter_start_kwh"),
    meterStopKwh: doublePrecision("meter_stop_kwh"),
    /** Energy delivered, from the device's counter delta. */
    energyWh: real("energy_wh"),
    /** metered | partial: partial when the counter could not be read at stop. */
    energyQuality: text("energy_quality"),
    /** Statistics over meter_readings of this transaction, filled at stop. */
    powerAvgW: real("power_avg_w"),
    powerMaxW: real("power_max_w"),
    currentMaxA: real("current_max_a"),
    voltageMinV: real("voltage_min_v"),
    voltageMaxV: real("voltage_max_v"),
    sampleCount: integer("sample_count"),
    meterUnreadableSamples: integer("meter_unreadable_samples"),
    /** Last error while talking to the device, for `failed`. */
    failureReason: text("failure_reason"),
  },
  (t) => [uniqueIndex("transactions_tenant_tx_idx").on(t.tenantId, t.transactionId), index("transactions_device_idx").on(t.deviceId, t.requestedAt)],
);

export const webhookDeliveryStatus = pgEnum("webhook_delivery_status", ["pending", "delivered", "failed"]);

/** Outbox: one row per event per tenant, delivered in `sequence` order per transaction. */
export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    transactionId: uuid("transaction_id").references(() => transactions.id),
    eventType: text("event_type").notNull(),
    /** Per-transaction ordering for the receiver. */
    sequence: integer("sequence").notNull(),
    payload: jsonb("payload").notNull(),
    status: webhookDeliveryStatus("status").notNull().default("pending"),
    /** false = best effort (MeterValues): one attempt, then dropped. */
    retry: boolean("retry").notNull().default(true),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lastError: text("last_error"),
    lastStatusCode: integer("last_status_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  },
  (t) => [index("webhook_deliveries_pending_idx").on(t.tenantId, t.status, t.nextAttemptAt)],
);

export type Tenant = typeof tenants.$inferSelect;
export type Transaction = typeof transactions.$inferSelect;
export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;
