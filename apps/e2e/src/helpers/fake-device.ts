// A stand-in for a flashed device, speaking the firmware's MQTT contract (device_mqtt,
// relay_control/relay_remote and meter_telemetry components). Works under Bun and Node.
import mqtt, { type MqttClient } from "mqtt";

export interface FakeDevice {
  identity: string;
  /** Relay state as the "hardware" sees it. */
  relayOn(): boolean;
  publishMeter(values: Record<string, number>): Promise<void>;
  publishMeterFailure(error: string): Promise<void>;
  /** Stops answering relay and transaction commands, like a hung device. */
  ignoreCommands(): void;
  /** The device's own view of its charging transaction. */
  transaction(): { txId: string; meterStart: number | null } | null;
  /** Sets the meter counter the device reports (kWh); energy = counter - meterStart. */
  setMeterKwh(kwh: number | null): void;
  /** Publishes one tx/meter message for the active transaction. */
  publishTransactionMeter(values: Record<string, number>): Promise<void>;
  /** Ends the active transaction from the device side (e.g. an admin force-off), reason given. */
  endTransaction(reason: string): Promise<void>;
  /** Vanishes without a DISCONNECT, so the broker publishes the last will. */
  dropOffNetwork(): void;
  stop(): Promise<void>;
}

export interface FakeDeviceOptions {
  firmware?: string;
  /** A transaction the device is already running when it connects (persisted across its reboot). */
  activeTransaction?: { txId: string; meterStart: number | null };
  meterKwh?: number | null;
}

export async function startFakeDevice(mqttUrl: string, identity: string, options: FakeDeviceOptions | string = {}): Promise<FakeDevice> {
  const { firmware = "0.1.0", activeTransaction, meterKwh: initialKwh = 100 } = typeof options === "string" ? { firmware: options } : options;
  let on = !!activeTransaction;
  let answering = true;
  let tx: { txId: string; meterStart: number | null; interval: number; seq: number } | null = activeTransaction ? { ...activeTransaction, interval: 30, seq: 0 } : null;
  let meterKwh: number | null = initialKwh;
  const topic = (suffix: string) => `devices/${identity}/${suffix}`;

  const client: MqttClient = await mqtt.connectAsync(mqttUrl, {
    clientId: identity,
    reconnectPeriod: 0,
    will: { topic: topic("status"), payload: Buffer.from(JSON.stringify({ online: false })), qos: 1, retain: true },
  });

  // Same order and payloads as the firmware's charging_session component.
  const publishTxState = (id: unknown) =>
    client.publishAsync(topic("tx"), JSON.stringify(tx ? { state: "active", txId: tx.txId, meterStart: tx.meterStart, interval: tx.interval, id } : { state: "idle", id }), { qos: 1, retain: true });
  const endTx = async (reason: string, id: unknown) => {
    if (!tx) return;
    const energyWh = tx.meterStart !== null && meterKwh !== null ? Math.max(0, (meterKwh - tx.meterStart) * 1000) : null;
    const ended = { txId: tx.txId, meterStart: tx.meterStart, meterStop: meterKwh, energyWh, reason, id };
    tx = null;
    on = false;
    await client.publishAsync(topic("tx/end"), JSON.stringify(ended), { qos: 1 });
    await client.publishAsync(topic("relay"), JSON.stringify({ on, id }), { qos: 1, retain: true });
  };

  client.on("message", (got, payload) => {
    if (!answering) return;
    if (got === topic("cmd/relay")) {
      const command = JSON.parse(payload.toString()) as { on?: unknown; id?: unknown; force?: unknown };
      if (typeof command.on !== "boolean") return; // firmware ignores anything but an explicit boolean
      if (!command.on && tx && command.force !== true) {
        client.publish(topic("relay"), JSON.stringify({ on, id: command.id, rejected: "transaction_active" }), { qos: 1, retain: true });
        return;
      }
      void (async () => {
        if (!command.on && tx) {
          await endTx("admin", command.id);
          await publishTxState(command.id);
        }
        on = command.on as boolean;
        await client.publishAsync(topic("relay"), JSON.stringify({ on, id: command.id }), { qos: 1, retain: true });
      })();
    } else if (got === topic("cmd/tx")) {
      const command = JSON.parse(payload.toString()) as { op?: unknown; txId?: unknown; id?: unknown; interval?: unknown };
      if (typeof command.txId !== "string") return;
      void (async () => {
        if (command.op === "start") {
          if (tx && tx.txId !== command.txId) await endTx("superseded", command.id);
          if (!tx) {
            tx = { txId: command.txId as string, meterStart: meterKwh, interval: typeof command.interval === "number" ? command.interval : 30, seq: 0 };
            on = true;
          }
          await publishTxState(command.id);
          await client.publishAsync(topic("relay"), JSON.stringify({ on, id: command.id }), { qos: 1, retain: true });
        } else if (command.op === "stop") {
          if (tx && tx.txId === command.txId) await endTx("remote", command.id);
          await publishTxState(command.id);
        }
      })();
    }
  });
  await client.subscribeAsync(topic("cmd/#"), { qos: 1 });
  // Persistent session like the firmware's MQTT client: commands sent while it is away are
  // queued by the broker and delivered on reconnect (persistent `clean: false` sessions).

  // Same order as the firmware on connect: status, then the current relay state.
  await client.publishAsync(topic("status"), JSON.stringify({ online: true, firmware }), { qos: 1, retain: true });
  await client.publishAsync(topic("relay"), JSON.stringify({ on }), { qos: 1, retain: true });
  await publishTxState(undefined);

  return {
    identity,
    relayOn: () => on,
    publishMeter: async (values) => {
      await client.publishAsync(topic("meter"), JSON.stringify({ model: "SDM120", phases: 1, ok: true, ...values }));
    },
    publishMeterFailure: async (error) => {
      await client.publishAsync(topic("meter"), JSON.stringify({ model: "SDM120", phases: 1, ok: false, error }));
    },
    ignoreCommands: () => {
      answering = false;
    },
    transaction: () => (tx ? { txId: tx.txId, meterStart: tx.meterStart } : null),
    setMeterKwh: (kwh) => {
      meterKwh = kwh;
    },
    publishTransactionMeter: async (values) => {
      if (!tx) throw new Error("no active transaction");
      const energyWh = tx.meterStart !== null && meterKwh !== null ? Math.max(0, (meterKwh - tx.meterStart) * 1000) : null;
      await client.publishAsync(topic("tx/meter"), JSON.stringify({ txId: tx.txId, seq: ++tx.seq, energyWh, meterKwh, reading: { model: "SDM120", phases: 1, ok: true, ...values } }), { qos: 1 });
    },
    endTransaction: async (reason) => {
      await endTx(reason, undefined);
      await publishTxState(undefined);
    },
    dropOffNetwork: () => client.stream.destroy(),
    stop: () => client.endAsync(true),
  };
}
