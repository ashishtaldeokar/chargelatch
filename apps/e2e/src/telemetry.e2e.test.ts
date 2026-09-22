// The telemetry pipeline against the real pieces: fake device -> EMQX -> Ingester + BatchWriter ->
// TimescaleDB hypertables -> the 15-minute aggregation function.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb, schema } from "@chargelatch/db";
import { runMigrations } from "@chargelatch/db/migrate";
import { DEVICE_STATE_TOPICS } from "@chargelatch/device-protocol";
import { Ingester } from "@chargelatch/telemetry";
import { BatchWriter } from "@chargelatch/telemetry/writer";
import { SQL } from "bun";
import { sql } from "drizzle-orm";
import mqtt, { type MqttClient } from "mqtt";
import { startEmqx, type StartedEmqx } from "./helpers/emqx.ts";
import { startFakeDevice, type FakeDevice } from "./helpers/fake-device.ts";
import { startPostgres, type StartedPostgres } from "./helpers/postgres.ts";

let postgres: StartedPostgres;
let emqx: StartedEmqx;
let db: ReturnType<typeof createDb>["db"];
let closeDb: () => Promise<void>;
let raw: SQL;
let subscriber: MqttClient;
let writer: BatchWriter;
let device: FakeDevice;
let deviceId: number;

