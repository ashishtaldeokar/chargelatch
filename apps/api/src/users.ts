import { schema, type Db, type NewUser, type User } from "@chargelatch/db";

export interface UserStore {
  list(): Promise<User[]>;
  create(user: NewUser): Promise<User>;
}

export function createUserStore(db: Db): UserStore {
  return {
    list: () => db.select().from(schema.users).orderBy(schema.users.createdAt),
    create: async (user) => {
      const [created] = await db.insert(schema.users).values(user).returning();
      return created!;
    },
  };
}
