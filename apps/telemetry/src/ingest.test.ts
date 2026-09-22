import { describe, expect, test } from "bun:test";
import { Ingester } from "./ingest.ts";

const now = new Date("2026-09-22T10:00:00.000Z");
const registry: Record<string, number> = { "SONIK-1": 1, "SONIK-2": 2 };
const ingester = () => new Ingester((identity) => registry[identity]);

describe("meter readings", () => {
  test("known fields go to columns, the rest to extra, envelope kept", () => {
    const result = ingester().ingest(
      "devices/SONIK-1/meter",
      JSON.stringify({ model: "SDM630", phases: 3, ok: true, voltage: 230.5, power: 1430.4, voltage_l2: 229.9, total_energy: 1234.75, neutral_current: 0.4 }),
      now,
    );
    expect(result).toEqual({
      reading: {
        time: now,
        deviceId: 1,
        model: "SDM630",
        ok: true,
        error: null,
        voltage: 230.5,
        power: 1430.4,
        voltageL2: 229.9,
        totalEnergy: 1234.75,
        extra: { neutral_current: 0.4 },
      },
    });
  });

  test("a failed read is stored as a row with the error and no values", () => {
    const result = ingester().ingest("devices/SONIK-1/meter", JSON.stringify({ model: "SDM120", phases: 1, ok: false, error: "timeout" }), now);
    expect(result).toEqual({ reading: { time: now, deviceId: 1, model: "SDM120", ok: false, error: "timeout" } });
  });

  test("unregistered identities, foreign topics and malformed payloads are dropped", () => {
    const i = ingester();
    expect(i.ingest("devices/SONIK-666/meter", JSON.stringify({ model: "SDM120", ok: true, power: 1 }), now)).toBeNull();
    expect(i.ingest("devices/SONIK-1/cmd/relay", JSON.stringify({ on: true }), now)).toBeNull();
    expect(i.ingest("devices/SONIK-1/meter", "not json", now)).toBeNull();
    expect(i.ingest("devices/SONIK-1/meter", JSON.stringify({ voltage: 230 }), now)).toBeNull();
  });
});

describe("events", () => {
  test("status and relay CHANGES become events; retained re-publishes do not", () => {
    const i = ingester();
    expect(i.ingest("devices/SONIK-1/status", JSON.stringify({ online: true, firmware: "0.1.0" }), now)).toEqual({
      event: { time: now, deviceId: 1, kind: "online", detail: "0.1.0" },
    });
    // The same retained message again (e.g. our own reconnect): no new row.
    expect(i.ingest("devices/SONIK-1/status", JSON.stringify({ online: true, firmware: "0.1.0" }), now)).toBeNull();
    expect(i.ingest("devices/SONIK-1/status", JSON.stringify({ online: false }), now)).toEqual({
      event: { time: now, deviceId: 1, kind: "offline", detail: null },
    });

    expect(i.ingest("devices/SONIK-1/relay", JSON.stringify({ on: true, id: "req-1" }), now)).toEqual({
      event: { time: now, deviceId: 1, kind: "relay_on", detail: "req-1" },
    });
    // The firmware republishes the state after every command, changed or not.
    expect(i.ingest("devices/SONIK-1/relay", JSON.stringify({ on: true, id: "req-2" }), now)).toBeNull();
    expect(i.ingest("devices/SONIK-1/relay", JSON.stringify({ on: false }), now)).toEqual({
      event: { time: now, deviceId: 1, kind: "relay_off", detail: null },
    });
  });

  test("the very first relay state seen is recorded, so history always has a starting point", () => {
    expect(ingester().ingest("devices/SONIK-2/relay", JSON.stringify({ on: false }), now)).toEqual({
      event: { time: now, deviceId: 2, kind: "relay_off", detail: null },
    });
  });

  test("devices are tracked independently", () => {
    const i = ingester();
    i.ingest("devices/SONIK-1/status", JSON.stringify({ online: true }), now);
    expect(i.ingest("devices/SONIK-2/status", JSON.stringify({ online: true }), now)).not.toBeNull();
    i.forget("SONIK-1");
    expect(i.ingest("devices/SONIK-1/status", JSON.stringify({ online: true }), now)).not.toBeNull();
  });
});
