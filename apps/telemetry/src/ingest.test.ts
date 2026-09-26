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
        transactionId: null,
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
    expect(result).toEqual({ reading: { time: now, deviceId: 1, transactionId: null, model: "SDM120", ok: false, error: "timeout" } });
  });

  test("unregistered identities, foreign topics and malformed payloads are dropped", () => {
    const i = ingester();
    expect(i.ingest("devices/SONIK-666/meter", JSON.stringify({ model: "SDM120", ok: true, power: 1 }), now)).toBeNull();
    expect(i.ingest("devices/SONIK-1/cmd/relay", JSON.stringify({ on: true }), now)).toBeNull();
    expect(i.ingest("devices/SONIK-1/meter", "not json", now)).toBeNull();
    expect(i.ingest("devices/SONIK-1/meter", JSON.stringify({ voltage: 230 }), now)).toBeNull();
  });
});

describe("transactions", () => {
  test("readings taken during a known transaction carry its row id; tx messages come out as such", () => {
    const i = new Ingester((identity) => registry[identity], (deviceId, txId) => (deviceId === 1 && txId === "T1" ? "row-uuid" : undefined));
    expect(i.ingest("devices/SONIK-1/tx", JSON.stringify({ state: "active", txId: "T1", meterStart: 10, interval: 30 }), now)).toEqual({
      transaction: { active: true, txId: "T1", meterStart: 10, intervalSeconds: 30, updatedAt: now.toISOString() },
    });
    const reading = i.ingest("devices/SONIK-1/meter", JSON.stringify({ model: "SDM120", phases: 1, ok: true, power: 5 }), now);
    expect(reading).toMatchObject({ reading: { transactionId: "row-uuid" } });

    expect(i.ingest("devices/SONIK-1/tx/end", JSON.stringify({ txId: "T1", meterStart: 10, meterStop: 10.5, energyWh: 500, reason: "remote", id: "r" }), now)).toEqual({
      transactionEnd: { txId: "T1", meterStart: 10, meterStop: 10.5, energyWh: 500, reason: "remote", requestId: "r" },
    });
    expect(i.ingest("devices/SONIK-1/tx/meter", JSON.stringify({ txId: "T1", seq: 1, energyWh: 50, meterKwh: 10.05, reading: { model: "SDM120", ok: true, power: 5 } }), now)).toMatchObject({
      meterValue: { txId: "T1", seq: 1, energyWh: 50 },
    });
    // After the device goes idle, readings are no longer tied to a transaction.
    i.ingest("devices/SONIK-1/tx", JSON.stringify({ state: "idle" }), now);
    expect(i.ingest("devices/SONIK-1/meter", JSON.stringify({ model: "SDM120", phases: 1, ok: true, power: 5 }), now)).toMatchObject({ reading: { transactionId: null } });
    // Malformed transaction messages are dropped like everything else.
    expect(i.ingest("devices/SONIK-1/tx/end", JSON.stringify({ reason: "remote" }), now)).toBeNull();
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
