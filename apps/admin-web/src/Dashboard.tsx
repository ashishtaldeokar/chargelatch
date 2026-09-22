import { applyMessage } from "@chargelatch/device-protocol";
import { useEffect, useRef, useState } from "react";
import type { Api, LiveDevice } from "./api.ts";
import { DeviceCard } from "./DeviceCard.tsx";
import type { LiveFeed } from "./live.ts";

/** How often an identity we do not know may trigger a refetch of the registry. */
const UNKNOWN_DEVICE_REFETCH_MS = 30_000;

export function Dashboard({ api, feed }: { api: Api; feed: LiveFeed }) {
  const [devices, setDevices] = useState<LiveDevice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const known = useRef(new Set<string>());
  const lastRefetch = useRef(0);

  useEffect(() => {
    let active = true;
    const load = () =>
      api.listDevices().then(
        (list) => {
          if (!active) return;
          known.current = new Set(list.map((d) => d.identity));
          // Keep live state that already arrived over MQTT: it is newer than the API's snapshot.
          setDevices((current) => list.map((device) => current?.find((d) => d.identity === device.identity) ?? device));
          setError(null);
        },
        (e: Error) => active && setError(e.message),
      );

    const stop = feed.watch((identity, kind, payload) => {
      if (!known.current.has(identity)) {
        // The broker is anonymous, so only devices from the registry are ever shown. An unknown
        // identity may be a device flashed while this page was open: look once in a while.
        if (Date.now() - lastRefetch.current > UNKNOWN_DEVICE_REFETCH_MS) {
          lastRefetch.current = Date.now();
          void load();
        }
        return;
      }
      setDevices(
        (current) =>
          current?.map((device) => {
            if (device.identity !== identity) return device;
            const next = applyMessage(device, kind, payload, new Date());
            return next ? { ...device, ...next } : device;
          }) ?? current,
      );
    }, (connected) => active && setLive(connected));
    void load();

    return () => {
      active = false;
      stop();
    };
  }, [api, feed]);

  return (
    <>
      <div className="heading">
        <h2>Devices</h2>
        <span className={`live ${live ? "on" : "off"}`} title={live ? "Connected to the MQTT broker" : "Connecting to the MQTT broker…"}>
          {live ? "Live" : "Connecting…"}
        </span>
      </div>
      {error && <p role="alert">{error}</p>}
      {devices === null && !error && <p className="muted">Loading…</p>}
      {devices?.length === 0 && <p className="muted">No devices yet. Flash one with the factory app.</p>}
      <div className="devices">
        {devices?.map((device) => (
          <DeviceCard key={device.identity} device={device} setRelay={(on) => api.setRelay(device.identity, on)} recentPower={api.recentPower} />
        ))}
      </div>
    </>
  );
}
