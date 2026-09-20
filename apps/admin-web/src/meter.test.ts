import { expect, test } from "bun:test";
import { describeValue, splitReadings } from "./meter.ts";

test("formats known fields with their unit and precision", () => {
  expect(describeValue("power", 1430.4)).toEqual({ key: "power", label: "Power", text: "1,430 W" });
  expect(describeValue("voltage", 230.456).text).toBe("230.5 V");
  expect(describeValue("power_factor", 0.987).text).toBe("0.99");
  expect(describeValue("total_energy", 1234.756).text).toBe("1,234.76 kWh");
});

test("labels per-phase fields of a 3-phase meter", () => {
  expect(describeValue("voltage_l2", 229.9)).toEqual({ key: "voltage_l2", label: "Voltage L2", text: "229.9 V" });
});

test("a field this UI has never heard of still shows up", () => {
  expect(describeValue("neutral_current", 0.5)).toEqual({ key: "neutral_current", label: "neutral current", text: "0.5" });
});

test("splits the headline numbers from the rest, in a fixed order", () => {
  const { primary, rest } = splitReadings({ frequency: 50, total_energy: 10, current: 1, voltage: 230, power: 230 });
  expect(primary.map((v) => v.key)).toEqual(["power", "voltage", "current", "total_energy"]);
  expect(rest.map((v) => v.key)).toEqual(["frequency"]);
});
