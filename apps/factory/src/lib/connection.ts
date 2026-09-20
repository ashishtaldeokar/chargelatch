import type { FlashFile } from "./firmware.ts";

export interface ChipInfo {
  macAddress: string;
  /** esptool's chip family name, e.g. "ESP32". Compared with the firmware's target chip. */
  chipFamily: string;
  /** Full description, e.g. "ESP32-D0WD-V3". */
  chipType: string;
  chipRevision?: string;
  chipFeatures: string[];
  crystalMhz?: number;
  flashSizeBytes?: number;
}

export interface FlashProgress {
  fileIndex: number;
  written: number;
  total: number;
}

export interface FlashSettings {
  mode: string;
  freq: string;
  size: string;
}

/** A chip in bootloader mode. Implemented over Web Serial by esptool.ts; faked in tests. */
export interface DeviceConnection {
  readonly info: ChipInfo;
  eraseFlash(): Promise<void>;
  writeFlash(files: FlashFile[], settings: FlashSettings, onProgress: (progress: FlashProgress) => void): Promise<void>;
  /** Hard-resets the chip into the freshly flashed firmware. */
  reset(): Promise<void>;
  disconnect(): Promise<void>;
}

export const normalizeChipFamily = (name: string) => name.toLowerCase().replaceAll("-", "");

/** "ESP32-D0WD-V3 (revision v3.1)" -> { chipType: "ESP32-D0WD-V3", chipRevision: "v3.1" } */
export function parseChipDescription(description: string): { chipType: string; chipRevision?: string } {
  const match = description.match(/^(.*?)\s*\(revision\s+([^)]+)\)\s*$/i);
  return match ? { chipType: match[1]!, chipRevision: match[2]! } : { chipType: description.trim() };
}

/** "4MB" -> 4194304 */
export function parseFlashSize(size: string): number | undefined {
  const match = size.match(/^(\d+)\s*(KB|MB)$/i);
  if (!match) return undefined;
  return Number(match[1]) * (match[2]!.toUpperCase() === "MB" ? 1024 * 1024 : 1024);
}
