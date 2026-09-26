import { schema, type Db, type Transaction } from "@chargelatch/db";
import { and, desc, eq, inArray } from "drizzle-orm";

/** States in which a transaction still occupies its device. */
export const OPEN_STATES = ["starting", "active", "stopping"] as const;

export interface NewTransaction {
  tenantId: string;
  transactionId: string;
  deviceId: number;
  meterValueIntervalSeconds: number;
}

/**
 * The API only ever creates transactions (`starting`) and flags stop requests (`stopping`).
 * Every other transition comes from device events and is written by the telemetry service.
 */
export interface TransactionStore {
  create(tx: NewTransaction): Promise<Transaction>;
  get(tenantId: string, transactionId: string): Promise<Transaction | undefined>;
  /** The transaction currently occupying a device, if any. */
  openForDevice(deviceId: number): Promise<Transaction | undefined>;
  markStopping(id: string): Promise<Transaction | undefined>;
  listForTenant(tenantId: string, limit: number): Promise<Transaction[]>;
}

export function createTransactionStore(db: Db): TransactionStore {
  const { transactions } = schema;
  return {
    create: async (tx) => (await db.insert(transactions).values(tx).returning())[0]!,
    get: async (tenantId, transactionId) =>
      (await db.select().from(transactions).where(and(eq(transactions.tenantId, tenantId), eq(transactions.transactionId, transactionId))))[0],
    openForDevice: async (deviceId) =>
      (
        await db
          .select()
          .from(transactions)
          .where(and(eq(transactions.deviceId, deviceId), inArray(transactions.state, [...OPEN_STATES])))
          .orderBy(desc(transactions.requestedAt))
          .limit(1)
      )[0],
    markStopping: async (id) =>
      (await db.update(transactions).set({ state: "stopping", stopRequestedAt: new Date() }).where(and(eq(transactions.id, id), inArray(transactions.state, ["starting", "active"]))).returning())[0],
    listForTenant: (tenantId, limit) => db.select().from(transactions).where(eq(transactions.tenantId, tenantId)).orderBy(desc(transactions.requestedAt)).limit(limit),
  };
}
