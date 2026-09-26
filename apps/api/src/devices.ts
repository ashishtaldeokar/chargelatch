import { schema, type Db, type Device, type NewDevice } from "@chargelatch/db";
import { desc, eq, sql } from "drizzle-orm";

export interface MeterConfig {
  model: string;
  address: number;
  baud: number;
  parity: "none" | "even" | "odd";
}

export type DeviceRegistration = Pick<NewDevice, "macAddress" | "chipType" | "chipRevision" | "chipFeatures" | "crystalMhz" | "flashSizeBytes"> & {
  meter?: MeterConfig;
};

/** The meter columns as one object, or null when never set. */
export function meterOf(device: Pick<Device, "meterModel" | "meterAddress" | "meterBaud" | "meterParity">): MeterConfig | null {
  if (!device.meterModel || device.meterAddress === null || device.meterBaud === null || !device.meterParity) return null;
  return { model: device.meterModel, address: device.meterAddress, baud: device.meterBaud, parity: device.meterParity as MeterConfig["parity"] };
}

const meterColumns = (meter: MeterConfig | undefined) =>
  meter ? { meterModel: meter.model, meterAddress: meter.address, meterBaud: meter.baud, meterParity: meter.parity } : {};

export interface DeviceStore {
  /** Returns the device for this MAC, creating it (and so issuing its identity) if it is new. */
  register(registration: DeviceRegistration): Promise<{ device: Device; created: boolean }>;
  get(id: number): Promise<Device | undefined>;
  getByIdentity(identity: string): Promise<Device | undefined>;
  list(limit: number): Promise<Device[]>;
  markFlashed(id: number, firmwareVersion: string): Promise<Device | undefined>;
  /** Assigns (or, with null, unassigns) the tenant allowed to run transactions on the device. */
  setTenant(id: number, tenantId: string | null): Promise<Device | undefined>;
  listForTenant(tenantId: string): Promise<Device[]>;
}

export function createDeviceStore(db: Db): DeviceStore {
  const { devices } = schema;
  const byMac = async (macAddress: string) =>
    (await db.select().from(devices).where(eq(devices.macAddress, macAddress)))[0];

  return {
    register: async (registration) => {
      // Look first: a blind upsert would burn a sequence value, and so a SONIK number, on
      // every re-flash of a known device.
      const { meter, ...chip } = registration;
      const existing = await byMac(chip.macAddress);
      if (existing) {
        // A re-flash may wire a different meter: the latest choice wins.
        if (!meter) return { device: existing, created: false };
        const [updated] = await db.update(devices).set(meterColumns(meter)).where(eq(devices.id, existing.id)).returning();
        return { device: updated!, created: false };
      }

      const [created] = await db.insert(devices).values({ ...chip, ...meterColumns(meter) }).onConflictDoNothing().returning();
      if (created) return { device: created, created: true };
      // Lost a race with a concurrent registration of the same MAC.
      return { device: (await byMac(chip.macAddress))!, created: false };
    },
    get: async (id) => (await db.select().from(devices).where(eq(devices.id, id)))[0],
    getByIdentity: async (identity) => (await db.select().from(devices).where(eq(devices.identity, identity)))[0],
    list: (limit) => db.select().from(devices).orderBy(desc(devices.id)).limit(limit),
    setTenant: async (id, tenantId) => (await db.update(devices).set({ tenantId }).where(eq(devices.id, id)).returning())[0],
    listForTenant: (tenantId) => db.select().from(devices).where(eq(devices.tenantId, tenantId)).orderBy(desc(devices.id)),
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
