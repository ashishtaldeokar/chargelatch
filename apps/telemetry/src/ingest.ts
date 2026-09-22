// Turns device MQTT messages into rows. Pure: no I/O, so it is unit-tested directly.
import { applyMessage, emptyDeviceState, parseDeviceTopic, parsePayload, type LiveDeviceState } from "@chargelatch/device-protocol";
import type { DeviceEventRow, MeterReadingRow } from "@chargelatch/db";

/** Meter JSON keys that have their own column. Anything else lands in `extra`. */
const METER_COLUMNS: Record<string, keyof MeterReadingRow> = {
  voltage: "voltage",
  current: "current",
  power: "power",
  apparent_power: "apparentPower",
  reactive_power: "reactivePower",
  power_factor: "powerFactor",
  phase_angle: "phaseAngle",
  frequency: "frequency",
  import_energy: "importEnergy",
  export_energy: "exportEnergy",
  total_energy: "totalEnergy",
  import_reactive_energy: "importReactiveEnergy",
  export_reactive_energy: "exportReactiveEnergy",
  total_reactive_energy: "totalReactiveEnergy",
  voltage_l1: "voltageL1",
  voltage_l2: "voltageL2",
  voltage_l3: "voltageL3",
  current_l1: "currentL1",
  current_l2: "currentL2",
  current_l3: "currentL3",
  power_l1: "powerL1",
  power_l2: "powerL2",
  power_l3: "powerL3",
  power_factor_l1: "powerFactorL1",
  power_factor_l2: "powerFactorL2",
  power_factor_l3: "powerFactorL3",
};

export type IngestResult = { reading: MeterReadingRow } | { event: DeviceEventRow } | null;

/**
 * Keeps the last known state per identity so that only CHANGES become events: every reconnect
 * republishes the retained status/relay messages, and those must not produce duplicate rows.
 */
export class Ingester {
  private readonly states = new Map<string, LiveDeviceState>();

  constructor(private readonly resolveDeviceId: (identity: string) => number | undefined) {}

  ingest(topic: string, payload: string, now: Date): IngestResult {
    const parsed = parseDeviceTopic(topic);
    if (!parsed) return null;
    const { identity, kind } = parsed;

    // The broker is anonymous: only registered devices are recorded.
    const deviceId = this.resolveDeviceId(identity);
    if (deviceId === undefined) return null;

    const previous = this.states.get(identity) ?? emptyDeviceState(identity);
    const data = parsePayload(payload);
    const next = applyMessage(previous, kind, data, now);
    if (!next) return null;
    this.states.set(identity, next);

    switch (kind) {
      case "meter": {
        const meter = next.meter!;
        const reading: MeterReadingRow = { time: now, deviceId, model: meter.model, ok: meter.ok, error: meter.error ?? null };
        const extra: Record<string, number> = {};
        for (const [key, value] of Object.entries(meter.values)) {
          const column = METER_COLUMNS[key];
          if (column) (reading as Record<string, unknown>)[column] = value;
          else extra[key] = value;
        }
        if (Object.keys(extra).length > 0) reading.extra = extra;
        return { reading };
      }
      case "status":
        if (previous.online === next.online) return null;
        return { event: { time: now, deviceId, kind: next.online ? "online" : "offline", detail: next.online ? next.firmware : null } };
      case "relay": {
        if (previous.relay?.on === next.relay!.on) return null;
        const id = (data as { id?: unknown }).id;
        return { event: { time: now, deviceId, kind: next.relay!.on ? "relay_on" : "relay_off", detail: typeof id === "string" ? id : null } };
      }
    }
  }

  /** Forget a device's state, e.g. when it is removed from the registry. */
  forget(identity: string): void {
    this.states.delete(identity);
  }
}
