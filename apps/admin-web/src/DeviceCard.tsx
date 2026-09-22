import { useEffect, useState } from "react";
import type { LiveDevice } from "./api.ts";
import { splitReadings } from "./meter.ts";

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
}

export function DeviceCard({ device, setRelay }: DeviceCardProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const now = useNow(5000);

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

  const meter = device.meter;
  const stale = meter ? now - Date.parse(meter.receivedAt) > STALE_AFTER_MS : false;
  const readings = meter ? splitReadings(meter.values) : null;

  return (
    <article className="card device" aria-label={device.identity}>
      <header>
        <div>
          <h3>{device.identity}</h3>
          <span className="muted">
            {device.macAddress} · firmware {device.firmware ?? device.firmwareVersion ?? "unknown"}
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
      {pending && <p className="muted">Waiting for the device to confirm…</p>}
      {error && <p role="alert">{error}</p>}
      {!online && <p className="muted">The contactor can only be switched while the device is online.</p>}

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
