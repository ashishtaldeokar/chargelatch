import { sql } from "drizzle-orm";
import { integer, macaddr, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

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
  firmwareVersion: text("firmware_version"),
  flashCount: integer("flash_count").notNull().default(0),
  lastFlashedAt: timestamp("last_flashed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Device = typeof devices.$inferSelect;
export type NewDevice = typeof devices.$inferInsert;
