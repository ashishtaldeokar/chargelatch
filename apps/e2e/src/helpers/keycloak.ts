import { join } from "node:path";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";

// The same build context docker-compose.yml uses, so dev and e2e cannot drift.
export const KEYCLOAK_BUILD_CONTEXT = join(import.meta.dir, "../../../../infra/keycloak");

export const REALM = "chargelatch";
export const API_CLIENT = { id: "chargelatch-api", secret: "dev-secret" };
/** Service account for machine-to-machine API access (client_credentials), realm role `admin`. */
export const AUTOMATION_CLIENT = { id: "chargelatch-automation", secret: "dev-automation-secret" };
export const FIXTURE_USERS = {
  admin: { username: "admin@chargelatch.dev", password: "admin" },
  user: { username: "user@chargelatch.dev", password: "user" },
  factory: { username: "factory@chargelatch.dev", password: "factory" },
};

export interface StartedKeycloak {
  container: StartedTestContainer;
  baseUrl: string;
  stop(): Promise<void>;
}

export function keycloakBaseUrl(host: string, port: number): string {
  return `http://${host}:${port}`;
}

/**
 * Runs on Keycloak's embedded dev database (no Postgres needed): the realm import baked
 * into the image is what is under test.
 */
export async function startKeycloak(): Promise<StartedKeycloak> {
  // deleteOnExit: false keeps the image so Docker's layer cache makes later runs fast.
  const image = await GenericContainer.fromDockerfile(KEYCLOAK_BUILD_CONTEXT).build("chargelatch/keycloak:e2e", {
    deleteOnExit: false,
  });
  const container = await image
    .withExposedPorts(8080)
    .withEnvironment({ KC_BOOTSTRAP_ADMIN_USERNAME: "admin", KC_BOOTSTRAP_ADMIN_PASSWORD: "admin" })
    .withWaitStrategy(Wait.forHealthCheck())
    .withStartupTimeout(180_000)
    .start();

  return {
    container,
    baseUrl: keycloakBaseUrl(container.getHost(), container.getMappedPort(8080)),
    stop: async () => {
      await container.stop();
    },
  };
}

export interface PasswordGrant {
  username: string;
  password: string;
  realm?: string;
  clientId?: string;
  clientSecret?: string;
}

/** Mints an access token through the password grant on the confidential API client. */
export async function getAccessToken(baseUrl: string, grant: PasswordGrant): Promise<string> {
  const { realm = REALM, clientId = API_CLIENT.id, clientSecret = API_CLIENT.secret } = grant;
  const res = await fetch(`${baseUrl}/realms/${realm}/protocol/openid-connect/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "password",
      client_id: clientId,
      client_secret: clientSecret,
      username: grant.username,
      password: grant.password,
      scope: "openid",
    }),
  });
  if (!res.ok) throw new Error(`token request failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

/** Mints an access token for a service-account client (no user involved). */
export async function getServiceAccountToken(baseUrl: string, client = AUTOMATION_CLIENT, realm = REALM): Promise<string> {
  const res = await fetch(`${baseUrl}/realms/${realm}/protocol/openid-connect/token`, {
    method: "POST",
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: client.id, client_secret: client.secret }),
  });
  if (!res.ok) throw new Error(`service account token request failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

/** Decodes a JWT payload WITHOUT verifying the signature. For asserting claims in tests only. */
export function decodeJwtPayload<T = Record<string, unknown>>(token: string): T {
  const payload = token.split(".")[1];
  if (!payload) throw new Error("not a JWT");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as T;
}
