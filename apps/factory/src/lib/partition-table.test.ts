import { expect, test } from "bun:test";
import { join } from "node:path";
import { findPartition, parsePartitionTable } from "./partition-table.ts";

// The real partition-table.bin from apps/firmware/build. Refresh it if partitions.csv changes:
//   cp ../firmware/build/partition_table/partition-table.bin test/fixtures/
const table = new Uint8Array(await Bun.file(join(import.meta.dir, "../../test/fixtures/partition-table.bin")).arrayBuffer());

test("parses the firmware's partition table", () => {
  expect(parsePartitionTable(table).map((p) => [p.label, p.offset, p.size])).toEqual([
    ["nvs", 0x9000, 0x6000],
    ["phy_init", 0xf000, 0x1000],
    ["fctry", 0x10000, 0x6000],
    ["factory", 0x20000, 0x300000],
  ]);
});

test("finds the factory data partition as an NVS data partition", () => {
  expect(findPartition(parsePartitionTable(table), "fctry")).toMatchObject({ type: 1, subtype: 2, offset: 0x10000 });
});

test("explains a firmware without the partition", () => {
  expect(() => findPartition(parsePartitionTable(table), "missing")).toThrow(/no "missing" partition \(found: nvs, phy_init, fctry, factory\)/);
});

test("rejects garbage", () => {
  expect(() => parsePartitionTable(new Uint8Array(64).fill(7))).toThrow(/Invalid partition table/);
  expect(() => parsePartitionTable(new Uint8Array(64).fill(0xff))).toThrow(/empty/);
});
