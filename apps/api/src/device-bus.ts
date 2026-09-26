// Bridges MQTT to the HTTP API: keeps the latest state of every device in memory and sends relay
// commands. The topic contract and the message reducer live in @chargelatch/device-protocol,
// shared with the admin-web portal, which follows the same topics directly over WebSocket.
import {
  applyMessage,
  DEVICE_STATE_TOPICS,
  emptyDeviceState,
  parseDeviceTopic,
  parsePayload,
  relayCommandTopic,
  transactionCommandTopic,
  type LiveDeviceState,
  type RelayState,
} from "@chargelatch/device-protocol";
import mqtt, { type MqttClient } from "mqtt";

export type { LiveDeviceState, MeterReading, RelayState } from "@chargelatch/device-protocol";

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

export class RelayRejectedError extends Error {
  constructor(identity: string, reason: string) {
    super(reason === "transaction_active" ? `${identity} has an active charging transaction; stop it or force` : `${identity} refused: ${reason}`);
  }
}

export interface TransactionCommand {
  op: "start" | "stop";
  txId: string;
  intervalSeconds?: number;
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
  setRelay(identity: string, on: boolean, force?: boolean): Promise<RelayState>;
  /**
   * Sends a transaction command and returns once the broker took it. The device's acks arrive
   * as tx / tx/end messages and are handled by the telemetry service, not awaited here.
   * @throws DeviceOfflineError | BusUnavailableError
   */
  sendTransactionCommand(identity: string, command: TransactionCommand): Promise<{ requestId: string }>;
}

export interface MqttDeviceBusOptions {
  url: string;
  /** How long setRelay waits for the device to report the new state. */
  commandTimeoutMs?: number;
  clientId?: string;
}

export class MqttDeviceBus implements DeviceBus {
  private readonly states = new Map<string, LiveDeviceState>();
  private readonly pending = new Map<string, (relay: RelayState) => void>();
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
      this.client.subscribe(DEVICE_STATE_TOPICS, { qos: 1 });
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
    return this.states.get(identity) ?? emptyDeviceState(identity);
  }

  async sendTransactionCommand(identity: string, command: TransactionCommand): Promise<{ requestId: string }> {
    if (!this.client.connected) throw new BusUnavailableError();
    if (this.getState(identity).online === false) throw new DeviceOfflineError(identity);
    const id = crypto.randomUUID();
    const payload = { op: command.op, txId: command.txId, id, ...(command.intervalSeconds && { interval: command.intervalSeconds }) };
    await this.client.publishAsync(transactionCommandTopic(identity), JSON.stringify(payload), { qos: 1, retain: false });
    return { requestId: id };
  }

  async setRelay(identity: string, on: boolean, force = false): Promise<RelayState> {
    if (!this.client.connected) throw new BusUnavailableError();
    // Known to be offline: fail fast instead of making the caller wait for the timeout.
    if (this.getState(identity).online === false) throw new DeviceOfflineError(identity);

    const id = crypto.randomUUID();
    const confirmed = new Promise<RelayState>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new DeviceTimeoutError(identity));
      }, this.commandTimeoutMs);
      this.pending.set(id, (relay) => {
        clearTimeout(timer);
        this.pending.delete(id);
        if (relay.rejected) reject(new RelayRejectedError(identity, relay.rejected));
        else resolve(relay);
      });
    });
    // If publishing fails, the rejection below wins and the timer is left to clean up.
    confirmed.catch(() => {});

    // NOT retained: a command must never be replayed to a device that reconnects later.
    await this.client.publishAsync(relayCommandTopic(identity), JSON.stringify({ on, id, ...(force && { force }) }), { qos: 1, retain: false });
    return confirmed;
  }

  private onMessage(topic: string, payload: Buffer): void {
    const parsed = parseDeviceTopic(topic);
    if (!parsed) return;
    const data = parsePayload(payload.toString());
    const next = applyMessage(this.getState(parsed.identity), parsed.kind, data, new Date());
    if (!next) return;
    this.states.set(parsed.identity, next);

    if (parsed.kind === "relay" && next.relay) {
      const id = (data as { id?: unknown }).id;
      if (typeof id === "string") this.pending.get(id)?.(next.relay);
    }
  }
}
