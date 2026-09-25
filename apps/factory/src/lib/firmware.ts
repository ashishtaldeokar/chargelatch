import { findPartition, parsePartitionTable, type Partition } from "./partition-table.ts";

/** public/firmware/manifest.json, written by scripts/bundle-firmware.ts. */
/** A meter this firmware can read, with the meter's factory serial defaults. */
export interface MeterPreset {
  model: string;
  label: string;
  phases: number;
  address: number;
  baud: number;
  parity: "none" | "even" | "odd";
}

export interface FirmwareManifest {
  name: string;
  version: string;
  chip: string;
  builtAt: string;
  flash: { mode: string; freq: string; size: string };
  partitionTableOffset: number;
  /** From apps/firmware/meters.json. Older bundles lack it. */
  meters?: MeterPreset[];
  files: { name: string; offset: number; size: number; sha256: string }[];
}

export interface FlashFile {
  name: string;
  address: number;
  data: Uint8Array;
}

export interface Firmware {
  manifest: FirmwareManifest;
  files: FlashFile[];
  /** Where the per-device factory data goes, read from the bundled partition table. */
  factoryPartition: Partition;
}

/** Label of the NVS partition the firmware's device_identity component reads. */
export const FACTORY_PARTITION_LABEL = "fctry";

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function loadFirmware(baseUrl = "/firmware", fetcher: typeof fetch = fetch): Promise<Firmware> {
  const res = await fetcher(`${baseUrl}/manifest.json`, { cache: "no-store" });
  if (!res.ok || !res.headers.get("content-type")?.includes("json")) {
    throw new Error("No firmware bundle found. Run `pnpm firmware:build && pnpm firmware:bundle`.");
  }
  const manifest = (await res.json()) as FirmwareManifest;

  const files = await Promise.all(
    manifest.files.map(async (file): Promise<FlashFile> => {
      const bin = await fetcher(`${baseUrl}/${file.name}`, { cache: "no-store" });
      if (!bin.ok) throw new Error(`Could not load firmware file ${file.name}`);
      const data = new Uint8Array(await bin.arrayBuffer());
      if ((await sha256Hex(data)) !== file.sha256) throw new Error(`Firmware file ${file.name} is corrupt (checksum mismatch)`);
      return { name: file.name, address: file.offset, data };
    }),
  );

  const table = files.find((f) => f.address === manifest.partitionTableOffset);
  if (!table) throw new Error("The firmware bundle has no partition table");
  const factoryPartition = findPartition(parsePartitionTable(table.data), FACTORY_PARTITION_LABEL);

  return { manifest, files, factoryPartition };
}
