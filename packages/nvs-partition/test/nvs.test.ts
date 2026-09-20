import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { generateNvsPartition } from "../src/index.ts";
import { cases } from "./cases.ts";

// Fixtures come from ESP-IDF's nvs_partition_gen.py (`pnpm fixtures`), so matching them
// byte-for-byte means the firmware's NVS driver will read our images.
describe("matches ESP-IDF's nvs_partition_gen.py byte-for-byte", () => {
  for (const [name, { data, size }] of Object.entries(cases)) {
    test(name, async () => {
      const expected = new Uint8Array(await Bun.file(join(import.meta.dir, "fixtures", `${name}.bin`)).arrayBuffer());
      const actual = generateNvsPartition(data, size);
      expect(actual.length).toBe(expected.length);
      expect(Buffer.from(actual).equals(Buffer.from(expected))).toBe(true);
    });
  }
});

describe("validation", () => {
  test("rejects keys longer than 15 bytes", () => {
    expect(() => generateNvsPartition({ factory: { a_key_that_is_too_long: "x" } }, 0x3000)).toThrow(/1-15 bytes/);
  });

  test("rejects sizes that are not whole pages or are too small", () => {
    expect(() => generateNvsPartition({}, 0x2000)).toThrow(/at least/);
    expect(() => generateNvsPartition({}, 0x3001)).toThrow(/multiple/);
  });

  test("rejects out-of-range integers", () => {
    expect(() => generateNvsPartition({ factory: { v: { type: "u8", value: 256 } } }, 0x3000)).toThrow(/out of range/);
  });

  test("rejects data that does not fit", () => {
    const big = "x".repeat(3900);
    expect(() => generateNvsPartition({ factory: { a: big, b: big, c: big } }, 0x3000)).toThrow(/does not fit/);
  });
});
