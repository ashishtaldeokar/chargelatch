// The MQTT contract between devices and everything that listens to them (the API and the
// admin-web portal). Pure TypeScript with no dependencies, so it runs in Bun and in the browser.
//
//   devices/<id>/status     retained  {"online":true,"firmware":"0.1.0"} | last will {"online":false}
//   devices/<id>/relay      retained  {"on":true,"id":"<request id>"}
//   devices/<id>/meter                {"model":"SDM120","ok":true,"voltage":230.5,...} every few seconds
//   devices/<id>/cmd/relay  -> device {"on":true,"id":"<request id>"}     (never retained)
//
// Firmware side: apps/firmware/components/{device_mqtt,relay_control,meter_telemetry}.

export interface MeterReading {
  model: string;
  phases: number;
  ok: boolean;
  error?: string;
  /** Field names come from the firmware's register table: voltage, current, power, ... */
  values: Record<string, number>;
  receivedAt: string;
}

export interface RelayState {
  on: boolean;
  updatedAt: string;
}

export interface LiveDeviceState {
  identity: string;
  /** null until the device has been heard from. */
  online: boolean | null;
  firmware: string | null;
  relay: RelayState | null;
  meter: MeterReading | null;
}

export type DeviceMessageKind = "status" | "relay" | "meter";

/** Subscribe to these to follow every device. */
export const DEVICE_STATE_TOPICS = ["devices/+/status", "devices/+/relay", "devices/+/meter"];

export const relayCommandTopic = (identity: string) => `devices/${identity}/cmd/relay`;

export const emptyDeviceState = (identity: string): LiveDeviceState => ({ identity, online: null, firmware: null, relay: null, meter: null });

const STATE_TOPIC = /^devices\/([^/]+)\/(status|relay|meter)$/;

export function parseDeviceTopic(topic: string): { identity: string; kind: DeviceMessageKind } | null {
  const match = STATE_TOPIC.exec(topic);
  return match ? { identity: match[1]!, kind: match[2] as DeviceMessageKind } : null;
}

/** JSON.parse that returns undefined for anything that is not valid JSON. */
export function parsePayload(payload: string): unknown {
  try {
    return JSON.parse(payload);
  } catch {
    return undefined;
  }
}

/**
 * Pure reducer: applies one device message to a device's state. Returns null for anything
 * unusable. Payloads are UNTRUSTED: the broker is anonymous, so anyone can publish anything.
 */
export function applyMessage(state: LiveDeviceState, kind: string, payload: unknown, now: Date): LiveDeviceState | null {
  if (typeof payload !== "object" || payload === null) return null;
  const data = payload as Record<string, unknown>;

  switch (kind) {
    case "status":
      if (typeof data.online !== "boolean") return null;
      return { ...state, online: data.online, firmware: typeof data.firmware === "string" ? data.firmware : state.firmware };
    case "relay":
      if (typeof data.on !== "boolean") return null;
      return { ...state, relay: { on: data.on, updatedAt: now.toISOString() } };
    case "meter": {
      const { model, phases, ok, error, ...rest } = data;
      if (typeof model !== "string" || typeof ok !== "boolean") return null;
      const values = Object.fromEntries(Object.entries(rest).filter((entry): entry is [string, number] => typeof entry[1] === "number"));
      return {
        ...state,
        // A device that sends readings is evidently online, even if its retained status was lost.
        online: true,
        meter: { model, phases: typeof phases === "number" ? phases : 1, ok, error: typeof error === "string" ? error : undefined, values, receivedAt: now.toISOString() },
      };
    }
    default:
      return null;
  }
}
