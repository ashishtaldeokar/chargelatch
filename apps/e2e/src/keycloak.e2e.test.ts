import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  decodeJwtPayload,
  FIXTURE_USERS,
  getAccessToken,
  getServiceAccountToken,
  REALM,
  startKeycloak,
  type StartedKeycloak,
} from "./helpers/keycloak.ts";

interface Claims {
  iss: string;
  aud: string | string[];
  azp: string;
  email: string;
  realm_access: { roles: string[] };
}

let keycloak: StartedKeycloak;

// The first run builds the image and boots Keycloak, which can take a couple of minutes.
beforeAll(async () => {
  keycloak = await startKeycloak();
}, 300_000);

afterAll(async () => {
  await keycloak?.stop();
});

describe("realm import", () => {
  test("the chargelatch realm exists", async () => {
    const res = await fetch(`${keycloak.baseUrl}/realms/${REALM}/.well-known/openid-configuration`);
    expect(res.status).toBe(200);
    const discovery = (await res.json()) as { issuer: string };
    expect(discovery.issuer).toBe(`${keycloak.baseUrl}/realms/${REALM}`);
  });

  test("issues a token for the admin fixture with the api audience and roles", async () => {
    const claims = decodeJwtPayload<Claims>(await getAccessToken(keycloak.baseUrl, FIXTURE_USERS.admin));
    expect(claims.azp).toBe("chargelatch-api");
    expect([claims.aud].flat()).toContain("chargelatch-api");
    expect(claims.email).toBe(FIXTURE_USERS.admin.username);
    expect(claims.realm_access.roles).toEqual(expect.arrayContaining(["admin", "user"]));
  });

  test("the user fixture is not an admin", async () => {
    const claims = decodeJwtPayload<Claims>(await getAccessToken(keycloak.baseUrl, FIXTURE_USERS.user));
    expect(claims.realm_access.roles).toContain("user");
    expect(claims.realm_access.roles).not.toContain("admin");
  });

  test("the factory fixture has the factory role, regular users do not", async () => {
    const factory = decodeJwtPayload<Claims>(await getAccessToken(keycloak.baseUrl, FIXTURE_USERS.factory));
    expect(factory.realm_access.roles).toContain("factory");
    const user = decodeJwtPayload<Claims>(await getAccessToken(keycloak.baseUrl, FIXTURE_USERS.user));
    expect(user.realm_access.roles).not.toContain("factory");
  });

  test("the automation service account gets an admin token without any user", async () => {
    const claims = decodeJwtPayload<Claims>(await getServiceAccountToken(keycloak.baseUrl));
    expect([claims.aud].flat()).toContain("chargelatch-api");
    expect(claims.realm_access.roles).toContain("admin");
    expect(claims.azp).toBe("chargelatch-automation");
  });

  test("rejects a wrong password", async () => {
    const attempt = getAccessToken(keycloak.baseUrl, { ...FIXTURE_USERS.user, password: "nope" });
    expect(attempt).rejects.toThrow(/invalid_grant/);
  });
});

describe("login theme", () => {
  test("the login page links the chargelatch theme css, and keycloak serves it", async () => {
    const loginUrl = new URL(`${keycloak.baseUrl}/realms/${REALM}/protocol/openid-connect/auth`);
    loginUrl.search = new URLSearchParams({
      client_id: "chargelatch-admin-web",
      redirect_uri: "http://localhost:5173/",
      response_type: "code",
      scope: "openid",
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
    }).toString();

    const page = await fetch(loginUrl);
    expect(page.status).toBe(200);
    const html = await page.text();

    const href = html.match(/href="([^"]*\/login\/chargelatch\/css\/chargelatch\.css)"/)?.[1];
    expect(href).toBeDefined();

    const css = await fetch(new URL(href!, keycloak.baseUrl));
    expect(css.status).toBe(200);
    expect(await css.text()).toContain("--chargelatch-accent");
  });
});
