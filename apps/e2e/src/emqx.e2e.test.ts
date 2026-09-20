import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import mqtt, { type MqttClient } from "mqtt";
import { emqxApiToken, startEmqx, type StartedEmqx } from "./helpers/emqx.ts";

let emqx: StartedEmqx;
const clients: MqttClient[] = [];

beforeAll(async () => {
  emqx = await startEmqx();
}, 300_000);

afterAll(async () => {
  await Promise.all(clients.map((client) => client.endAsync(true)));
  await emqx?.stop();
});

async function connect(url: string, options: mqtt.IClientOptions = {}): Promise<MqttClient> {
  const client = await mqtt.connectAsync(url, { connectTimeout: 10_000, reconnectPeriod: 0, ...options });
  clients.push(client);
  return client;
}

/**
 * Subscribes, then hands back a promise for the next message on `topic`. It is wrapped in an object
 * because an async function returning a bare promise would flatten it and wait for the message.
 */
async function subscribe(client: MqttClient, topic: string): Promise<{ next: Promise<{ payload: string; retain: boolean }> }> {
  const message = new Promise<{ payload: string; retain: boolean }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no message on ${topic}`)), 10_000);
    client.on("message", (got, payload, packet) => {
      if (got !== topic) return;
      clearTimeout(timer);
      resolve({ payload: payload.toString(), retain: packet.retain });
    });
  });
  await client.subscribeAsync(topic, { qos: 1 });
  return { next: message };
}

describe("the baked emqx image", () => {
  test("accepts an anonymous device and routes its messages", async () => {
    const backend = await connect(emqx.mqttUrl, { clientId: "e2e-backend" });
    const telemetry = await subscribe(backend, "devices/SONIK-1/telemetry");

    // Exactly how firmware connects today: client id = identity, no credentials.
    const device = await connect(emqx.mqttUrl, { clientId: "SONIK-1" });
    await device.publishAsync("devices/SONIK-1/telemetry", JSON.stringify({ kw: 7.4 }), { qos: 1 });

    expect(JSON.parse((await telemetry.next).payload)).toEqual({ kw: 7.4 });
  });

  test("delivers the device's last will when it drops off, and retains it", async () => {
    const status = "devices/SONIK-2/status";
    const device = await connect(emqx.mqttUrl, {
      clientId: "SONIK-2",
      will: { topic: status, payload: Buffer.from('{"online":false}'), qos: 1, retain: true },
    });
    await device.publishAsync(status, '{"online":true}', { qos: 1, retain: true });

    const backend = await connect(emqx.mqttUrl, { clientId: "e2e-watcher" });
    // A late subscriber first gets the retained "online"...
    expect((await (await subscribe(backend, status)).next).payload).toBe('{"online":true}');

    // ...and an unclean disconnect (power cut, Wi-Fi loss) publishes the will.
    const offline = new Promise<string>((resolve) => backend.on("message", (_, payload) => resolve(payload.toString())));
    device.stream.destroy();
    expect(await offline).toBe('{"online":false}');
  });

  test("serves MQTT over WebSocket", async () => {
    // mqtt.js's WebSocket transport is not supported under Bun, so check the listener with Bun's own
    // WebSocket: EMQX only completes the upgrade when the "mqtt" subprotocol is negotiated.
    const socket = new WebSocket(emqx.wsUrl, "mqtt");
    const protocol = await new Promise<string>((resolve, reject) => {
      socket.onopen = () => resolve(socket.protocol);
      socket.onerror = () => reject(new Error("websocket upgrade failed"));
    });
    socket.close();
    expect(protocol).toBe("mqtt");
  });

  test("has TLS listeners off and no authenticators, as committed in emqx.conf", async () => {
    const headers = { authorization: `Bearer ${await emqxApiToken(emqx.dashboardUrl)}` };

    const listeners = (await (await fetch(`${emqx.dashboardUrl}/api/v5/listeners`, { headers })).json()) as { id: string; enable: boolean }[];
    expect(Object.fromEntries(listeners.map((l) => [l.id, l.enable]))).toEqual({
      "tcp:default": true,
      "ws:default": true,
      "ssl:default": false,
      "wss:default": false,
    });

    // Anonymous on purpose for now. When device authentication lands this assertion must change.
    expect(await (await fetch(`${emqx.dashboardUrl}/api/v5/authentication`, { headers })).json()).toEqual([]);
  });

  test("rejects packets above the configured 64KB limit", async () => {
    const device = await connect(emqx.mqttUrl, { clientId: "SONIK-3" });
    const closed = new Promise<void>((resolve) => device.once("close", () => resolve()));
    device.publish("devices/SONIK-3/telemetry", Buffer.alloc(80 * 1024), { qos: 0 });
    await closed; // the broker drops the connection
    expect(device.connected).toBe(false);
  });
});
