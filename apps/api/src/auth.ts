import { createRemoteJWKSet, jwtVerify } from "jose";
import { createMiddleware } from "hono/factory";

export interface AuthClaims {
  sub: string;
  email?: string;
  roles: string[];
}

/** Verifies a bearer token and returns its claims, or throws. Injected so tests need no Keycloak. */
export interface TokenVerifier {
  verify(token: string): Promise<AuthClaims>;
}

export type AuthEnv = { Variables: { auth: AuthClaims } };

/**
 * Verifies Keycloak access tokens against the realm's published signing keys. `issuer` is the
 * realm URL exactly as it appears in the token's `iss` (e.g. http://localhost:8080/realms/chargelatch);
 * `audience` is what the clients' audience mappers add (chargelatch-api).
 */
export function createKeycloakVerifier(issuer: string, audience: string): TokenVerifier {
  const jwks = createRemoteJWKSet(new URL(`${issuer}/protocol/openid-connect/certs`));
  return {
    verify: async (token) => {
      const { payload } = await jwtVerify(token, jwks, { issuer, audience });
      const realmAccess = payload.realm_access as { roles?: string[] } | undefined;
      return {
        sub: payload.sub ?? "",
        email: typeof payload.email === "string" ? payload.email : undefined,
        roles: realmAccess?.roles ?? [],
      };
    },
  };
}

/** 401 without a valid token, 403 without the realm role. Sets `c.var.auth`. */
export function requireRole(verifier: TokenVerifier, role: string) {
  return createMiddleware<AuthEnv>(async (c, next) => {
    const token = c.req.header("authorization")?.match(/^Bearer (.+)$/i)?.[1];
    if (!token) return c.json({ error: "Missing bearer token" }, 401);

    let claims: AuthClaims;
    try {
      claims = await verifier.verify(token);
    } catch {
      return c.json({ error: "Invalid or expired token" }, 401);
    }
    if (!claims.roles.includes(role)) return c.json({ error: `Requires the "${role}" role` }, 403);

    c.set("auth", claims);
    await next();
  });
}
