import { expect, test } from "bun:test";
import { normalizeChipFamily, parseChipDescription, parseFlashSize } from "./connection.ts";

test("splits esptool's chip description", () => {
  expect(parseChipDescription("ESP32-D0WD-V3 (revision v3.1)")).toEqual({ chipType: "ESP32-D0WD-V3", chipRevision: "v3.1" });
  expect(parseChipDescription("ESP32-C3")).toEqual({ chipType: "ESP32-C3" });
});

test("parses flash sizes", () => {
  expect(parseFlashSize("4MB")).toBe(4194304);
  expect(parseFlashSize("512KB")).toBe(524288);
  expect(parseFlashSize("unknown")).toBeUndefined();
});

test("chip families compare across esptool and IDF spellings", () => {
  expect(normalizeChipFamily("ESP32-S3")).toBe(normalizeChipFamily("esp32s3"));
  expect(normalizeChipFamily("ESP32")).not.toBe(normalizeChipFamily("esp32c3"));
});
