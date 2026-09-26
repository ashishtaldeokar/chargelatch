import { schema, type Db, type Tenant } from "@chargelatch/db";
import { asc, eq } from "drizzle-orm";

export interface NewTenant {
  id: string;
  name: string;
  keycloakClientId: string;
  webhookUrl: string | null;
  meterValueIntervalSeconds: number;
}

export interface TenantStore {
  create(tenant: NewTenant): Promise<Tenant>;
  update(id: string, patch: Partial<Omit<NewTenant, "id">>): Promise<Tenant | undefined>;
  list(): Promise<Tenant[]>;
  get(id: string): Promise<Tenant | undefined>;
  /** Maps a service-account client (token `azp`) to its tenant. */
  getByClientId(clientId: string): Promise<Tenant | undefined>;
}

export function createTenantStore(db: Db): TenantStore {
  const { tenants } = schema;
  return {
    create: async (tenant) => (await db.insert(tenants).values(tenant).returning())[0]!,
    update: async (id, patch) => (await db.update(tenants).set(patch).where(eq(tenants.id, id)).returning())[0],
    list: () => db.select().from(tenants).orderBy(asc(tenants.id)),
    get: async (id) => (await db.select().from(tenants).where(eq(tenants.id, id)))[0],
    getByClientId: async (clientId) => (await db.select().from(tenants).where(eq(tenants.keycloakClientId, clientId)))[0],
  };
}
