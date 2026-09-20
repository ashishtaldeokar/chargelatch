// A stand-in for a flashed device, speaking the firmware's MQTT contract (device_mqtt,
// relay_control/relay_remote and meter_telemetry components). Works under Bun and Node.
import mqtt, { type MqttClient } from "mqtt";

export interface FakeDevice {
  identity: string;
  /** Relay state as the "hardware" sees it. */
  relayOn(): boolean;
  publishMeter(values: Record<string, number>): Promise<void>;
  publishMeterFailure(error: string): Promise<void>;
  /** Stops answering relay commands, like a hung device. */
  ignoreCommands(): void;
  /** Vanishes without a DISCONNECT, so the broker publishes the last will. */
  dropOffNetwork(): void;
  stop(): Promise<void>;
}

export async function startFakeDevice(mqttUrl: string, identity: string, firmware = "0.1.0"): Promise<FakeDevice> {
  let on = false;
  let answering = true;
  const topic = (suffix: string) => `devices/${identity}/${suffix}`;

  const client: MqttClient = await mqtt.connectAsync(mqttUrl, {
    clientId: identity,
    reconnectPeriod: 0,
    will: { topic: topic("status"), payload: Buffer.from(JSON.stringify({ online: false })), qos: 1, retain: true },
  });

  client.on("message", (got, payload) => {
    if (got !== topic("cmd/relay") || !answering) return;
    const command = JSON.parse(payload.toString()) as { on?: unknown; id?: unknown };
    if (typeof command.on !== "boolean") return; // firmware ignores anything but an explicit boolean
    on = command.on;
    client.publish(topic("relay"), JSON.stringify({ on, id: command.id }), { qos: 1, retain: true });
  });
  await client.subscribeAsync(topic("cmd/#"), { qos: 1 });

  // Same order as the firmware on connect: status, then the current relay state.
  await client.publishAsync(topic("status"), JSON.stringify({ online: true, firmware }), { qos: 1, retain: true });
  await client.publishAsync(topic("relay"), JSON.stringify({ on }), { qos: 1, retain: true });

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
    dropOffNetwork: () => client.stream.destroy(),
    stop: () => client.endAsync(true),
  };
}
