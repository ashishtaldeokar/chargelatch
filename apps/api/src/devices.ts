import { schema, type Db, type Device, type NewDevice } from "@chargelatch/db";
import { desc, eq, sql } from "drizzle-orm";

export type DeviceRegistration = Pick<
  NewDevice,
  "macAddress" | "chipType" | "chipRevision" | "chipFeatures" | "crystalMhz" | "flashSizeBytes"
>;

export interface DeviceStore {
  /** Returns the device for this MAC, creating it (and so issuing its identity) if it is new. */
  register(registration: DeviceRegistration): Promise<{ device: Device; created: boolean }>;
  get(id: number): Promise<Device | undefined>;
  getByIdentity(identity: string): Promise<Device | undefined>;
  list(limit: number): Promise<Device[]>;
  markFlashed(id: number, firmwareVersion: string): Promise<Device | undefined>;
}

export function createDeviceStore(db: Db): DeviceStore {
  const { devices } = schema;
  const byMac = async (macAddress: string) =>
    (await db.select().from(devices).where(eq(devices.macAddress, macAddress)))[0];

  return {
    register: async (registration) => {
      // Look first: a blind upsert would burn a sequence value, and so a SONIK number, on
      // every re-flash of a known device.
      const existing = await byMac(registration.macAddress);
      if (existing) return { device: existing, created: false };

      const [created] = await db.insert(devices).values(registration).onConflictDoNothing().returning();
      if (created) return { device: created, created: true };
      // Lost a race with a concurrent registration of the same MAC.
      return { device: (await byMac(registration.macAddress))!, created: false };
    },
    get: async (id) => (await db.select().from(devices).where(eq(devices.id, id)))[0],
    getByIdentity: async (identity) => (await db.select().from(devices).where(eq(devices.identity, identity)))[0],
    list: (limit) => db.select().from(devices).orderBy(desc(devices.id)).limit(limit),
    markFlashed: async (id, firmwareVersion) =>
      (
        await db
          .update(devices)
          .set({ firmwareVersion, lastFlashedAt: new Date(), flashCount: sql`${devices.flashCount} + 1` })
          .where(eq(devices.id, id))
          .returning()
      )[0],
  };
}
