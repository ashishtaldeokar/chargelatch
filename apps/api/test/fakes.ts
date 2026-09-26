import type { Device, Tenant, Transaction, User } from "@chargelatch/db";
import type { AppDeps } from "../src/app.ts";
import type { TokenVerifier } from "../src/auth.ts";
import { applyMessage, emptyDeviceState, type DeviceMessageKind, type LiveDeviceState } from "@chargelatch/device-protocol";
import { DeviceOfflineError, DeviceTimeoutError, RelayRejectedError, type DeviceBus, type TransactionCommand } from "../src/device-bus.ts";
import type { DeviceStore } from "../src/devices.ts";
import type { PowerSample, TelemetryStore } from "../src/telemetry.ts";
import type { NewTenant, TenantStore } from "../src/tenants.ts";
import type { NewTransaction, TransactionStore } from "../src/transactions.ts";
import type { UserStore } from "../src/users.ts";

export function fakeUserStore(initial: User[] = []): UserStore {
  const rows = [...initial];
  return {
    list: async () => rows,
    create: async (user) => {
      const created: User = { id: crypto.randomUUID(), createdAt: new Date(), ...user };
      rows.push(created);
      return created;
    },
  };
}

export function fakeDeviceStore(): DeviceStore {
  const rows: Device[] = [];
  return {
    register: async (registration) => {
      const existing = rows.find((d) => d.macAddress === registration.macAddress);
      if (existing) {
        if (registration.meter) Object.assign(existing, { meterModel: registration.meter.model, meterAddress: registration.meter.address, meterBaud: registration.meter.baud, meterParity: registration.meter.parity });
        return { device: existing, created: false };
      }
      const id = rows.length + 1;
      const device: Device = {
        id,
        identity: `SONIK-${id}`,
        provisioningPop: `pop-for-${id}`,
        macAddress: registration.macAddress,
        chipType: registration.chipType,
        chipRevision: registration.chipRevision ?? null,
        chipFeatures: registration.chipFeatures ?? [],
        crystalMhz: registration.crystalMhz ?? null,
        flashSizeBytes: registration.flashSizeBytes ?? null,
        meterModel: registration.meter?.model ?? null,
        meterAddress: registration.meter?.address ?? null,
        meterBaud: registration.meter?.baud ?? null,
        meterParity: registration.meter?.parity ?? null,
        tenantId: null,
        firmwareVersion: null,
        flashCount: 0,
        lastFlashedAt: null,
        createdAt: new Date(),
      };
      rows.push(device);
      return { device, created: true };
    },
    get: async (id) => rows.find((d) => d.id === id),
    setTenant: async (id, tenantId) => {
      const device = rows.find((d) => d.id === id);
      if (device) device.tenantId = tenantId;
      return device;
    },
    listForTenant: async (tenantId) => rows.filter((d) => d.tenantId === tenantId),
    getByIdentity: async (identity) => rows.find((d) => d.identity === identity),
    list: async (limit) => [...rows].reverse().slice(0, limit),
    markFlashed: async (id, firmwareVersion) => {
      const device = rows.find((d) => d.id === id);
      if (!device) return undefined;
      Object.assign(device, { firmwareVersion, flashCount: device.flashCount + 1, lastFlashedAt: new Date() });
      return device;
    },
  };
}

/**
 * Tokens are just role lists: "factory,user" verifies to those roles, "bad" is rejected.
 * "partner@<client>" is a service account of that Keycloak client with the partner role.
 */
export const fakeVerifier: TokenVerifier = {
  verify: async (token) => {
    if (token === "bad") throw new Error("invalid token");
    const service = token.match(/^partner@(.+)$/);
    if (service) return { sub: `service-account-${service[1]}`, clientId: service[1], roles: ["partner"] };
    return { sub: "test-user", roles: token.split(",") };
  },
};

export function fakeTenantStore(initial: NewTenant[] = []): TenantStore {
  const rows: Tenant[] = initial.map((t) => ({ ...t, createdAt: new Date() }));
  return {
    create: async (tenant) => {
      const row = { ...tenant, createdAt: new Date() };
      rows.push(row);
      return row;
    },
    update: async (id, patch) => {
      const row = rows.find((t) => t.id === id);
      if (row) Object.assign(row, patch);
      return row;
    },
    list: async () => rows,
    get: async (id) => rows.find((t) => t.id === id),
    getByClientId: async (clientId) => rows.find((t) => t.keycloakClientId === clientId),
  };
}

