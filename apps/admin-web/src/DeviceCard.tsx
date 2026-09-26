import { useEffect, useState } from "react";
import type { Api, LiveDevice, Tenant } from "./api.ts";
import { splitReadings } from "./meter.ts";
import { PowerChart } from "./PowerChart.tsx";
import { appendPoint, fromHistory, trim, WINDOW_MS, type PowerPoint } from "./power-series.ts";

/** Readings arrive every 5 s; after this long without one the numbers are no longer "now". */
const STALE_AFTER_MS = 20_000;

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

interface DeviceCardProps {
  device: LiveDevice;
  setRelay: (on: boolean) => Promise<unknown>;
  recentPower: Api["recentPower"];
  tenants: Tenant[];
  assignTenant: (tenantId: string | null) => Promise<void>;
}

export function DeviceCard({ device, setRelay, recentPower, tenants, assignTenant }: DeviceCardProps) {
  const [assignError, setAssignError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const now = useNow(5000);
  const [power, setPower] = useState<PowerPoint[]>([]);

  // Seed the chart from stored readings once; live meter messages extend it from there.
  useEffect(() => {
    let active = true;
    recentPower(device.identity, WINDOW_MS / 60_000).then(
      (samples) => active && setPower((live) => fromHistory(samples).concat(live.filter((p) => !samples.some((s) => Date.parse(s.time) >= p.time)))),
      () => {},
    );
    return () => {
      active = false;
    };
  }, [device.identity, recentPower]);

  const meter = device.meter;
  useEffect(() => {
    if (!meter) return;
    const time = Date.parse(meter.receivedAt);
    setPower((points) => appendPoint(points, { time, power: meter.ok && typeof meter.values.power === "number" ? meter.values.power : null }, time));
  }, [meter]);
  const chartPoints = trim(power, now);

  const online = device.online === true;
  const relayOn = device.relay?.on ?? false;
  const status = device.online === null ? "unknown" : online ? "online" : "offline";

  async function toggle() {
    setPending(true);
    setError(null);
    try {
      // The switch does not move optimistically: it follows the state the device itself publishes
      // (devices/<id>/relay, over MQTT), because this is a contactor, not a checkbox.
      await setRelay(!relayOn);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  }

  const stale = meter ? now - Date.parse(meter.receivedAt) > STALE_AFTER_MS : false;
  const readings = meter ? splitReadings(meter.values) : null;

  return (
    <article className="card device" aria-label={device.identity}>
      <header>
        <div>
          <h3>{device.identity}</h3>
          <span className="muted">
            {device.macAddress} · firmware {device.firmware ?? device.firmwareVersion ?? "unknown"}
            {device.meterConfig && ` · ${device.meterConfig.model} @${device.meterConfig.address}`}
          </span>
        </div>
        <span className={`badge ${status}`}>{status}</span>
      </header>

      <div className="relay">
        <div>
          <strong>Contactor</strong>
          <span className="muted" data-testid="relay-state">
            {device.relay ? (relayOn ? "Closed (on)" : "Open (off)") : "State unknown"}
          </span>
        </div>
        <button
          role="switch"
          aria-checked={relayOn}
          aria-label={`${device.identity} contactor`}
          className={`switch ${relayOn ? "on" : ""}`}
          disabled={!online || pending}
          onClick={() => void toggle()}
        >
          <span />
        </button>
      </div>
      {device.transaction?.active && (
        <p className="muted">
          Charging transaction <code>{device.transaction.txId}</code> in progress
        </p>
      )}
      {pending && <p className="muted">Waiting for the device to confirm…</p>}
      {error && <p role="alert">{error}</p>}
      {!online && <p className="muted">The contactor can only be switched while the device is online.</p>}

      <label className="tenant">
        Tenant
        <select
          value={device.tenantId ?? ""}
          aria-label={`${device.identity} tenant`}
          onChange={(e) => {
            setAssignError(null);
            assignTenant(e.target.value || null).catch((err: Error) => setAssignError(err.message));
          }}
        >
          <option value="">— none —</option>
          {tenants.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} ({t.id})
            </option>
          ))}
        </select>
      </label>
      {assignError && <p role="alert">{assignError}</p>}

      <section className={`meter ${stale || !online ? "stale" : ""}`}>
        {!meter && <p className="muted">No meter readings yet.</p>}
        {meter && !meter.ok && (
          <p role="alert">
            Meter not readable ({meter.error ?? "error"}){readings && readings.primary.length > 0 ? ": showing the values that did arrive." : "."}
          </p>
        )}
        {readings && readings.primary.length > 0 && (
          <dl className="primary">
            {readings.primary.map((value) => (
              <div key={value.key}>
                <dt>{value.label}</dt>
                <dd>{value.text}</dd>
              </div>
            ))}
          </dl>
        )}
        <PowerChart points={chartPoints} now={now} windowMs={WINDOW_MS} />
        {readings && readings.rest.length > 0 && (
          <details>
            <summary>All readings ({meter!.model})</summary>
            <dl className="rest">
              {readings.rest.map((value) => (
                <div key={value.key}>
                  <dt>{value.label}</dt>
                  <dd>{value.text}</dd>
                </div>
              ))}
            </dl>
          </details>
        )}
        {meter && (
          <p className="muted updated">
            {stale ? "Last reading " : "Updated "}
            {new Date(meter.receivedAt).toLocaleTimeString()}
            {stale && ": no longer live"}
          </p>
        )}
      </section>
    </article>
  );
}
