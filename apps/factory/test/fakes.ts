import type { Device, FactoryApi, RegisteredDevice } from "../src/lib/api.ts";
import type { ChipInfo, DeviceConnection } from "../src/lib/connection.ts";
import type { Firmware, FlashFile } from "../src/lib/firmware.ts";

export const chip: ChipInfo = {
  macAddress: "24:6f:28:aa:bb:cc",
  chipFamily: "ESP32",
  chipType: "ESP32-D0WD-V3",
  chipRevision: "v3.1",
  chipFeatures: ["WiFi", "BT"],
  crystalMhz: 40,
  flashSizeBytes: 4194304,
};

export const firmware: Firmware = {
  manifest: {
    name: "chargelatch_firmware",
    version: "0.1.0",
    chip: "esp32",
    builtAt: "2026-09-20T00:00:00.000Z",
    flash: { mode: "dio", freq: "40m", size: "4MB" },
    partitionTableOffset: 0x8000,
    meters: [
      { model: "SDM120", label: "Eastron SDM120 (1-phase)", phases: 1, address: 1, baud: 2400, parity: "none" },
      { model: "SDM630", label: "Eastron SDM630 (3-phase)", phases: 3, address: 1, baud: 9600, parity: "none" },
    ],
    files: [],
  },
  files: [
    { name: "bootloader.bin", address: 0x1000, data: new Uint8Array([1]) },
    { name: "partition-table.bin", address: 0x8000, data: new Uint8Array([2]) },
    { name: "chargelatch_firmware.bin", address: 0x20000, data: new Uint8Array([3]) },
  ],
  factoryPartition: { label: "fctry", type: 1, subtype: 2, offset: 0x10000, size: 0x6000 },
};

export function fakeConnection(info: ChipInfo = chip) {
  const calls: string[] = [];
  let written: FlashFile[] = [];
  const connection: DeviceConnection = {
    info,
    eraseFlash: async () => void calls.push("erase"),
    writeFlash: async (files, _settings, onProgress) => {
      calls.push("write");
      written = files;
      files.forEach((file, fileIndex) => onProgress({ fileIndex, written: file.data.length, total: file.data.length }));
    },
    reset: async () => void calls.push("reset"),
    disconnect: async () => void calls.push("disconnect"),
  };
  return { connection, calls, written: () => written };
}

export function fakeApi(known: Record<string, number> = {}) {
  const calls: string[] = [];
  const devices: Device[] = [];
  const api: FactoryApi = {
    registerDevice: async (registration) => {
      calls.push(`register:${registration.meter?.model ?? "no-meter"}`);
      const id = known[registration.macAddress] ?? devices.length + 1;
      const device: RegisteredDevice = {
        id,
        identity: `SONIK-${id}`,
        macAddress: registration.macAddress,
        chipType: registration.chipType,
        chipRevision: registration.chipRevision ?? null,
        chipFeatures: registration.chipFeatures ?? [],
        crystalMhz: registration.crystalMhz ?? null,
        flashSizeBytes: registration.flashSizeBytes ?? null,
        meter: registration.meter ?? null,
        firmwareVersion: null,
        flashCount: known[registration.macAddress] ? 1 : 0,
        lastFlashedAt: null,
        createdAt: "2026-09-20T00:00:00.000Z",
        created: !known[registration.macAddress],
      };
      devices.push(device);
      return device;
    },
    listDevices: async () => devices,
    getFactoryPartition: async (_id, size) => {
      calls.push(`partition:${size}`);
      return new Uint8Array(size).fill(0xab);
    },
    markFlashed: async (id, firmwareVersion) => {
      calls.push(`flashed:${firmwareVersion}`);
      const device = devices.find((d) => d.id === id)!;
      Object.assign(device, { firmwareVersion, flashCount: device.flashCount + 1 });
      return device;
    },
  };
  return { api, calls };
}
