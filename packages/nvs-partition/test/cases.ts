import type { NvsData } from "../src/index.ts";

const pem = (lines: number) =>
  ["-----BEGIN CERTIFICATE-----", ...Array.from({ length: lines }, (_, i) => `${i}`.padStart(4, "0").repeat(16)), "-----END CERTIFICATE-----", ""].join("\n");

export const cases: Record<string, { data: NvsData; size: number }> = {
  identity: { data: { factory: { identity: "SONIK-1" } }, size: 0x6000 },
  // Exactly 32 bytes including the NUL: the payload fills one entry with no padding.
  "entry-boundary": { data: { factory: { identity: "SONIK-".padEnd(31, "7") } }, size: 0x3000 },
  mixed: {
    data: {
      factory: {
        identity: "SONIK-4242",
        hw_rev: { type: "u8", value: 3 },
        batch: { type: "u16", value: 65535 },
        serial: { type: "u32", value: 4000000000 },
        offset: { type: "i32", value: -123456 },
        tiny: { type: "i8", value: -128 },
        cal: { type: "i16", value: -32768 },
      },
      certs: { note: "second namespace" },
    },
    size: 0x6000,
  },
  // Two certificate-sized strings: the second does not fit in page 0, so it must roll over to
  // page 1 and page 0 must be marked FULL.
  "multi-page": { data: { factory: { identity: "SONIK-9", cert: pem(40), chain: pem(40) } }, size: 0x6000 },
};
