import type { DeviceMessageKind } from "@chargelatch/device-protocol";
import type { Api, LiveDevice, PowerSample, Tenant } from "../src/api.ts";
import type { LiveFeed } from "../src/live.ts";

export const device = (overrides: Partial<LiveDevice> = {}): LiveDevice => ({
  identity: "SONIK-1",
  macAddress: "24:6f:28:aa:bb:cc",
  chipType: "ESP32-D0WD-V3",
  firmwareVersion: "0.1.0",
  tenantId: null,
  meterConfig: { model: "SDM120", address: 1, baud: 2400, parity: "none" },
  transaction: null,
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
 * The two halves of the real system: an HTTP API (registry + relay commands) and an MQTT feed
 * (what devices publish). `deviceSays` plays a device publishing. As in reality, a relay command
 * is confirmed by the device's own `relay` message on the feed, not by the HTTP response.
 */
export const sonik: Tenant = { id: "sonik", name: "Sonik", keycloakClientId: "chargelatch-partner-sonik", webhookUrl: "https://sonik.example/hook", meterValueIntervalSeconds: 30, createdAt: "2026-09-26T00:00:00.000Z" };

export function fakeBackend(initial: LiveDevice[], options: { failRelay?: string; power?: Record<string, PowerSample[]>; tenants?: Tenant[]; failTenant?: string } = {}) {
  let registry = initial;
  const tenants: Tenant[] = [...(options.tenants ?? [sonik])];
  const assignments: [string, string | null][] = [];
  let onMessage: ((identity: string, kind: DeviceMessageKind, payload: unknown) => void) | undefined;
  let onConnection: ((connected: boolean) => void) | undefined;
  const relayCalls: [string, boolean][] = [];
  let listCalls = 0;

  const deviceSays = (identity: string, kind: DeviceMessageKind, payload: unknown) => onMessage?.(identity, kind, payload);

  const api: Api = {
    listDevices: async () => {
      listCalls++;
      return registry;
    },
    setRelay: async (identity, on) => {
      relayCalls.push([identity, on]);
      if (options.failRelay) throw new Error(options.failRelay);
      deviceSays(identity, "relay", { on });
      return { on, updatedAt: new Date().toISOString() };
    },
    recentPower: async (identity) => options.power?.[identity] ?? [],
    listTenants: async () => [...tenants], // a fresh array, as a real response would be
    createTenant: async (tenant) => {
      if (options.failTenant) throw new Error(options.failTenant);
      const created = { ...tenant, createdAt: new Date().toISOString() };
      tenants.push(created);
      return created;
    },
    updateTenant: async (id, patch) => {
      const tenant = tenants.find((t) => t.id === id)!;
      Object.assign(tenant, patch);
      return tenant;
    },
    assignTenant: async (identity, tenantId) => {
      assignments.push([identity, tenantId]);
      registry = registry.map((d) => (d.identity === identity ? { ...d, tenantId } : d));
      return registry.find((d) => d.identity === identity)!;
    },
  };

  const feed: LiveFeed = {
    watch: (messageListener, connectionListener) => {
      onMessage = messageListener;
      onConnection = connectionListener;
      connectionListener(true);
      return () => {
        onMessage = undefined;
        onConnection = undefined;
      };
    },
  };

  return {
    api,
    feed,
    deviceSays,
    relayCalls,
    listCalls: () => listCalls,
    register: (next: LiveDevice) => {
      registry = [next, ...registry];
    },
    assignments,
    tenants,
    setConnected: (connected: boolean) => onConnection?.(connected),
    watching: () => onMessage !== undefined,
  };
}
