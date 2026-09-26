import { swaggerUI } from "@hono/swagger-ui";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { User } from "@chargelatch/db";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import type { TokenVerifier } from "./auth.ts";
import type { DeviceBus } from "./device-bus.ts";
import type { DeviceStore } from "./devices.ts";
import type { TelemetryStore } from "./telemetry.ts";
import type { TenantStore } from "./tenants.ts";
import type { TransactionStore } from "./transactions.ts";
import { createAdminRoutes } from "./admin.ts";
import { createFactoryRoutes } from "./factory.ts";
import { createPartnerRoutes, PARTNER_TAG } from "./partner.ts";
import { defaultHook, json, openApiInfo } from "./openapi.ts";
import { ErrorSchema, HealthSchema, NewUserSchema, UserSchema } from "./schemas.ts";
import type { UserStore } from "./users.ts";

export { openApiInfo };

export interface AppDeps {
  users: UserStore;
  devices: DeviceStore;
  bus: DeviceBus;
  telemetry: TelemetryStore;
  tenants: TenantStore;
  transactions: TransactionStore;
  auth: TokenVerifier;
  /** Keycloak token endpoint, shown in the docs so partners can authorise in Swagger UI. */
  tokenUrl?: string;
}

const healthRoute = createRoute({
  method: "get",
  path: "/api/health",
  tags: ["system"],
  summary: "Liveness check",
  responses: { 200: json(HealthSchema, "The API is up") },
});

const listUsersRoute = createRoute({
  method: "get",
  path: "/api/users",
  tags: ["users"],
  summary: "List users",
  responses: { 200: json(z.array(UserSchema), "All users, oldest first") },
});

const createUserRoute = createRoute({
  method: "post",
  path: "/api/users",
  tags: ["users"],
  summary: "Create a user",
  request: { body: { ...json(NewUserSchema, "The user to create"), required: true } },
  responses: {
    201: json(UserSchema, "The created user"),
    400: json(ErrorSchema, "The request body is invalid"),
  },
});

const toUserDto = (user: User) => ({ ...user, createdAt: user.createdAt.toISOString() });

export function createApp({ users, devices, bus, telemetry, tenants, transactions, auth, tokenUrl = "http://localhost:8080/realms/chargelatch/protocol/openid-connect/token" }: AppDeps) {
  const app = new OpenAPIHono({ defaultHook });

  app.use(logger());
  app.use("/api/*", cors());

  app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
    type: "http",
    scheme: "bearer",
    bearerFormat: "JWT",
    description: "Keycloak access token (realm `chargelatch`, audience `chargelatch-api`)",
  });
  // Partners authorise with their service account: Swagger UI's "Authorize" takes the client id and
  // secret and fetches the token itself (Keycloak allows that from the docs origin via the
  // client's web origins).
  app.openAPIRegistry.registerComponent("securitySchemes", "partnerAuth", {
    type: "oauth2",
    description: "Tenant service account (OAuth2 client credentials). Use your client id and secret.",
    flows: { clientCredentials: { tokenUrl, scopes: {} } },
  });
  app.doc31("/api/openapi.json", openApiInfo);
  app.get("/api/docs", swaggerUI({ url: "/api/openapi.json" }));

  // A spec with only the partner-facing operations, for sharing with tenants.
  app.get("/api/partner/openapi.json", (c) => {
    const full = app.getOpenAPI31Document(openApiInfo);
    const paths = Object.fromEntries(
      Object.entries(full.paths ?? {})
        .map(([path, ops]) => [path, Object.fromEntries(Object.entries(ops as Record<string, { tags?: string[] }>).filter(([, op]) => op.tags?.includes(PARTNER_TAG)))] as const)
        .filter(([, ops]) => Object.keys(ops).length > 0),
    );
    return c.json({ ...full, info: { ...full.info, title: "chargelatch partner API" }, paths });
  });
  app.get("/api/partner/docs", swaggerUI({ url: "/api/partner/openapi.json" }));

  return app
    .openapi(healthRoute, (c) => c.json({ status: "ok" as const }, 200))
    .openapi(listUsersRoute, async (c) => c.json((await users.list()).map(toUserDto), 200))
    .openapi(createUserRoute, async (c) => c.json(toUserDto(await users.create(c.req.valid("json"))), 201))
    .route("/", createFactoryRoutes(devices, auth))
    .route("/", createAdminRoutes(devices, bus, telemetry, tenants, auth))
    .route("/", createPartnerRoutes(devices, transactions, tenants, bus, auth));
}

// For typed clients via `hc<AppType>()` from "hono/client".
export type AppType = ReturnType<typeof createApp>;
