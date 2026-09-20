import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.ts";

export function createDb(url: string, options: postgres.Options<{}> = {}) {
  const sql = postgres(url, options);
  const db = drizzle(sql, { schema });
  return { db, close: () => sql.end() };
}

export type Db = ReturnType<typeof createDb>["db"];

export function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return url;
}
