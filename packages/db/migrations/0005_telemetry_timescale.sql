-- Hypertables, retention and the aggregation job for the telemetry tables created in 0004.
-- Plain hypertable + a scheduled SQL function, deliberately NOT a continuous aggregate:
-- altering a continuous aggregate means dropping and rebuilding it, which loses history once
-- the raw data has expired. A normal table survives ALTER TABLE.

SELECT create_hypertable('meter_readings', by_range('time', INTERVAL '1 day'));--> statement-breakpoint
SELECT create_hypertable('device_events', by_range('time', INTERVAL '7 days'));--> statement-breakpoint
SELECT create_hypertable('meter_readings_15m', by_range('bucket', INTERVAL '30 days'));--> statement-breakpoint

CREATE INDEX meter_readings_device_time_idx ON meter_readings (device_id, "time" DESC);--> statement-breakpoint
CREATE INDEX device_events_device_time_idx ON device_events (device_id, "time" DESC);--> statement-breakpoint
-- One aggregate row per device per bucket; the job upserts on this.
CREATE UNIQUE INDEX meter_readings_15m_device_bucket_idx ON meter_readings_15m (device_id, bucket);--> statement-breakpoint

-- Raw readings expire after 30 days (device_events and the aggregate never do).
SELECT add_retention_policy('meter_readings', drop_after => INTERVAL '30 days');--> statement-breakpoint

-- Rolls raw readings up into closed 15-minute buckets (clock-aligned: time_bucket snaps to
-- :00/:15/:30/:45, so bucket edges never depend on when this runs).
--
-- Which buckets get (re)computed does not depend on the wall clock either: by default it starts
-- one bucket before the newest bucket already in meter_readings_15m (so rows that arrived after
-- that bucket first closed are absorbed) and stops at the current, still-open bucket. A run that
-- is late, or skipped while the database was down, simply catches up on the next run: nothing is
-- ever left out. Upserts, so re-running is harmless. Returns the number of buckets written.
--
-- `since` overrides the start, e.g. for a backfill after adding a column:
--   select aggregate_meter_readings(now() - interval '30 days');
CREATE OR REPLACE FUNCTION aggregate_meter_readings(since TIMESTAMPTZ DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql AS $fn$
DECLARE
  window_start timestamptz;
  window_end   timestamptz := time_bucket(INTERVAL '15 minutes', now());  -- start of the open bucket
  written      integer;
BEGIN
  IF since IS NOT NULL THEN
    window_start := time_bucket(INTERVAL '15 minutes', since);
  ELSE
    SELECT max(bucket) - INTERVAL '15 minutes' INTO window_start FROM meter_readings_15m;
    IF window_start IS NULL THEN
      -- Nothing aggregated yet: start with the oldest raw reading.
      SELECT time_bucket(INTERVAL '15 minutes', min("time")) INTO window_start FROM meter_readings;
    END IF;
  END IF;
  IF window_start IS NULL OR window_start >= window_end THEN
    RETURN 0;
  END IF;

  WITH agg AS (
    SELECT
      time_bucket(INTERVAL '15 minutes', "time") AS bucket,
      device_id,
      count(*)::int                       AS samples,
      count(*) FILTER (WHERE NOT ok)::int AS failed_samples,
      avg(power)::real,  min(power)::real,  max(power)::real,
      avg(voltage)::real, min(voltage)::real, max(voltage)::real,
      avg(current)::real, min(current)::real, max(current)::real,
      avg(power_factor)::real,
      avg(frequency)::real,
      -- Energy consumed in the bucket, from the meter's own cumulative counter (kWh -> Wh).
      CASE WHEN count(total_energy) >= 2
           THEN ((last(total_energy, "time") - first(total_energy, "time")) * 1000)::real
      END                                 AS energy_wh,
      last(total_energy, "time")          AS total_energy_end
    FROM meter_readings
    WHERE "time" >= window_start
      AND "time" <  window_end                                     -- only closed buckets
    GROUP BY 1, 2
  )
  INSERT INTO meter_readings_15m (
    bucket, device_id, samples, failed_samples,
    power_avg, power_min, power_max,
    voltage_avg, voltage_min, voltage_max,
    current_avg, current_min, current_max,
    power_factor_avg, frequency_avg, energy_wh, total_energy_end)
  SELECT * FROM agg
  ON CONFLICT (device_id, bucket) DO UPDATE SET
    samples = EXCLUDED.samples, failed_samples = EXCLUDED.failed_samples,
    power_avg = EXCLUDED.power_avg, power_min = EXCLUDED.power_min, power_max = EXCLUDED.power_max,
    voltage_avg = EXCLUDED.voltage_avg, voltage_min = EXCLUDED.voltage_min, voltage_max = EXCLUDED.voltage_max,
    current_avg = EXCLUDED.current_avg, current_min = EXCLUDED.current_min, current_max = EXCLUDED.current_max,
    power_factor_avg = EXCLUDED.power_factor_avg, frequency_avg = EXCLUDED.frequency_avg,
    energy_wh = EXCLUDED.energy_wh, total_energy_end = EXCLUDED.total_energy_end;
  GET DIAGNOSTICS written = ROW_COUNT;
  RETURN written;
END;
$fn$;--> statement-breakpoint

-- Timescale's job runner calls this signature.
CREATE OR REPLACE FUNCTION aggregate_meter_readings_job(job_id int, config jsonb)
RETURNS void
LANGUAGE plpgsql AS $fn$
BEGIN
  PERFORM aggregate_meter_readings();
END;
$fn$;--> statement-breakpoint

-- Runs one minute past every quarter hour (:01, :16, :31, :46), so the bucket that just closed is
-- included. fixed_schedule keeps runs on initial_start + n * 15 min regardless of how long each
-- run takes (the default would schedule from the previous run's finish and drift). Timescale
-- persists the schedule: it survives restarts, and missed runs are caught up by the watermark.
SELECT add_job(
  'aggregate_meter_readings_job',
  schedule_interval => INTERVAL '15 minutes',
  initial_start     => date_trunc('hour', now()) + INTERVAL '1 minute'
                       + (floor(extract(minute FROM now()) / 15) + 1) * INTERVAL '15 minutes',
  fixed_schedule    => true
);
