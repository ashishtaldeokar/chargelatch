import { useCallback, useEffect, useRef, useState } from "react";
import type { Device, FactoryApi, RegisteredDevice } from "./lib/api.ts";
import type { ChipInfo, DeviceConnection } from "./lib/connection.ts";
import type { Firmware } from "./lib/firmware.ts";
import { provisionDevice, STEPS, type Step } from "./lib/workflow.ts";

interface StationProps {
  api: FactoryApi;
  connect: (log: (line: string) => void) => Promise<DeviceConnection>;
  loadFirmware: () => Promise<Firmware>;
}

type Run =
  | { state: "idle" }
  | { state: "running" | "done" | "failed"; step?: Step; chip?: ChipInfo; device?: RegisteredDevice; error?: string };

const formatBytes = (bytes: number) => (bytes >= 1 << 20 ? `${(bytes / (1 << 20)).toFixed(0)} MB` : `${(bytes / 1024).toFixed(0)} KB`);

export function Station({ api, connect, loadFirmware }: StationProps) {
  const [firmware, setFirmware] = useState<Firmware | null>(null);
  const [firmwareError, setFirmwareError] = useState<string | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [eraseAll, setEraseAll] = useState(true);
  const [run, setRun] = useState<Run>({ state: "idle" });
  const [progress, setProgress] = useState<{ name: string; percent: number } | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const logRef = useRef<HTMLPreElement>(null);

  const appendLog = useCallback((line: string) => setLog((lines) => [...lines.slice(-400), line]), []);
  const refreshDevices = useCallback(() => api.listDevices().then(setDevices, (e: Error) => appendLog(`! ${e.message}`)), [api, appendLog]);

  useEffect(() => {
    loadFirmware().then(setFirmware, (e: Error) => setFirmwareError(e.message));
    void refreshDevices();
  }, [loadFirmware, refreshDevices]);

  useEffect(() => {
    logRef.current?.scrollTo(0, logRef.current.scrollHeight);
  }, [log]);

  async function flash() {
    if (!firmware) return;
    setLog([]);
    setProgress(null);
    setRun({ state: "running" });

    let connection: DeviceConnection | undefined;
    try {
      // Must be the first await: the browser's port picker needs the click's user activation.
      connection = await connect(appendLog);
      const chip = connection.info;
      setRun({ state: "running", chip });
      appendLog(`Connected: ${chip.chipType} ${chip.macAddress}`);

      await provisionDevice({
        connection,
        api,
        firmware,
        eraseAll,
        events: {
          onStep: (step) => setRun((current) => ({ ...current, state: "running", step })),
          onRegistered: (device) => {
            setRun((current) => ({ ...current, state: "running", device }));
            appendLog(device.created ? `Issued new identity ${device.identity}` : `Known device, reusing ${device.identity}`);
          },
          onFlashProgress: (file, p) => setProgress({ name: file.name, percent: Math.round((p.written / p.total) * 100) }),
        },
      });
      setRun((current) => ({ ...current, state: "done" }));
      appendLog("Done.");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Closing the port picker is not a failure worth shouting about.
      if (error instanceof DOMException && error.name === "NotFoundError") setRun({ state: "idle" });
      else setRun((current) => ({ ...current, state: "failed", error: message }));
      appendLog(`! ${message}`);
    } finally {
      await connection?.disconnect().catch(() => {});
      void refreshDevices();
    }
  }

  const running = run.state === "running";
  const active = run.state !== "idle" ? run : undefined;
  const stepIndex = active?.step ? STEPS.findIndex((s) => s.id === active.step) : -1;

  return (
    <div className="grid">
      <section className="card station">
        <div className="firmware">
          {firmware ? (
            <>
              <strong>
                {firmware.manifest.name} {firmware.manifest.version}
              </strong>
              <span className="muted">
                {firmware.manifest.chip} · built {new Date(firmware.manifest.builtAt).toLocaleString()} · identity at 0x
                {firmware.factoryPartition.offset.toString(16)}
              </span>
            </>
          ) : (
            <span role={firmwareError ? "alert" : undefined}>{firmwareError ?? "Loading firmware…"}</span>
          )}
        </div>

        <div className={`identity ${active?.state ?? "idle"}`} aria-live="polite">
          <span className="label">Device identity</span>
          <span className="value" data-testid="identity">
            {active?.device?.identity ?? "—"}
          </span>
          {active?.device && <span className="muted">{active.device.created ? "newly issued" : `known device · flashed ${active.device.flashCount}× before`}</span>}
        </div>

        {active?.chip && (
          <dl className="chip">
            <dt>MAC</dt>
            <dd>{active.chip.macAddress}</dd>
            <dt>Chip</dt>
            <dd>
              {active.chip.chipType} {active.chip.chipRevision && `(${active.chip.chipRevision})`}
            </dd>
            <dt>Flash</dt>
            <dd>{active.chip.flashSizeBytes ? formatBytes(active.chip.flashSizeBytes) : "unknown"}</dd>
            <dt>Features</dt>
            <dd>{active.chip.chipFeatures.join(", ")}</dd>
          </dl>
        )}

        {active && (
          <ol className="steps">
            {STEPS.filter((s) => eraseAll || s.id !== "erase").map((step) => {
              const index = STEPS.findIndex((s) => s.id === step.id);
              const status = active.state === "done" || index < stepIndex ? "complete" : index === stepIndex ? (active.state === "failed" ? "failed" : "current") : "pending";
              return (
                <li key={step.id} className={status}>
                  {step.label}
                  {step.id === "flash" && status === "current" && progress && (
                    <span className="progress">
                      <progress max={100} value={progress.percent} /> {progress.name} {progress.percent}%
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        )}

        {active?.state === "failed" && <p role="alert">{active.error}</p>}
        {active?.state === "done" && <p className="success">Flashed and verified. Label the unit {active.device?.identity}, then connect the next one.</p>}

        <div className="actions">
          <button className="primary" onClick={() => void flash()} disabled={!firmware || running}>
            {running ? "Flashing…" : run.state === "idle" ? "Connect & flash device" : "Flash next device"}
          </button>
          <label>
            <input type="checkbox" checked={eraseAll} disabled={running} onChange={(e) => setEraseAll(e.target.checked)} /> Erase entire flash first
          </label>
        </div>

        <details open={run.state === "failed"}>
          <summary>Flasher log</summary>
          <pre ref={logRef} className="log">
            {log.join("\n")}
          </pre>
        </details>
      </section>

      <section className="card">
        <h2>Recent devices</h2>
        {devices.length === 0 ? (
          <p className="muted">No devices yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Identity</th>
                <th>MAC</th>
                <th>Chip</th>
                <th>Firmware</th>
                <th>Flashes</th>
                <th>Last flashed</th>
              </tr>
            </thead>
            <tbody>
              {devices.map((device) => (
                <tr key={device.id}>
                  <td>
                    <strong>{device.identity}</strong>
                  </td>
                  <td>
                    <code>{device.macAddress}</code>
                  </td>
                  <td>{device.chipType}</td>
                  <td>{device.firmwareVersion ?? "—"}</td>
                  <td>{device.flashCount}</td>
                  <td>{device.lastFlashedAt ? new Date(device.lastFlashedAt).toLocaleString() : "never"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
