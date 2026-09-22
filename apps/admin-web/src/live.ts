// Live device data straight from the broker: MQTT over WebSocket, the same topics the API
// follows (see @chargelatch/device-protocol). Commands do NOT go this way: switching a relay is
// an authenticated HTTP call (api.ts), and this connection only ever subscribes.
import { DEVICE_STATE_TOPICS, parseDeviceTopic, parsePayload, type DeviceMessageKind } from "@chargelatch/device-protocol";
import mqtt from "mqtt";

export interface LiveFeed {
  /**
   * Starts following every device. Retained status/relay messages arrive right after
   * subscribing, so the current state is known immediately, not only after the next change.
   * @returns a function that disconnects
   */
  watch(onMessage: (identity: string, kind: DeviceMessageKind, payload: unknown) => void, onConnection: (connected: boolean) => void): () => void;
}

/** `ws://host:8083/mqtt` in dev; must be `wss://` when the portal itself is served over https. */
export const mqttWsUrl: string = import.meta.env.VITE_MQTT_WS_URL ?? "ws://localhost:8083/mqtt";

export function createMqttFeed(url: string = mqttWsUrl): LiveFeed {
  return {
    watch: (onMessage, onConnection) => {
      const client = mqtt.connect(url, {
        clientId: `chargelatch-admin-web-${crypto.randomUUID().slice(0, 8)}`,
        clean: true,
        reconnectPeriod: 3000,
        connectTimeout: 10_000,
      });

      client.on("connect", () => {
        // Subscriptions do not survive a clean session, so redo them on every (re)connect.
        client.subscribe(DEVICE_STATE_TOPICS, { qos: 0 }, (error) => onConnection(!error));
      });
      client.on("close", () => onConnection(false));
      client.on("error", (error) => console.warn(`mqtt: ${error.message}`));
      client.on("message", (topic, payload) => {
        const parsed = parseDeviceTopic(topic);
        if (parsed) onMessage(parsed.identity, parsed.kind, parsePayload(payload.toString()));
      });

      return () => void client.end(true);
    },
  };
}
