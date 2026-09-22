import { expect, test } from "bun:test";
import { appendPoint, formatWatts, fromHistory, powerTicks, segments, trim, WINDOW_MS } from "./power-series.ts";

const t0 = Date.parse("2026-09-22T10:00:00.000Z");
const min = (m: number) => t0 + m * 60_000;

test("live points extend the history and the window slides", () => {
  let points = fromHistory([{ time: new Date(min(-9)).toISOString(), power: 100 }, { time: new Date(min(-4)).toISOString(), power: 200 }]);
  points = appendPoint(points, { time: min(0), power: 300 }, min(0));
  expect(points.map((p) => p.power)).toEqual([100, 200, 300]);
  // Two minutes later the -9 min point has left the 10-minute window.
  points = appendPoint(points, { time: min(2), power: 310 }, min(2));
  expect(points.map((p) => p.power)).toEqual([200, 300, 310]);
  // A message that is not newer than the last point (retained replay) is ignored.
  expect(appendPoint(points, { time: min(2), power: 999 }, min(2))).toBe(points);
});

test("trim drops old points as time passes without new ones", () => {
  const points = [{ time: min(-11), power: 1 }, { time: min(-1), power: 2 }];
  expect(trim(points, min(0)).map((p) => p.power)).toEqual([2]);
  expect(trim(points, min(-2), WINDOW_MS)).toBe(points); // nothing to drop: same array back
});

test("unreadable readings break the line into segments", () => {
  const runs = segments([
    { time: 1, power: 10 },
    { time: 2, power: 11 },
    { time: 3, power: null },
    { time: 4, power: 12 },
  ]);
  expect(runs.map((r) => r.map((p) => p.power))).toEqual([[10, 11], [12]]);
});

test("axis ticks are round numbers that cover the maximum", () => {
  expect(powerTicks(1430)).toEqual([0, 500, 1000, 1500]);
  expect(powerTicks(7200)).toEqual([0, 2500, 5000, 7500]);
  expect(powerTicks(0)).toEqual([0, 0.5, 1]);
  expect(powerTicks(95).at(-1)).toBeGreaterThanOrEqual(95);
});

test("watts format", () => {
  expect(formatWatts(1430.4)).toBe("1,430 W");
  expect(formatWatts(12345)).toBe("12.3 kW");
});
