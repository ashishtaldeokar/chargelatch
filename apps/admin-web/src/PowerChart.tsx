import { useId, useState, type PointerEvent } from "react";
import { formatWatts, powerTicks, segments, type PowerPoint } from "./power-series.ts";

interface PowerChartProps {
  points: PowerPoint[];
  /** ms since epoch: right edge of the chart */
  now: number;
  windowMs: number;
}

const W = 320;
const H = 120;
const PAD = { top: 8, right: 12, bottom: 18, left: 44 };

/** Active power over the last few minutes: one series, so the title names it and there is no legend. */
export function PowerChart({ points, now, windowMs }: PowerChartProps) {
  const [hover, setHover] = useState<number | null>(null);
  const id = useId();

  const readable = points.filter((p): p is PowerPoint & { power: number } => p.power !== null);
  const ticks = powerTicks(Math.max(0, ...readable.map((p) => p.power)));
  const yMax = ticks.at(-1)!;
  const x0 = now - windowMs;
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const x = (t: number) => PAD.left + ((t - x0) / windowMs) * plotW;
  const y = (w: number) => PAD.top + plotH - (w / yMax) * plotH;

  const path = (run: { time: number; power: number }[]) => run.map((p, i) => `${i ? "L" : "M"}${x(p.time).toFixed(1)},${y(p.power).toFixed(1)}`).join(" ");

  // The crosshair snaps to the nearest sample in time, so the reader aims at a moment, not the line.
  const hovered = hover === null || points.length === 0 ? null : points.reduce((best, p) => (Math.abs(p.time - hover) < Math.abs(best.time - hover) ? p : best));
  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    setHover(x0 + ((px - PAD.left) / plotW) * windowMs);
  };
  const last = readable.at(-1);
  const minutesLabel = (t: number) => {
    const m = Math.round((now - t) / 60_000);
    return m === 0 ? "now" : `-${m} min`;
  };

  return (
    <figure className="power-chart" aria-label="Active power, last 10 minutes">
      <figcaption>
        <span>Power, last {Math.round(windowMs / 60_000)} min</span>
        {last && <strong>{formatWatts(last.power)}</strong>}
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby={`${id}-title`} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        <title id={`${id}-title`}>Active power over the last {Math.round(windowMs / 60_000)} minutes</title>
        {ticks.map((t) => (
          <g key={t} className="grid">
            <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} />
            <text x={PAD.left - 6} y={y(t)} dy="0.35em" textAnchor="end">
              {t >= 1000 ? `${t / 1000}k` : t}
            </text>
          </g>
        ))}
        {[x0, x0 + windowMs / 2, now].map((t) => (
          <text key={t} className="axis" x={x(t)} y={H - 4} textAnchor={t === x0 ? "start" : t === now ? "end" : "middle"}>
            {minutesLabel(t)}
          </text>
        ))}
        {readable.length === 0 && (
          <text className="empty" x={PAD.left + plotW / 2} y={PAD.top + plotH / 2} textAnchor="middle" dy="0.35em">
            No readings yet
          </text>
        )}
        {segments(points).map((run, i) =>
          run.length === 1 ? (
            <circle key={i} className="point" cx={x(run[0]!.time)} cy={y(run[0]!.power)} r={3} />
          ) : (
            <path key={i} className="line" d={path(run)} />
          ),
        )}
        {last && <circle className="end" cx={x(last.time)} cy={y(last.power)} r={4} />}
        {hovered && (
          <g className="crosshair">
            <line x1={x(hovered.time)} x2={x(hovered.time)} y1={PAD.top} y2={PAD.top + plotH} />
            {hovered.power !== null && <circle cx={x(hovered.time)} cy={y(hovered.power)} r={4} />}
          </g>
        )}
      </svg>
      {hovered && (
        <div className="tooltip" role="status">
          <strong>{hovered.power === null ? "meter unreadable" : formatWatts(hovered.power)}</strong>
          <span>{new Date(hovered.time).toLocaleTimeString()}</span>
        </div>
      )}
    </figure>
  );
}
