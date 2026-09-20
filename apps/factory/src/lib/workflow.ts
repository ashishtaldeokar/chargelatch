import type { FactoryApi, RegisteredDevice, Device } from "./api.ts";
import { normalizeChipFamily, parseFlashSize, type DeviceConnection, type FlashProgress } from "./connection.ts";
import type { Firmware, FlashFile } from "./firmware.ts";

export type Step = "register" | "identity" | "erase" | "flash" | "record" | "reset";

export const STEPS: { id: Step; label: string }[] = [
  { id: "register", label: "Register device" },
  { id: "identity", label: "Build identity partition" },
  { id: "erase", label: "Erase flash" },
  { id: "flash", label: "Write firmware + identity" },
  { id: "record", label: "Record flash" },
  { id: "reset", label: "Reset device" },
];

export interface ProvisionEvents {
  onStep(step: Step): void;
  onRegistered(device: RegisteredDevice): void;
  onFlashProgress(file: FlashFile, progress: FlashProgress): void;
}

export interface ProvisionOptions {
  connection: DeviceConnection;
  api: FactoryApi;
  firmware: Firmware;
  /** Wipes the whole chip first, so no Wi-Fi credentials or stale data survive a re-flash. */
  eraseAll: boolean;
  events: ProvisionEvents;
}

/**
 * The factory flow for one chip: MAC -> identity from the backend -> flash firmware together with
 * the identity partition -> record it. The flash is only recorded once esptool has verified it.
 */
export async function provisionDevice({ connection, api, firmware, eraseAll, events }: ProvisionOptions): Promise<Device> {
  const { info } = connection;
  if (normalizeChipFamily(info.chipFamily) !== normalizeChipFamily(firmware.manifest.chip)) {
    throw new Error(`This firmware is built for ${firmware.manifest.chip}, but the connected chip is ${info.chipFamily}`);
  }

  // The partition table is laid out for the flash size the firmware was built with; on a smaller
  // chip the app would be written past the end of flash. Checked before an identity is issued.
  const requiredFlash = parseFlashSize(firmware.manifest.flash.size);
  if (requiredFlash && info.flashSizeBytes && info.flashSizeBytes < requiredFlash) {
    throw new Error(
      `This firmware needs ${firmware.manifest.flash.size} of flash, but the connected chip only has ${info.flashSizeBytes / (1024 * 1024)}MB`,
    );
  }

  events.onStep("register");
  const { chipFamily: _family, ...registration } = info;
  const device = await api.registerDevice(registration);
  events.onRegistered(device);

  events.onStep("identity");
  const { offset, size } = firmware.factoryPartition;
  const identityImage = await api.getFactoryPartition(device.id, size);
  if (identityImage.length !== size) {
    throw new Error(`Identity partition is ${identityImage.length} bytes, expected ${size}`);
  }
  const files: FlashFile[] = [...firmware.files, { name: `${device.identity} identity`, address: offset, data: identityImage }];

  if (eraseAll) {
    events.onStep("erase");
    await connection.eraseFlash();
  }

  events.onStep("flash");
  await connection.writeFlash(files, firmware.manifest.flash, (progress) => events.onFlashProgress(files[progress.fileIndex]!, progress));

  events.onStep("record");
  const recorded = await api.markFlashed(device.id, firmware.manifest.version);

  events.onStep("reset");
  await connection.reset();
  return recorded;
}
