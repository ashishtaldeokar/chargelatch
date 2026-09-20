import { useEffect, useState } from "react";
import type { Api, LiveDevice } from "./api.ts";
import { DeviceCard } from "./DeviceCard.tsx";

export function Dashboard({ api }: { api: Api }) {
  const [devices, setDevices] = useState<LiveDevice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);

  useEffect(() => {
    let active = true;
    const load = () =>
      api.listDevices().then(
        (list) => active && (setDevices(list), setError(null)),
        (e: Error) => active && setError(e.message),
      );

    const stop = api.watchDevices(
      (device) =>
        setDevices((current) => {
          if (!current) return current;
          // A device registered after the page loaded arrives here first: add it on top.
          return current.some((d) => d.identity === device.identity)
            ? current.map((d) => (d.identity === device.identity ? device : d))
            : [device, ...current];
        }),
      (connected) => {
        if (!active) return;
        setLive(connected);
        // (Re)connected: anything that changed while the stream was down is only in a fresh list.
        if (connected) void load();
      },
    );
    void load();

    return () => {
      active = false;
      stop();
    };
  }, [api]);

  return (
    <>
      <div className="heading">
        <h2>Devices</h2>
        <span className={`live ${live ? "on" : "off"}`} title={live ? "Receiving live updates" : "Reconnecting to live updates…"}>
          {live ? "Live" : "Reconnecting…"}
        </span>
      </div>
      {error && <p role="alert">{error}</p>}
      {devices === null && !error && <p className="muted">Loading…</p>}
      {devices?.length === 0 && <p className="muted">No devices yet. Flash one with the factory app.</p>}
      <div className="devices">
        {devices?.map((device) => (
          <DeviceCard key={device.identity} device={device} setRelay={(on) => api.setRelay(device.identity, on)} />
        ))}
      </div>
    </>
  );
}