async function eventually(check: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

beforeAll(async () => {
  [postgres, emqx] = await Promise.all([startPostgres(), startEmqx()]);
  await runMigrations(postgres.url());
  ({ db, close: closeDb } = createDb(postgres.url()));
  raw = new SQL(postgres.url());

  const [registered] = await db.insert(schema.devices).values({ macAddress: "24:6f:28:aa:bb:01", chipType: "ESP32" }).returning();
  deviceId = registered!.id;

  // The service's core, wired the same way src/index.ts does it, with a fast flush for the test.
  const ingester = new Ingester((identity) => (identity === "SONIK-1" ? deviceId : undefined));
  writer = new BatchWriter(db, { maxDelayMs: 100 });
  subscriber = await mqtt.connectAsync(emqx.mqttUrl, { clientId: "telemetry-e2e" });
  subscriber.on("message", (topic, payload) => {
    const result = ingester.ingest(topic, payload.toString(), new Date());
    if (!result) return;
    if ("reading" in result) writer.addReading(result.reading);
    else writer.addEvent(result.event);
  });
  await subscriber.subscribeAsync(DEVICE_STATE_TOPICS, { qos: 1 });

  device = await startFakeDevice(emqx.mqttUrl, "SONIK-1");
}, 300_000);

afterAll(async () => {
  await device?.stop();
  await subscriber?.endAsync(true);
  await raw?.close();
  await closeDb?.();
  await Promise.all([postgres?.stop(), emqx?.stop()]);
});

describe("ingest", () => {
  test("the device coming online is recorded as an event, once", async () => {
    await eventually(async () => (await db.select().from(schema.deviceEvents)).length > 0, "online event");
    // Status and relay are published back-to-back, often within the same millisecond, so no ordering.
    const events = await db.select().from(schema.deviceEvents);
    expect(events.map((e) => e.kind).sort()).toEqual(["online", "relay_off"]);
    expect(events.find((e) => e.kind === "online")).toMatchObject({ deviceId, detail: "0.1.0" });
  });

  test("meter readings land in the hypertable with their columns", async () => {
    await device.publishMeter({ voltage: 230.5, current: 6.25, power: 1430.4, total_energy: 1234.75, neutral_current: 0.4 });
    await device.publishMeterFailure("timeout");
    await eventually(async () => (await db.select().from(schema.meterReadings)).length >= 2, "readings");

    const rows = await db.select().from(schema.meterReadings);
    expect(rows.find((r) => r.ok)).toMatchObject({ deviceId, model: "SDM120", voltage: 230.5, power: 1430.4, totalEnergy: 1234.75, extra: { neutral_current: 0.4 } });
    expect(rows.find((r) => !r.ok)).toMatchObject({ deviceId, error: "timeout", power: null });
  });

  test("relay changes and going offline are events too", async () => {
    await subscriber.publishAsync("devices/SONIK-1/cmd/relay", JSON.stringify({ on: true, id: "req-1" }), { qos: 1 });
    await eventually(async () => (await db.select().from(schema.deviceEvents)).some((e) => e.kind === "relay_on"), "relay_on event");
    device.dropOffNetwork();
    await eventually(async () => (await db.select().from(schema.deviceEvents)).some((e) => e.kind === "offline"), "offline event");

    const all = await db.select().from(schema.deviceEvents).orderBy(schema.deviceEvents.time);
    expect(all.map((e) => e.kind).sort()).toEqual(["offline", "online", "relay_off", "relay_on"]);
    // Exactly one row per change: the retained re-publishes produced nothing extra.
    expect(all.find((e) => e.kind === "relay_on")).toMatchObject({ detail: "req-1" });
    expect(all.at(-1)!.kind).toBe("offline");
  });
});

describe("timescale", () => {
  test("hypertables, 30-day retention on raw readings only, and the job are in place", async () => {
    const hypertables = await raw`select hypertable_name from timescaledb_information.hypertables order by 1`;
    expect(hypertables.map((h: { hypertable_name: string }) => h.hypertable_name)).toEqual(["device_events", "meter_readings", "meter_readings_15m"]);

    const retention = await raw`select hypertable_name, config->>'drop_after' as drop_after from timescaledb_information.jobs where proc_name = 'policy_retention'`;
    expect(retention).toEqual([{ hypertable_name: "meter_readings", drop_after: "30 days" }]);

    const jobs = await raw`select proc_name, schedule_interval::text as every, scheduled, fixed_schedule, extract(minute from next_start)::int % 15 as minute_past from timescaledb_information.jobs where proc_name = 'aggregate_meter_readings_job'`;
    // Fixed schedule, one minute past the quarter hour: runs never drift with their own duration.
    expect(jobs).toEqual([{ proc_name: "aggregate_meter_readings_job", every: "00:15:00", scheduled: true, fixed_schedule: true, minute_past: 1 }]);
  });

  test("the aggregation function rolls closed 15-minute buckets up, idempotently", async () => {
    // Two closed buckets of readings every 5 s: power ramps, the energy counter climbs 1.2 kWh/h.
    await db.execute(sql`
      insert into meter_readings (time, device_id, model, ok, power, voltage, current, power_factor, frequency, total_energy)
      select t, ${deviceId}, 'SDM120', true,
             1000 + 10 * extract(epoch from t - time_bucket('15 minutes', now() - interval '30 minutes')) / 60,
             230, 4.5, 0.98, 50,
             100 + extract(epoch from t - time_bucket('15 minutes', now() - interval '30 minutes')) / 3600 * 1.2
      from generate_series(time_bucket('15 minutes', now() - interval '30 minutes'), time_bucket('15 minutes', now()) - interval '1 second', interval '5 seconds') t`);

    const [first] = await raw`select aggregate_meter_readings() as written`;
    expect(first.written).toBe(2);
    const [second] = await raw`select aggregate_meter_readings() as written`;
    expect(second.written).toBe(2);

    const buckets = await db.select().from(schema.meterReadings15m).orderBy(schema.meterReadings15m.bucket);
    expect(buckets).toHaveLength(2);
    expect(buckets[0]).toMatchObject({ deviceId, samples: 180, failedSamples: 0, powerMin: 1000, voltageAvg: 230 });
    expect(buckets[0]!.powerAvg).toBeCloseTo(1074.6, 0);
    // 1.2 kWh/h = 300 Wh per bucket, minus the 5 s between the last sample and the bucket edge.
    expect(buckets[0]!.energyWh).toBeCloseTo(298.3, 0);
    expect(buckets[1]!.energyWh).toBeCloseTo(298.3, 0);

    // Missed runs (database down, job late) are caught up by the watermark, not lost: drop the newest
    // aggregate and the next run recomputes it together with the one before it.
    await db.execute(sql`delete from meter_readings_15m where bucket = (select max(bucket) from meter_readings_15m)`);
    const [catchUp] = await raw`select aggregate_meter_readings() as written`;
    expect(catchUp.written).toBe(2);
    expect(await db.select().from(schema.meterReadings15m)).toHaveLength(2);

    // The readings ingested over MQTT earlier sit in the current, still-open bucket: not aggregated.
    const openBucket = await raw`select count(*)::int as n from meter_readings_15m where bucket = time_bucket('15 minutes', now())`;
    expect(openBucket[0].n).toBe(0);

    // The scheduled job wraps the same function; run it by hand (run_job executes it in this
    // session, so it must simply not throw, and must leave the same two buckets).
    const [job] = await raw`select job_id from timescaledb_information.jobs where proc_name = 'aggregate_meter_readings_job'`;
    await raw`call run_job(${job.job_id})`;
    expect(await db.select().from(schema.meterReadings15m)).toHaveLength(2);
  });
});
