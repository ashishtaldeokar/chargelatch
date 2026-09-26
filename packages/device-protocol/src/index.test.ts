import { describe, expect, test } from "bun:test";
import { applyMessage, parseDeviceTopic, parsePayload, parseTransactionEnd, parseTransactionMeterValue, relayCommandTopic, transactionCommandTopic, type LiveDeviceState } from "./index.ts";

const blank: LiveDeviceState = { identity: "SONIK-1", online: null, firmware: null, relay: null, meter: null, transaction: null };
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

describe("transactions", () => {
  test("the retained tx state, active and idle", () => {
    const active = applyMessage(blank, "tx", { state: "active", txId: "T-1", meterStart: 1234.75, interval: 30, id: "r1" }, now)!;
    expect(active.transaction).toEqual({ active: true, txId: "T-1", meterStart: 1234.75, intervalSeconds: 30, updatedAt: now.toISOString() });
    expect(active.online).toBe(true);
    expect(applyMessage(active, "tx", { state: "idle", id: "r2" }, now)!.transaction).toMatchObject({ active: false, txId: null });
    expect(applyMessage(blank, "tx", { state: "active" }, now)).toBeNull(); // no txId
    expect(applyMessage(blank, "tx", { state: "weird" }, now)).toBeNull();
  });

  test("a refused relay command is visible on the state", () => {
    expect(applyMessage(blank, "relay", { on: true, id: "r", rejected: "transaction_active" }, now)!.relay).toMatchObject({ on: true, rejected: "transaction_active" });
    expect(applyMessage(blank, "relay", { on: true, id: "r" }, now)!.relay).not.toHaveProperty("rejected");
  });

  test("tx/end and tx/meter payloads", () => {
    expect(parseTransactionEnd({ txId: "T-1", meterStart: 10, meterStop: 10.5, energyWh: 500, reason: "remote", id: "r" })).toEqual({ txId: "T-1", meterStart: 10, meterStop: 10.5, energyWh: 500, reason: "remote", requestId: "r" });
    // Unreadable meter: nulls stay null.
    expect(parseTransactionEnd({ txId: "T-1", meterStart: null, meterStop: null, energyWh: null, reason: "superseded" })).toMatchObject({ energyWh: null, requestId: null });
    expect(parseTransactionEnd({ reason: "remote" })).toBeNull();

    const mv = parseTransactionMeterValue({ txId: "T-1", seq: 3, energyWh: 120.5, meterKwh: 10.12, reading: { model: "SDM120", phases: 1, ok: true, power: 1430 } }, now)!;
    expect(mv).toMatchObject({ txId: "T-1", seq: 3, energyWh: 120.5, meterKwh: 10.12, reading: { model: "SDM120", ok: true, values: { power: 1430 } } });
    expect(parseTransactionMeterValue({ txId: "T-1", seq: 3, reading: "nope" }, now)).toBeNull();
  });

  test("tx topics are device state; commands are not", () => {
    expect(parseDeviceTopic("devices/SONIK-1/tx")).toEqual({ identity: "SONIK-1", kind: "tx" });
    expect(parseDeviceTopic("devices/SONIK-1/tx/end")).toEqual({ identity: "SONIK-1", kind: "tx/end" });
    expect(parseDeviceTopic("devices/SONIK-1/tx/meter")).toEqual({ identity: "SONIK-1", kind: "tx/meter" });
    expect(parseDeviceTopic("devices/SONIK-1/cmd/tx")).toBeNull();
    expect(transactionCommandTopic("SONIK-1")).toBe("devices/SONIK-1/cmd/tx");
  });
});

describe("topics", () => {
  test("state topics are parsed, everything else is ignored", () => {
    expect(parseDeviceTopic("devices/SONIK-42/meter")).toEqual({ identity: "SONIK-42", kind: "meter" });
    expect(parseDeviceTopic("devices/SONIK-42/status")).toEqual({ identity: "SONIK-42", kind: "status" });
    // Commands and deeper or foreign topics are not device state.
    expect(parseDeviceTopic("devices/SONIK-42/cmd/relay")).toBeNull();
    expect(parseDeviceTopic("devices/SONIK-42/meter/extra")).toBeNull();
    expect(parseDeviceTopic("other/SONIK-42/meter")).toBeNull();
  });

  test("the command topic", () => {
    expect(relayCommandTopic("SONIK-42")).toBe("devices/SONIK-42/cmd/relay");
  });

  test("payloads that are not JSON do not throw", () => {
    expect(parsePayload('{"on":true}')).toEqual({ on: true });
    expect(parsePayload("on")).toBeUndefined();
    expect(parsePayload("")).toBeUndefined();
  });
});
