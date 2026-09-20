import type { Device, User } from "@chargelatch/db";
import type { AppDeps } from "../src/app.ts";
import type { TokenVerifier } from "../src/auth.ts";
import { applyMessage, DeviceOfflineError, DeviceTimeoutError, type DeviceBus, type LiveDeviceState } from "../src/device-bus.ts";
import type { DeviceStore } from "../src/devices.ts";
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
      if (existing) return { device: existing, created: false };
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
        firmwareVersion: null,
        flashCount: 0,
        lastFlashedAt: null,
        createdAt: new Date(),
      };
      rows.push(device);
      return { device, created: true };
    },
    get: async (id) => rows.find((d) => d.id === id),
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

/** Tokens are just role lists: "factory,user" verifies to those roles, "bad" is rejected. */
export const fakeVerifier: TokenVerifier = {
  verify: async (token) => {
    if (token === "bad") throw new Error("invalid token");
    return { sub: "test-user", roles: token.split(",") };
  },
};

/**
 * An in-memory bus. `deviceSays` plays the part of a device publishing over MQTT; devices listed
 * in `unresponsive` swallow commands, like a device that dropped off without its last will.
 */
export function fakeDeviceBus() {
  const states = new Map<string, LiveDeviceState>();
  const listeners = new Set<(state: LiveDeviceState) => void>();
  const unresponsive = new Set<string>();
  const get = (identity: string): LiveDeviceState => states.get(identity) ?? { identity, online: null, firmware: null, relay: null, meter: null };

  const deviceSays = (identity: string, kind: "status" | "relay" | "meter", payload: object) => {
    const next = applyMessage(get(identity), kind, payload, new Date());
    if (!next) throw new Error("fake device sent an unusable message");
    states.set(identity, next);
    for (const listener of listeners) listener(next);
  };

  const bus: DeviceBus = {
    getState: get,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setRelay: async (identity, on) => {
      if (get(identity).online === false) throw new DeviceOfflineError(identity);
      if (unresponsive.has(identity)) throw new DeviceTimeoutError(identity);
      deviceSays(identity, "relay", { on });
      return get(identity).relay!;
    },
  };
  return { bus, deviceSays, unresponsive, listenerCount: () => listeners.size };
}

export const fakeDeps = (bus: DeviceBus = fakeDeviceBus().bus): AppDeps => ({ users: fakeUserStore(), devices: fakeDeviceStore(), bus, auth: fakeVerifier });
