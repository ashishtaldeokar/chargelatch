import { createDb, type Db } from "./client.ts";
import { users, type NewUser } from "./schema.ts";

export const seedUsers = [
  { email: "ada@example.com", name: "Ada Lovelace" },
  { email: "grace@example.com", name: "Grace Hopper" },
] satisfies NewUser[];

/** Named datasets. Add one per scenario (e.g. e2e fixtures) and pick it with `seed(url, name)`. */
export const seeds = {
  dev: async (db: Db) => {
    await db.insert(users).values(seedUsers).onConflictDoNothing();
  },
  e2e: async (db: Db) => {
    await db.insert(users).values(seedUsers).onConflictDoNothing();
  },
} satisfies Record<string, (db: Db) => Promise<void>>;

export type SeedName = keyof typeof seeds;

export async function seed(url: string, name: SeedName = "dev") {
  const { db, close } = createDb(url, { max: 1 });
  try {
    await seeds[name](db);
  } finally {
    await close();
  }
}
