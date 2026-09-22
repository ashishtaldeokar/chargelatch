// identity -> devices.id, refreshed periodically so devices flashed after start-up are picked up
// without a restart. Identities are never reassigned, so a cached hit is always right.
import { schema, type Db } from "@chargelatch/db";

export class DeviceRegistry {
  private ids = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly db: Db, private readonly refreshMs = 60_000) {}

  async start(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => void this.refresh().catch((e: Error) => console.error(`registry refresh failed: ${e.message}`)), this.refreshMs);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  resolve(identity: string): number | undefined {
    return this.ids.get(identity);
  }

  get size(): number {
    return this.ids.size;
  }

  async refresh(): Promise<void> {
    const rows = await this.db.select({ id: schema.devices.id, identity: schema.devices.identity }).from(schema.devices);
    this.ids = new Map(rows.map((row) => [row.identity, row.id]));
  }
}
