// Batches rows into multi-row INSERTs: a fleet publishing every 5 s must not cost one
// round-trip per message.
import { schema, type Db, type DeviceEventRow, type MeterReadingRow } from "@chargelatch/db";

export interface WriterOptions {
  /** Flush when this many rows are waiting... */
  maxRows?: number;
  /** ...or this long after the first one arrived. */
  maxDelayMs?: number;
  /** Rows to drop (oldest first) if the database is unreachable for a long time. */
  maxBuffered?: number;
  onError?: (error: Error, dropped: number) => void;
}

export class BatchWriter {
  private readings: MeterReadingRow[] = [];
  private events: DeviceEventRow[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private flushing: Promise<void> = Promise.resolve();
  private readonly maxRows: number;
  private readonly maxDelayMs: number;
  private readonly maxBuffered: number;
  private readonly onError: (error: Error, dropped: number) => void;

  constructor(
    private readonly db: Db,
    { maxRows = 200, maxDelayMs = 2000, maxBuffered = 50_000, onError = (e) => console.error(`telemetry write failed: ${e.message}`) }: WriterOptions = {},
  ) {
    this.maxRows = maxRows;
    this.maxDelayMs = maxDelayMs;
    this.maxBuffered = maxBuffered;
    this.onError = onError;
  }

  get pending(): number {
    return this.readings.length + this.events.length;
  }

  addReading(row: MeterReadingRow): void {
    this.readings.push(row);
    this.scheduled();
  }

  addEvent(row: DeviceEventRow): void {
    this.events.push(row);
    this.scheduled();
  }

  /** Writes everything waiting. Resolves after the write; never rejects (errors go to onError). */
  flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    // Serialise flushes so rows are written in arrival order and never twice.
    this.flushing = this.flushing.then(() => this.write());
    return this.flushing;
  }

  private scheduled(): void {
    if (this.pending >= this.maxRows) void this.flush();
    else if (!this.timer) this.timer = setTimeout(() => void this.flush(), this.maxDelayMs);
  }

  private async write(): Promise<void> {
    const readings = this.readings;
    const events = this.events;
    if (readings.length === 0 && events.length === 0) return;
    this.readings = [];
    this.events = [];
    try {
      if (readings.length > 0) await this.db.insert(schema.meterReadings).values(readings);
      if (events.length > 0) await this.db.insert(schema.deviceEvents).values(events);
    } catch (error) {
      // Put the rows back at the front and retry on the next flush, bounded so a long outage
      // cannot eat all memory: the oldest rows go first, they are also the least valuable.
      this.readings = [...readings, ...this.readings];
      this.events = [...events, ...this.events];
      const overflow = Math.max(0, this.pending - this.maxBuffered);
      if (overflow > 0) this.readings.splice(0, Math.min(overflow, this.readings.length));
      this.onError(error as Error, overflow);
      if (!this.timer) this.timer = setTimeout(() => void this.flush(), this.maxDelayMs);
    }
  }
}
