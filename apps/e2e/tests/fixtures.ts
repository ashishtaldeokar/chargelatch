import { createDb, schema, type Db } from "@chargelatch/db";
import { seeds } from "@chargelatch/db/seed";
import { test as base } from "@playwright/test";
import { sql } from "drizzle-orm";

/**
 * `db` gives tests direct database access for arranging/asserting state.
 * It is auto-used so every test starts from a freshly seeded database.
 */
export const test = base.extend<{ db: Db }>({
  db: [
    async ({}, use) => {
      const { db, close } = createDb(process.env.DATABASE_URL!, { max: 1 });
      await db.delete(schema.users);
      // Restart the counter too, so every test starts issuing identities at SONIK-1.
      await db.execute(sql`truncate table devices restart identity`);
      await seeds.e2e(db);
      await use(db);
      await close();
    },
    { auto: true },
  ],
});

export { expect } from "@playwright/test";
