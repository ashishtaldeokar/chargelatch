import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "./client.ts";

const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

/** Applies all pending migrations from ./migrations. */
export async function runMigrations(url: string) {
  const { db, close } = createDb(url, { max: 1, onnotice: () => {} });
  try {
    await migrate(db, { migrationsFolder });
  } finally {
    await close();
  }
}
