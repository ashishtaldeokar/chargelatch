import { describe, expect, test } from "bun:test";
import { applyMessage, type LiveDeviceState } from "./device-bus.ts";

const blank: LiveDeviceState = { identity: "SONIK-1", online: null, firmware: null, relay: null, meter: null };
const now = new Date("2026-09-20T10:00:00.000Z");

describe("applying device messages", () => {
  test("status: online with firmware, then the last will", () => {
    const online = applyMessage(blank, "status", { online: true, firmware: "0.1.0" }, now)!;
    expect(online).toMatchObject({ online: true, firmware: "0.1.0" });
    // The last will carries no firmware: the last known one is kept.
    expect(applyMessage(online, "status", { online: false }, now)).toMatchObject({ online: false, firmware: "0.1.0" });
  });

  test("relay state is stamped with when it was heard", () => {
    expect(applyMessage(blank, "relay", { on: true, id: "abc" }, now)!.relay).toEqual({ on: true, updatedAt: now.toISOString() });
  });

  test("meter: envelope fields are split from the numeric values", () => {
    const state = applyMessage(blank, "meter", { model: "SDM120", phases: 1, ok: true, voltage: 230.5, power: 287.1 }, now)!;
    expect(state.meter).toEqual({ model: "SDM120", phases: 1, ok: true, error: undefined, values: { voltage: 230.5, power: 287.1 }, receivedAt: now.toISOString() });
    expect(state.online).toBe(true);
  });

  test("meter: a failed read keeps the error and has no values", () => {
    const state = applyMessage(blank, "meter", { model: "SDM120", phases: 1, ok: false, error: "timeout" }, now)!;
    expect(state.meter).toMatchObject({ ok: false, error: "timeout", values: {} });
  });

  test("anything malformed is ignored: the broker is anonymous, so payloads are untrusted", () => {
    expect(applyMessage(blank, "relay", { on: "yes" }, now)).toBeNull();
    expect(applyMessage(blank, "status", "online", now)).toBeNull();
    expect(applyMessage(blank, "meter", { voltage: 230 }, now)).toBeNull();
    expect(applyMessage(blank, "meter", null, now)).toBeNull();
    expect(applyMessage(blank, "unknown", { on: true }, now)).toBeNull();
    // Non-numeric "values" are dropped rather than passed through to clients.
    expect(applyMessage(blank, "meter", { model: "SDM120", ok: true, voltage: "<script>" }, now)!.meter!.values).toEqual({});
  });
});
