// The MQTT contract between devices and everything that listens to them (the API and the
// admin-web portal). Pure TypeScript with no dependencies, so it runs in Bun and in the browser.
//
//   devices/<id>/status     retained  {"online":true,"firmware":"0.1.0"} | last will {"online":false}
//   devices/<id>/relay      retained  {"on":true,"id":"<request id>"}
//   devices/<id>/meter                {"model":"SDM120","ok":true,"voltage":230.5,...} every few seconds
//   devices/<id>/cmd/relay  -> device {"on":true,"id":"<request id>","force":false}   (never retained)
//   devices/<id>/tx         retained  {"state":"active","txId","meterStart","interval","id"} | {"state":"idle","id"}
//   devices/<id>/tx/end               {"txId","meterStart","meterStop","energyWh","reason","id"}
//   devices/<id>/tx/meter             {"txId","seq","energyWh","meterKwh","reading":{...}}
//   devices/<id>/cmd/tx     -> device {"op":"start"|"stop","txId","id","interval"}          (never retained)
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
  /** Set when the device refused the last command (e.g. "transaction_active"). */
  rejected?: string;
}

/** The device's own view of its charging transaction (retained devices/<id>/tx). */
export interface TransactionState {
  active: boolean;
  txId: string | null;
  /** kWh counter at start; null if the meter was unreadable then. */
  meterStart: number | null;
  intervalSeconds: number | null;
  updatedAt: string;
}

/** devices/<id>/tx/end */
export interface TransactionEnd {
  txId: string;
  meterStart: number | null;
  meterStop: number | null;
  energyWh: number | null;
  reason: string;
  requestId: string | null;
}

/** devices/<id>/tx/meter */
export interface TransactionMeterValue {
  txId: string;
  seq: number;
  energyWh: number | null;
  meterKwh: number | null;
  reading: MeterReading;
}

export interface LiveDeviceState {
  identity: string;
  /** null until the device has been heard from. */
  online: boolean | null;
  firmware: string | null;
  relay: RelayState | null;
  meter: MeterReading | null;
  transaction: TransactionState | null;
}

export type DeviceMessageKind = "status" | "relay" | "meter" | "tx" | "tx/end" | "tx/meter";

/** Subscribe to these to follow every device. */
export const DEVICE_STATE_TOPICS = ["devices/+/status", "devices/+/relay", "devices/+/meter", "devices/+/tx", "devices/+/tx/end", "devices/+/tx/meter"];

export const relayCommandTopic = (identity: string) => `devices/${identity}/cmd/relay`;
export const transactionCommandTopic = (identity: string) => `devices/${identity}/cmd/tx`;

export const emptyDeviceState = (identity: string): LiveDeviceState => ({ identity, online: null, firmware: null, relay: null, meter: null, transaction: null });

const STATE_TOPIC = /^devices\/([^/]+)\/(status|relay|meter|tx|tx\/end|tx\/meter)$/;

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

const numberOrNull = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Parses a devices/<id>/tx/end payload, or null if it is not one. */
export function parseTransactionEnd(payload: unknown): TransactionEnd | null {
  if (typeof payload !== "object" || payload === null) return null;
  const d = payload as Record<string, unknown>;
  if (typeof d.txId !== "string" || typeof d.reason !== "string") return null;
  return { txId: d.txId, meterStart: numberOrNull(d.meterStart), meterStop: numberOrNull(d.meterStop), energyWh: numberOrNull(d.energyWh), reason: d.reason, requestId: typeof d.id === "string" ? d.id : null };
}

/** Parses a devices/<id>/tx/meter payload, or null if it is not one. */
export function parseTransactionMeterValue(payload: unknown, now: Date): TransactionMeterValue | null {
  if (typeof payload !== "object" || payload === null) return null;
  const d = payload as Record<string, unknown>;
  if (typeof d.txId !== "string" || typeof d.seq !== "number") return null;
  const reading = applyMessage(emptyDeviceState(""), "meter", d.reading, now)?.meter;
  if (!reading) return null;
  return { txId: d.txId, seq: d.seq, energyWh: numberOrNull(d.energyWh), meterKwh: numberOrNull(d.meterKwh), reading };
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
      return { ...state, relay: { on: data.on, updatedAt: now.toISOString(), ...(typeof data.rejected === "string" && { rejected: data.rejected }) } };
    case "tx": {
      if (data.state !== "active" && data.state !== "idle") return null;
      const active = data.state === "active";
      if (active && typeof data.txId !== "string") return null;
      return {
        ...state,
        online: true,
        transaction: {
          active,
          txId: active ? (data.txId as string) : null,
          meterStart: active && typeof data.meterStart === "number" ? data.meterStart : null,
          intervalSeconds: active && typeof data.interval === "number" ? data.interval : null,
          updatedAt: now.toISOString(),
        },
      };
    }
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
