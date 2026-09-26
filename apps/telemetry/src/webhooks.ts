// Webhook outbox and dispatcher. Every event a tenant must hear about is first written to
// webhook_deliveries (in the same flow that changes the transaction), then delivered from there:
// a crash between the two loses nothing, and retries need no memory.
import { schema, type Db, type Tenant } from "@chargelatch/db";
import { and, asc, eq, lte, sql } from "drizzle-orm";

export type WebhookEventType = "TransactionStarted" | "TransactionStopped" | "TransactionFailed" | "MeterValues";

export interface WebhookEvent {
  eventType: WebhookEventType;
  eventId: string;
  /** Per transaction, from 1: lets the receiver order and dedupe. */
  sequence: number;
  occurredAt: string;
  tenantId: string;
  deviceIdentity: string;
  transactionId: string;
  data: Record<string, unknown>;
}

/** Retry schedule for events that must arrive (everything except MeterValues). */
const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 6 * 3_600_000, 24 * 3_600_000];
const DELIVERY_TIMEOUT_MS = 10_000;
const MAX_PER_TENANT_PER_PASS = 10;

export class WebhookOutbox {
  constructor(private readonly db: Db) {}

  /** Writes the event; `transactionRowId` is our uuid, used for per-transaction sequencing. */
  async enqueue(
    tenantId: string,
    transactionRowId: string,
    event: Omit<WebhookEvent, "eventId" | "sequence" | "occurredAt" | "tenantId">,
    options: { retry: boolean } = { retry: true },
  ): Promise<WebhookEvent> {
    const { webhookDeliveries } = schema;
    const [row] = await this.db.select({ count: sql<number>`count(*)::int` }).from(webhookDeliveries).where(eq(webhookDeliveries.transactionId, transactionRowId));
    const payload: WebhookEvent = { ...event, eventId: crypto.randomUUID(), sequence: (row?.count ?? 0) + 1, occurredAt: new Date().toISOString(), tenantId };
    await this.db.insert(webhookDeliveries).values({
      id: payload.eventId,
      tenantId,
      transactionId: transactionRowId,
      eventType: event.eventType,
      sequence: payload.sequence,
      payload,
      retry: options.retry,
    });
    return payload;
  }
}

export interface DispatcherOptions {
  fetcher?: typeof fetch;
  now?: () => Date;
  log?: (line: string) => void;
}

export class WebhookDispatcher {
  private readonly fetcher: typeof fetch;
  private readonly now: () => Date;
  private readonly log: (line: string) => void;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(
    private readonly db: Db,
    { fetcher = fetch, now = () => new Date(), log = console.log }: DispatcherOptions = {},
  ) {
    this.fetcher = fetcher;
    this.now = now;
    this.log = log;
  }

  start(intervalMs = 2000): void {
    this.timer = setInterval(() => void this.runOnce().catch((e: Error) => this.log(`webhook dispatch failed: ${e.message}`)), intervalMs);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  /**
   * One pass over every tenant. Per tenant, deliveries go out in creation order, except that a
   * transaction whose earlier event is still undelivered blocks only its own later events, not
   * other transactions. Returns the number of attempts made.
   */
  async runOnce(): Promise<number> {
    if (this.running) return 0; // a slow endpoint must not pile passes up
    this.running = true;
    try {
      let attempts = 0;
      for (const tenant of await this.db.select().from(schema.tenants)) attempts += await this.runTenant(tenant);
      return attempts;
    } finally {
      this.running = false;
    }
  }

  private async runTenant(tenant: Tenant): Promise<number> {
    const { webhookDeliveries } = schema;
    const pending = await this.db
      .select()
      .from(webhookDeliveries)
      .where(and(eq(webhookDeliveries.tenantId, tenant.id), eq(webhookDeliveries.status, "pending")))
      .orderBy(asc(webhookDeliveries.createdAt), asc(webhookDeliveries.sequence));

    const blocked = new Set<string>();
    let attempts = 0;
    for (const delivery of pending) {
      const tx = delivery.transactionId ?? delivery.id;
      if (blocked.has(tx)) continue;
      blocked.add(tx); // whatever happens to this one, later events of the transaction wait
      if (delivery.nextAttemptAt > this.now() || attempts >= MAX_PER_TENANT_PER_PASS) continue;

      attempts++;
      if (!tenant.webhookUrl) {
        await this.db.update(webhookDeliveries).set({ status: "failed", lastError: "tenant has no webhook URL", attempts: delivery.attempts + 1 }).where(eq(webhookDeliveries.id, delivery.id));
        continue;
      }
      const result = await this.post(tenant.webhookUrl, delivery.payload);
      if (result.ok) {
        await this.db.update(webhookDeliveries).set({ status: "delivered", deliveredAt: this.now(), attempts: delivery.attempts + 1, lastStatusCode: result.status, lastError: null }).where(eq(webhookDeliveries.id, delivery.id));
        blocked.delete(tx); // the next event of this transaction may go in the same pass
        continue;
      }
      const attempt = delivery.attempts + 1;
      const giveUp = !delivery.retry || attempt > BACKOFF_MS.length;
      await this.db
        .update(webhookDeliveries)
        .set({
          status: giveUp ? "failed" : "pending",
          attempts: attempt,
          lastStatusCode: result.status ?? null,
          lastError: result.error,
          nextAttemptAt: giveUp ? delivery.nextAttemptAt : new Date(this.now().getTime() + BACKOFF_MS[attempt - 1]!),
        })
        .where(eq(webhookDeliveries.id, delivery.id));
      this.log(`webhook ${delivery.eventType} to ${tenant.id} ${giveUp ? "dropped" : "will retry"}: ${result.error}`);
      // A best-effort event that failed no longer blocks the transaction's later events.
      if (giveUp) blocked.delete(tx);
    }
    return attempts;
  }

  private async post(url: string, payload: unknown): Promise<{ ok: boolean; status?: number; error: string }> {
    try {
      const res = await this.fetcher(url, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "chargelatch-webhook/1" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });
      return { ok: res.ok, status: res.status, error: res.ok ? "" : `HTTP ${res.status}` };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}

/** Pending deliveries whose next attempt is due. For tests and status logs. */
export async function countPending(db: Db, tenantId?: string): Promise<number> {
  const { webhookDeliveries } = schema;
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(webhookDeliveries)
    .where(and(eq(webhookDeliveries.status, "pending"), lte(webhookDeliveries.nextAttemptAt, new Date()), ...(tenantId ? [eq(webhookDeliveries.tenantId, tenantId)] : [])));
  return row?.count ?? 0;
}
