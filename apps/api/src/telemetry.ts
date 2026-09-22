import { schema, type Db } from "@chargelatch/db";
import { and, asc, eq, gte } from "drizzle-orm";

/** One power sample. `power` is null where the meter could not be read, which breaks the line. */
export interface PowerSample {
  time: string;
  power: number | null;
}

export interface TelemetryStore {
  /** Power samples for a device since `since`, oldest first. */
  recentPower(deviceId: number, since: Date): Promise<PowerSample[]>;
}

export function createTelemetryStore(db: Db): TelemetryStore {
  const { meterReadings } = schema;
  return {
    recentPower: async (deviceId, since) => {
      const rows = await db
        .select({ time: meterReadings.time, power: meterReadings.power, ok: meterReadings.ok })
        .from(meterReadings)
        .where(and(eq(meterReadings.deviceId, deviceId), gte(meterReadings.time, since)))
        .orderBy(asc(meterReadings.time));
      return rows.map((row) => ({ time: row.time.toISOString(), power: row.ok ? row.power : null }));
    },
  };
}
