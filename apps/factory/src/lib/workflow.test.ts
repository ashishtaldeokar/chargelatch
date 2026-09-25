import { expect, test } from "bun:test";
import { chip, fakeApi, fakeConnection, firmware } from "../../test/fakes.ts";
import { provisionDevice, type Step } from "./workflow.ts";

const sdm120 = { model: "SDM120", address: 1, baud: 2400, parity: "none" as const };

function run(overrides: { eraseAll?: boolean; meter?: typeof sdm120; connection?: ReturnType<typeof fakeConnection>; api?: ReturnType<typeof fakeApi> } = {}) {
  const connection = overrides.connection ?? fakeConnection();
  const api = overrides.api ?? fakeApi();
  const steps: Step[] = [];
  const result = provisionDevice({
    connection: connection.connection,
    api: api.api,
    firmware,
    eraseAll: overrides.eraseAll ?? true,
    meter: overrides.meter ?? sdm120,
    events: { onStep: (s) => steps.push(s), onRegistered: () => {}, onFlashProgress: () => {} },
  });
  return { result, steps, connection, api };
}

test("registers, flashes firmware plus the identity partition, records, resets", async () => {
  const { result, steps, connection, api } = run();
  const device = await result;

  expect(device).toMatchObject({ identity: "SONIK-1", firmwareVersion: "0.1.0", flashCount: 1 });
  expect(steps).toEqual(["register", "identity", "erase", "flash", "record", "reset"]);
  expect(api.calls).toEqual(["register:SDM120", "partition:24576", "flashed:0.1.0"]);
  expect(connection.calls).toEqual(["erase", "write", "reset"]);

  // The identity image goes to the fctry offset from the partition table, after the firmware.
  expect(connection.written().map((f) => [f.name, f.address])).toEqual([
    ["bootloader.bin", 0x1000],
    ["partition-table.bin", 0x8000],
    ["chargelatch_firmware.bin", 0x20000],
    ["SONIK-1 identity", 0x10000],
  ]);
  expect(connection.written().at(-1)!.data.length).toBe(0x6000);
});

test("skips the erase when asked", async () => {
  const { result, steps, connection } = run({ eraseAll: false });
  await result;
  expect(steps).not.toContain("erase");
  expect(connection.calls).toEqual(["write", "reset"]);
});

test("a known MAC keeps its identity", async () => {
  const { result } = run({ api: fakeApi({ [chip.macAddress]: 42 }) });
  expect((await result).identity).toBe("SONIK-42");
});

test("refuses firmware built for another chip before touching the backend", async () => {
  const { result, api, connection } = run({ connection: fakeConnection({ ...chip, chipFamily: "ESP32-C3" }) });
  expect(result).rejects.toThrow(/built for esp32, but the connected chip is ESP32-C3/);
  await result.catch(() => {});
  expect(api.calls).toEqual([]);
  expect(connection.calls).toEqual([]);
});

test("refuses a chip with less flash than the firmware is laid out for", async () => {
  const { result, api, connection } = run({ connection: fakeConnection({ ...chip, flashSizeBytes: 2 * 1024 * 1024 }) });
  expect(result).rejects.toThrow(/needs 4MB of flash, but the connected chip only has 2MB/);
  await result.catch(() => {});
  expect(api.calls).toEqual([]);
  expect(connection.calls).toEqual([]);
});

test("a chip whose flash size could not be detected is not blocked", async () => {
  const { result } = run({ connection: fakeConnection({ ...chip, flashSizeBytes: undefined }) });
  expect((await result).identity).toBe("SONIK-1");
});

test("the chosen meter is registered with the device, and must be one the firmware knows", async () => {
  const { result, api } = run({ meter: { model: "SDM630", address: 2, baud: 9600, parity: "none" } });
  await result;
  expect(api.calls[0]).toBe("register:SDM630");

  const bad = run({ meter: { model: "XYZ999", address: 1, baud: 2400, parity: "none" } });
  expect(bad.result).rejects.toThrow(/does not support the XYZ999 meter \(it knows: SDM120, SDM630\)/);
  await bad.result.catch(() => {});
  expect(bad.api.calls).toEqual([]);
});

test("a failed flash is never recorded as flashed", async () => {
  const connection = fakeConnection();
  connection.connection.writeFlash = async () => {
    throw new Error("MD5 of file does not match data in flash!");
  };
  const { result, api } = run({ connection });
  expect(result).rejects.toThrow(/MD5/);
  await result.catch(() => {});
  expect(api.calls).toEqual(["register:SDM120", "partition:24576"]);
});
