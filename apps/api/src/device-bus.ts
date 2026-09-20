// Live device state and commands, bridged from MQTT. Topic contract (see the firmware's
// device_mqtt, relay_control and meter_telemetry components):
//
//   devices/<id>/status     retained  {"online":true,"firmware":"0.1.0"} | last will {"online":false}
//   devices/<id>/relay      retained  {"on":true,"id":"<request id>"}
//   devices/<id>/meter                {"model":"SDM120","ok":true,"voltage":230.5,...} every few seconds
//   devices/<id>/cmd/relay  <- us     {"on":true,"id":"<request id>"}
import mqtt, { type MqttClient } from "mqtt";

export interface MeterReading {
  model: string;
  phases: number;
  ok: boolean;
  error?: string;
  /** Field names come from the firmware's register table: voltage, current, power, ... */
  values: Record<string, number>;
  receivedAt: string;
}

export interface LiveDeviceState {
  identity: string;
  /** null until the device has been heard from since the API (re)connected to the broker. */
  online: boolean | null;
  firmware: string | null;
  relay: { on: boolean; updatedAt: string } | null;
  meter: MeterReading | null;
}

export class DeviceOfflineError extends Error {
  constructor(identity: string) {
    super(`${identity} is offline`);
  }
}

export class DeviceTimeoutError extends Error {
  constructor(identity: string) {
    super(`${identity} did not confirm the command in time`);
  }
}

export class BusUnavailableError extends Error {
  constructor() {
    super("Not connected to the MQTT broker");
  }
}

export interface DeviceBus {
  getState(identity: string): LiveDeviceState;
  /**
   * Switches the relay and resolves with the state the DEVICE reports back, so a resolved
   * promise means the contactor really was switched.
   * @throws DeviceOfflineError | DeviceTimeoutError | BusUnavailableError
   */
  setRelay(identity: string, on: boolean): Promise<{ on: boolean; updatedAt: string }>;
  /** Calls `listener` with the full new state whenever anything about a device changes. */
  subscribe(listener: (state: LiveDeviceState) => void): () => void;
}

const emptyState = (identity: string): LiveDeviceState => ({ identity, online: null, firmware: null, relay: null, meter: null });

/** Pure reducer: applies one MQTT message to a device's state. Returns null for anything unusable. */
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

const TOPIC = /^devices\/([^/]+)\/(status|relay|meter)$/;

export interface MqttDeviceBusOptions {
  url: string;
  /** How long setRelay waits for the device to report the new state. */
  commandTimeoutMs?: number;
  clientId?: string;
}

export class MqttDeviceBus implements DeviceBus {
  private readonly states = new Map<string, LiveDeviceState>();
  private readonly listeners = new Set<(state: LiveDeviceState) => void>();
  private readonly pending = new Map<string, (relay: { on: boolean; updatedAt: string }) => void>();
  private readonly client: MqttClient;
  private readonly commandTimeoutMs: number;

  constructor({ url, commandTimeoutMs = 5000, clientId }: MqttDeviceBusOptions) {
    this.commandTimeoutMs = commandTimeoutMs;
    this.client = mqtt.connect(url, {
      clientId: clientId ?? `chargelatch-api-${crypto.randomUUID().slice(0, 8)}`,
      reconnectPeriod: 2000,
      // Retained status/relay messages rebuild the state after a restart; nothing to resume.
      clean: true,
    });
    this.client.on("connect", () => {
      this.client.subscribe(["devices/+/status", "devices/+/relay", "devices/+/meter"], { qos: 1 });
    });
    this.client.on("error", (error) => console.error(`mqtt: ${error.message}`));
    this.client.on("message", (topic, payload) => this.onMessage(topic, payload));
  }

  /** Resolves once connected and subscribed. Optional: the bus also works if the broker comes up later. */
  ready(): Promise<void> {
    if (this.client.connected) return Promise.resolve();
    return new Promise((resolve) => this.client.once("connect", () => resolve()));
  }

  close(): Promise<void> {
    return this.client.endAsync(true);
  }

  getState(identity: string): LiveDeviceState {
    return this.states.get(identity) ?? emptyState(identity);
  }

  subscribe(listener: (state: LiveDeviceState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async setRelay(identity: string, on: boolean): Promise<{ on: boolean; updatedAt: string }> {
    if (!this.client.connected) throw new BusUnavailableError();
    // Known to be offline: fail fast instead of making the caller wait for the timeout.
    if (this.getState(identity).online === false) throw new DeviceOfflineError(identity);

    const id = crypto.randomUUID();
    const confirmed = new Promise<{ on: boolean; updatedAt: string }>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new DeviceTimeoutError(identity));
      }, this.commandTimeoutMs);
      this.pending.set(id, (relay) => {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve(relay);
      });
    });
    // If publishing fails, the rejection below wins and the timer is left to clean up.
    confirmed.catch(() => {});

    // NOT retained: a command must never be replayed to a device that reconnects later.
    await this.client.publishAsync(`devices/${identity}/cmd/relay`, JSON.stringify({ on, id }), { qos: 1, retain: false });
    return confirmed;
  }

  private onMessage(topic: string, payload: Buffer): void {
    const match = TOPIC.exec(topic);
    if (!match) return;
    const [, identity, kind] = match as unknown as [string, string, string];

    let data: unknown;
    try {
      data = JSON.parse(payload.toString());
    } catch {
      return;
    }
    const next = applyMessage(this.getState(identity), kind, data, new Date());
    if (!next) return;
    this.states.set(identity, next);

    if (kind === "relay" && next.relay) {
      const id = (data as { id?: unknown }).id;
      if (typeof id === "string") this.pending.get(id)?.(next.relay);
    }
    for (const listener of this.listeners) listener(next);
  }
}
