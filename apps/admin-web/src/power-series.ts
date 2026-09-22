// The last N minutes of power for one device: seeded from the API's history, kept current by
// the live meter messages. Pure functions, so the bookkeeping is unit-tested.

export interface PowerPoint {
  /** ms since epoch */
  time: number;
  /** null = the meter could not be read: the line breaks here */
  power: number | null;
}

export const WINDOW_MS = 10 * 60_000;

export function fromHistory(samples: { time: string; power: number | null }[]): PowerPoint[] {
  return samples.map((s) => ({ time: Date.parse(s.time), power: s.power }));
}

/** Appends a live reading and drops everything older than the window. Ignores stale duplicates. */
export function appendPoint(points: PowerPoint[], point: PowerPoint, now: number, windowMs = WINDOW_MS): PowerPoint[] {
  const last = points.at(-1);
  if (last && point.time <= last.time) return points;
  const cutoff = now - windowMs;
  const kept = points.filter((p) => p.time >= cutoff);
  kept.push(point);
  return kept;
}

/** Trims the window as time passes without new points (the card re-renders on a timer). */
export function trim(points: PowerPoint[], now: number, windowMs = WINDOW_MS): PowerPoint[] {
  const cutoff = now - windowMs;
  return points[0] && points[0].time < cutoff ? points.filter((p) => p.time >= cutoff) : points;
}

/** Splits into runs of consecutive readable points: each run is one polyline. */
export function segments(points: PowerPoint[]): { time: number; power: number }[][] {
  const runs: { time: number; power: number }[][] = [];
  let current: { time: number; power: number }[] = [];
  for (const p of points) {
    if (p.power === null) {
      if (current.length) runs.push(current);
      current = [];
    } else current.push({ time: p.time, power: p.power });
  }
  if (current.length) runs.push(current);
  return runs;
}

/** "Nice" axis ticks: 0 .. a round number above the max, 3-4 steps. */
export function powerTicks(maxPower: number): number[] {
  const top = Math.max(maxPower, 1);
  const rawStep = top / 3;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= rawStep)!;
  const ticks: number[] = [];
  for (let v = 0; v <= top + step - 1e-9; v += step) ticks.push(Math.round(v * 1000) / 1000);
  return ticks;
}

export const formatWatts = (w: number) => (Math.abs(w) >= 10_000 ? `${(w / 1000).toFixed(1)} kW` : `${Math.round(w).toLocaleString("en-US")} W`);
