import { sql } from "drizzle-orm";
import { createDb, requireDatabaseUrl } from "../client.ts";
import { runMigrations } from "../migrate.ts";

// Drops everything, then re-applies migrations. Never point this at production.
const url = requireDatabaseUrl();
const { db, close } = createDb(url, { max: 1, onnotice: () => {} });
await db.execute(sql`drop schema if exists public cascade`);
await db.execute(sql`drop schema if exists drizzle cascade`);
await db.execute(sql`create schema public`);
await close();

await runMigrations(url);
console.log("database reset");
