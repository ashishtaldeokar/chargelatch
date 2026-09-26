# telemetry

Subscribes to every device on the MQTT broker and stores what they publish in TimescaleDB.

| MQTT                   | Table                | Retention | Notes                                                       |
| ---------------------- | -------------------- | --------- | ----------------------------------------------------------- |
| `devices/+/meter`      | `meter_readings`     | **30 days** | one row per reading; known fields in columns, the rest in `extra` jsonb; failed reads stored with `ok=false`, `error` |
| `devices/+/status`     | `device_events`      | none      | `online` (detail = firmware) / `offline`, on **change** only |
| `devices/+/relay`      | `device_events`      | none      | `relay_on` / `relay_off` (detail = request id), on change only |
| (job, every 15 min)    | `meter_readings_15m` | none      | per device per 15-min bucket, see below                     |

`time` is when the message was received: devices have no clock. Only devices in the registry
(`devices` table, refreshed every minute) are recorded; anything else on the anonymous broker is
dropped. Rows are written in batches (200 rows or 2 s); on a database outage they are retried,
bounded at 50 000 buffered rows (oldest dropped first).

```sh
pnpm db:migrate                                     # hypertables, retention, job (packages/db)
pnpm --filter @chargelatch/telemetry dev            # needs DATABASE_URL + MQTT_URL in .env
pm2 start apps/telemetry/ecosystem.config.cjs       # production: ONE instance
```

## The 15-minute aggregate

`meter_readings_15m` is filled by the Postgres function `aggregate_meter_readings(lookback)`,
scheduled with Timescale's job runner (`aggregate_meter_readings_job`, every 15 min, one minute
past the quarter hour). It is a **plain table + scheduled SQL, not a continuous aggregate**, on
purpose: a continuous aggregate must be dropped and rebuilt to change its definition, and once the
raw rows have expired that history is gone. A normal table takes `ALTER TABLE`.

Per device and bucket: `samples`, `failed_samples`, avg/min/max of `power`, `voltage`, `current`,
avg `power_factor` and `frequency`, `energy_wh` (last `total_energy` − first, ×1000; the meter's
own counter, so it is exact even with missed samples) and `total_energy_end`.

Buckets are clock-aligned (`time_bucket` snaps to :00/:15/:30/:45) and the job runs on a fixed
schedule one minute past each quarter hour, so neither bucket edges nor run times drift. Which
buckets a run covers does not depend on the clock at all: it starts one bucket before the newest
already-aggregated one (absorbing late rows) and stops at the current, open bucket. A late or
missed run therefore catches up on everything since the last one; nothing is skipped. Upserts, so
re-running is harmless.

```sql
select aggregate_meter_readings();                              -- run by hand (returns buckets written)
select aggregate_meter_readings(now() - interval '30 days');   -- backfill from a point in time, e.g. after a schema change
select * from timescaledb_information.job_stats
  where job_id = (select job_id from timescaledb_information.jobs where proc_name = 'aggregate_meter_readings_job');
```

**Changing the aggregate:** add the column to `meter_readings_15m` in a migration (`ALTER TABLE`),
`CREATE OR REPLACE` the function to fill it, then backfill with the call above while the raw data
still exists. Existing rows and columns are untouched.

## Charging transactions and webhooks

This service is the **system of record** for transactions: the API only creates them
(`starting`) and flags stops (`stopping`); every other transition comes from the device's
`tx`, `tx/end` and `tx/meter` messages (`src/transactions.ts`), and each transition writes the
tenant's event into the `webhook_deliveries` outbox in the same flow. `src/webhooks.ts` delivers
the outbox: per tenant, in creation order, where an undelivered event blocks only later events of
the *same* transaction. `TransactionStarted`/`Stopped`/`Failed` retry with backoff
(1 min → 5 → 30 → 2 h → 6 h → 24 h, then `failed`); `MeterValues` get one attempt.

| Device says | Row was | Result |
| --- | --- | --- |
| `tx` active T | `starting` | `active`, `startedAt`, **TransactionStarted** |
| `tx` active T | `stopping` | stop re-sent (a stop queued while the device was offline) |
| `tx` active T | `failed` or unknown | stop sent: nothing charges that the backend thinks is over |
| `tx/end` T | any open | `stopped`, summary (device energy + stats over its `meter_readings`), **TransactionStopped** |
| `tx/meter` T | `active`/`stopping` | **MeterValues** (best effort) |
| (sweep, 15 s) | `starting` > 60 s | `failed`, **TransactionFailed** |

Webhook payload, one shape for every event:

```json
{ "eventType": "TransactionStopped", "eventId": "…", "sequence": 3, "occurredAt": "…",
  "tenantId": "sonik", "deviceIdentity": "SONIK-42", "transactionId": "TX-2026-000123",
  "data": { "startedAt": "…", "stoppedAt": "…", "durationSeconds": 1820, "stopReason": "remote",
            "energyWh": 7420.5, "energyQuality": "metered", "meterStartKwh": 1234.75, "meterStopKwh": 1242.17,
            "powerAvgW": 6900, "powerMaxW": 7200, "currentMaxA": 31.3, "voltageMinV": 229, "voltageMaxV": 231,
            "sampleCount": 364, "meterUnreadableSamples": 0 } }
```

`sequence` counts per transaction from 1. A 2xx response is the acknowledgement; anything else
is retried. No signature yet (decided later); an `X-Chargelatch-Signature` HMAC is the planned
addition.
