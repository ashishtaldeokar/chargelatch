import type { Api, LiveDevice } from "../src/api.ts";

export const device = (overrides: Partial<LiveDevice> = {}): LiveDevice => ({
  identity: "SONIK-1",
  macAddress: "24:6f:28:aa:bb:cc",
  chipType: "ESP32-D0WD-V3",
  firmwareVersion: "0.1.0",
  online: true,
  firmware: "0.1.0",
  relay: { on: false, updatedAt: new Date().toISOString() },
  meter: {
    model: "SDM120",
    phases: 1,
    ok: true,
    values: { voltage: 230.5, current: 6.25, power: 1430.4, power_factor: 0.99, frequency: 50.02, total_energy: 1234.756 },
    receivedAt: new Date().toISOString(),
  },
  ...overrides,
});

/**
 * A fake API whose `push` plays the event stream. Like the real thing, a relay command is
 * confirmed by the device state arriving over the stream, not by the HTTP response alone.
 */
export function fakeApi(initial: LiveDevice[], options: { failRelay?: string } = {}) {
  let devices = initial;
  let onDevice: ((device: LiveDevice) => void) | undefined;
  let onConnection: ((connected: boolean) => void) | undefined;
  const relayCalls: [string, boolean][] = [];

  const push = (next: LiveDevice) => {
    devices = devices.some((d) => d.identity === next.identity) ? devices.map((d) => (d.identity === next.identity ? next : d)) : [next, ...devices];
    onDevice?.(next);
  };

  const api: Api = {
    listDevices: async () => devices,
    setRelay: async (identity, on) => {
      relayCalls.push([identity, on]);
      if (options.failRelay) throw new Error(options.failRelay);
      const relay = { on, updatedAt: new Date().toISOString() };
      push({ ...devices.find((d) => d.identity === identity)!, relay });
      return relay;
    },
    watchDevices: (deviceListener, connectionListener) => {
      onDevice = deviceListener;
      onConnection = connectionListener;
      connectionListener(true);
      return () => {
        onDevice = undefined;
        onConnection = undefined;
      };
    },
  };
  return { api, push, relayCalls, setConnected: (connected: boolean) => onConnection?.(connected), watching: () => onDevice !== undefined };
}
