// The system of record for charging transactions. The API only creates them (`starting`) and
// flags stop requests (`stopping`); every other transition happens here, from what the device
// reports over MQTT, and each one writes the tenant's webhook event in the same flow.
import { schema, type Db, type Transaction } from "@chargelatch/db";
import type { TransactionEnd, TransactionMeterValue, TransactionState } from "@chargelatch/device-protocol";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { WebhookOutbox } from "./webhooks.ts";

/** A `starting` transaction the device has not confirmed within this long has failed. */
export const START_DEADLINE_MS = 60_000;

export interface TransactionCommandSender {
  (identity: string, command: { op: "start" | "stop"; txId: string; intervalSeconds?: number }): Promise<void>;
}

export class TransactionProcessor {
  private readonly outbox: WebhookOutbox;

  constructor(
    private readonly db: Db,
    private readonly sendCommand: TransactionCommandSender,
    private readonly log: (line: string) => void = console.log,
  ) {
    this.outbox = new WebhookOutbox(db);
  }

  /** Our row for the device's transaction id, if any. */
  async find(deviceId: number, transactionId: string): Promise<Transaction | undefined> {
    const { transactions } = schema;
    return (await this.db.select().from(transactions).where(and(eq(transactions.deviceId, deviceId), eq(transactions.transactionId, transactionId))).orderBy(sql`requested_at desc`).limit(1))[0];
  }

  /**
   * The device's retained transaction state, seen on every (re)connect and after each command.
   * This is where acks, queued stops and "the device runs something we don't know" meet.
   */
  async onState(deviceId: number, identity: string, state: TransactionState): Promise<void> {
    if (!state.active || !state.txId) return;
    const tx = await this.find(deviceId, state.txId);
    if (!tx) {
      // Charging nobody asked for (backend lost the row, or a stale device): shut it down.
      this.log(`${identity} reports unknown transaction ${state.txId}: stopping it`);
      await this.sendCommand(identity, { op: "stop", txId: state.txId }).catch((e: Error) => this.log(`could not stop ${state.txId}: ${e.message}`));
      return;
    }
    switch (tx.state) {
      case "starting": {
        const [started] = await this.db
          .update(schema.transactions)
          .set({ state: "active", startedAt: new Date(), meterStartKwh: state.meterStart })
          .where(and(eq(schema.transactions.id, tx.id), eq(schema.transactions.state, "starting")))
          .returning();
        if (!started) return; // raced with another transition
        this.log(`tx ${tx.transactionId} active on ${identity}`);
        await this.outbox.enqueue(tx.tenantId, tx.id, {
          eventType: "TransactionStarted",
          deviceIdentity: identity,
          transactionId: tx.transactionId,
          data: { startedAt: started.startedAt!.toISOString(), meterStartKwh: state.meterStart, meterValueIntervalSeconds: state.intervalSeconds ?? tx.meterValueIntervalSeconds },
        });
        return;
      }
      case "stopping":
        // A stop requested while the device was away: it is back and still charging, so send it now.
        this.log(`tx ${tx.transactionId}: device back online, re-sending queued stop`);
        await this.sendCommand(identity, { op: "stop", txId: tx.transactionId }).catch((e: Error) => this.log(`could not stop ${tx.transactionId}: ${e.message}`));
        return;
      case "failed":
        // We gave up on it, the device did not: nothing may charge that the backend thinks is over.
        this.log(`tx ${tx.transactionId} was marked failed but ${identity} runs it: stopping`);
        await this.sendCommand(identity, { op: "stop", txId: tx.transactionId }).catch((e: Error) => this.log(`could not stop ${tx.transactionId}: ${e.message}`));
        return;
      default:
        return; // active: consistent; stopped: the tx/end already handled it
    }
  }

