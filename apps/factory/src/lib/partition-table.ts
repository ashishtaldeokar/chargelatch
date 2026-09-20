// Parser for the ESP-IDF binary partition table (partition-table.bin), so the factory app can
// find where the `fctry` partition lives from the firmware it is about to flash, instead of
// hard-coding an offset that silently goes stale when partitions.csv changes.

export interface Partition {
  label: string;
  type: number;
  subtype: number;
  offset: number;
  size: number;
}

const ENTRY_SIZE = 32;
const ENTRY_MAGIC = 0x50aa; // bytes AA 50
const MD5_MAGIC = 0xebeb; // bytes EB EB: checksum entry that ends the table

export function parsePartitionTable(bytes: Uint8Array): Partition[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const partitions: Partition[] = [];

  for (let at = 0; at + ENTRY_SIZE <= bytes.length; at += ENTRY_SIZE) {
    const magic = view.getUint16(at, true);
    if (magic === MD5_MAGIC || magic === 0xffff) break;
    if (magic !== ENTRY_MAGIC) throw new Error(`Invalid partition table entry at offset ${at}`);

    const label = bytes.subarray(at + 12, at + 28);
    const end = label.indexOf(0);
    partitions.push({
      type: view.getUint8(at + 2),
      subtype: view.getUint8(at + 3),
      offset: view.getUint32(at + 4, true),
      size: view.getUint32(at + 8, true),
      label: new TextDecoder().decode(label.subarray(0, end === -1 ? label.length : end)),
    });
  }

  if (partitions.length === 0) throw new Error("Partition table is empty");
  return partitions;
}

export function findPartition(partitions: Partition[], label: string): Partition {
  const partition = partitions.find((p) => p.label === label);
  if (!partition) {
    throw new Error(`The firmware's partition table has no "${label}" partition (found: ${partitions.map((p) => p.label).join(", ")})`);
  }
  return partition;
}