export function fakeTransactionStore(): TransactionStore & { rows: Transaction[] } {
  const rows: Transaction[] = [];
  const open = (tx: Transaction) => tx.state === "starting" || tx.state === "active" || tx.state === "stopping";
  return {
    rows,
    create: async (tx: NewTransaction) => {
      const row: Transaction = {
        id: crypto.randomUUID(),
        ...tx,
        state: "starting",
        requestedAt: new Date(),
        startedAt: null,
        stopRequestedAt: null,
        stoppedAt: null,
        stopReason: null,
        meterStartKwh: null,
        meterStopKwh: null,
        energyWh: null,
        energyQuality: null,
        powerAvgW: null,
        powerMaxW: null,
        currentMaxA: null,
        voltageMinV: null,
        voltageMaxV: null,
        sampleCount: null,
        meterUnreadableSamples: null,
        failureReason: null,
      };
      rows.push(row);
      return row;
    },
    get: async (tenantId, transactionId) => rows.find((t) => t.tenantId === tenantId && t.transactionId === transactionId),
    openForDevice: async (deviceId) => rows.filter((t) => t.deviceId === deviceId && open(t)).at(-1),
    markStopping: async (id) => {
      const row = rows.find((t) => t.id === id);
      if (row && (row.state === "starting" || row.state === "active")) Object.assign(row, { state: "stopping", stopRequestedAt: new Date() });
      return row;
    },
    listForTenant: async (tenantId, limit) => rows.filter((t) => t.tenantId === tenantId).slice(-limit).reverse(),
  };
}

/**
 * An in-memory bus. `deviceSays` plays the part of a device publishing over MQTT; devices listed
 * in `unresponsive` swallow commands, like a device that dropped off without its last will.
 */
export function fakeDeviceBus() {
  const states = new Map<string, LiveDeviceState>();
  const unresponsive = new Set<string>();
  const commands: { identity: string; command: TransactionCommand }[] = [];
  const get = (identity: string): LiveDeviceState => states.get(identity) ?? emptyDeviceState(identity);

  const deviceSays = (identity: string, kind: DeviceMessageKind, payload: object) => {
    const next = applyMessage(get(identity), kind, payload, new Date());
    if (!next) throw new Error("fake device sent an unusable message");
    states.set(identity, next);
  };

  const bus: DeviceBus = {
    getState: get,
    setRelay: async (identity, on, force = false) => {
      if (get(identity).online === false) throw new DeviceOfflineError(identity);
      if (unresponsive.has(identity)) throw new DeviceTimeoutError(identity);
      // Like the firmware: a plain "off" during a transaction is refused; force ends it.
      if (!on && get(identity).transaction?.active && !force) {
        deviceSays(identity, "relay", { on: true, rejected: "transaction_active" });
        throw new RelayRejectedError(identity, "transaction_active");
      }
      if (!on && get(identity).transaction?.active) deviceSays(identity, "tx", { state: "idle" });
      deviceSays(identity, "relay", { on });
      return get(identity).relay!;
    },
    sendTransactionCommand: async (identity, command) => {
      if (get(identity).online === false) throw new DeviceOfflineError(identity);
      commands.push({ identity, command });
      return { requestId: `req-${commands.length}` };
    },
  };
  return { bus, deviceSays, unresponsive, commands };
}

export function fakeTelemetryStore(samples: Record<number, PowerSample[]> = {}): TelemetryStore {
  return { recentPower: async (deviceId, since) => (samples[deviceId] ?? []).filter((s) => Date.parse(s.time) >= since.getTime()) };
}

export const SONIK: NewTenant = { id: "sonik", name: "Sonik", keycloakClientId: "chargelatch-partner-sonik", webhookUrl: "https://sonik.example/webhook", meterValueIntervalSeconds: 30 };

export const fakeDeps = (bus: DeviceBus = fakeDeviceBus().bus, telemetry: TelemetryStore = fakeTelemetryStore(), extra: Partial<AppDeps> = {}): AppDeps => ({
  users: fakeUserStore(),
  devices: fakeDeviceStore(),
  bus,
  telemetry,
  tenants: fakeTenantStore([SONIK]),
  transactions: fakeTransactionStore(),
  auth: fakeVerifier,
  ...extra,
});