  /** devices/<id>/tx/end: the device ended a transaction, with its own energy accounting. */
  async onEnd(deviceId: number, identity: string, end: TransactionEnd): Promise<void> {
    const tx = await this.find(deviceId, end.txId);
    if (!tx || tx.state === "stopped") return;
    const stoppedAt = new Date();
    const stats = await this.statistics(tx.id);
    const energyQuality = end.energyWh === null ? "partial" : "metered";
    const [stopped] = await this.db
      .update(schema.transactions)
      .set({
        state: "stopped",
        stoppedAt,
        // A transaction that ended before it was ever confirmed still gets its start stamped.
        startedAt: tx.startedAt ?? stoppedAt,
        stopReason: end.reason,
        meterStartKwh: end.meterStart ?? tx.meterStartKwh,
        meterStopKwh: end.meterStop,
        energyWh: end.energyWh,
        energyQuality,
        ...stats,
      })
      .where(and(eq(schema.transactions.id, tx.id), inArray(schema.transactions.state, ["starting", "active", "stopping", "failed"])))
      .returning();
    if (!stopped) return;
    this.log(`tx ${tx.transactionId} stopped on ${identity} (${end.reason}): ${end.energyWh ?? "?"} Wh`);
    await this.outbox.enqueue(tx.tenantId, tx.id, {
      eventType: "TransactionStopped",
      deviceIdentity: identity,
      transactionId: tx.transactionId,
      data: summaryOf(stopped),
    });
  }

  /** devices/<id>/tx/meter: forwarded to the tenant as MeterValues (best effort, no retries). */
  async onMeterValue(deviceId: number, identity: string, value: TransactionMeterValue, receivedAt: Date): Promise<void> {
    const tx = await this.find(deviceId, value.txId);
    if (!tx || (tx.state !== "active" && tx.state !== "stopping")) return;
    await this.outbox.enqueue(
      tx.tenantId,
      tx.id,
      {
        eventType: "MeterValues",
        deviceIdentity: identity,
        transactionId: tx.transactionId,
        data: {
          receivedAt: receivedAt.toISOString(),
          seq: value.seq,
          energyWh: value.energyWh,
          meterKwh: value.meterKwh,
          reading: value.reading,
        },
      },
      { retry: false },
    );
  }

  /** Marks `starting` transactions past the deadline as failed. Run periodically. */
  async sweepStartTimeouts(now = new Date()): Promise<number> {
    const { transactions, devices } = schema;
    const expired = await this.db
      .update(transactions)
      .set({ state: "failed", stopReason: "failed", failureReason: "the device did not confirm the start" })
      .where(and(eq(transactions.state, "starting"), lt(transactions.requestedAt, new Date(now.getTime() - START_DEADLINE_MS))))
      .returning();
    for (const tx of expired) {
      const [device] = await this.db.select({ identity: devices.identity }).from(devices).where(eq(devices.id, tx.deviceId));
      this.log(`tx ${tx.transactionId} failed: no confirmation from ${device?.identity ?? tx.deviceId}`);
      await this.outbox.enqueue(tx.tenantId, tx.id, {
        eventType: "TransactionFailed",
        deviceIdentity: device?.identity ?? String(tx.deviceId),
        transactionId: tx.transactionId,
        data: { reason: tx.failureReason },
      });
    }
    return expired.length;
  }

  /** Aggregates over the readings stored for this transaction. */
  private async statistics(transactionRowId: string) {
    const { meterReadings } = schema;
    const [row] = await this.db
      .select({
        powerAvgW: sql<number | null>`avg(power)::real`,
        powerMaxW: sql<number | null>`max(power)::real`,
        currentMaxA: sql<number | null>`max(current)::real`,
        voltageMinV: sql<number | null>`min(voltage)::real`,
        voltageMaxV: sql<number | null>`max(voltage)::real`,
        sampleCount: sql<number>`count(*)::int`,
        meterUnreadableSamples: sql<number>`count(*) filter (where not ok)::int`,
      })
      .from(meterReadings)
      .where(eq(meterReadings.transactionId, transactionRowId));
    return row!;
  }
}

export function summaryOf(tx: Transaction) {
  return {
    startedAt: tx.startedAt?.toISOString() ?? null,
    stoppedAt: tx.stoppedAt?.toISOString() ?? null,
    durationSeconds: tx.startedAt && tx.stoppedAt ? Math.round((tx.stoppedAt.getTime() - tx.startedAt.getTime()) / 1000) : null,
    stopReason: tx.stopReason,
    energyWh: tx.energyWh,
    energyQuality: tx.energyQuality,
    meterStartKwh: tx.meterStartKwh,
    meterStopKwh: tx.meterStopKwh,
    powerAvgW: tx.powerAvgW,
    powerMaxW: tx.powerMaxW,
    currentMaxA: tx.currentMaxA,
    voltageMinV: tx.voltageMinV,
    voltageMaxV: tx.voltageMaxV,
    sampleCount: tx.sampleCount,
    meterUnreadableSamples: tx.meterUnreadableSamples,
  };
}
