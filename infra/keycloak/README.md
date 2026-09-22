# Keycloak

`quay.io/keycloak/keycloak:26.7.4` with the realm export and login theme baked in, plus a
`HEALTHCHECK`. Runs `start-dev --import-realm`.

## What is baked in, and why

- `realms/chargelatch-realm.json` → `/opt/keycloak/data/import/`. The realm is the source of
  truth for clients, roles, mappers and fixture users.
- `themes/chargelatch/` → `/opt/keycloak/themes/`. A scaffold login theme (extends
  `keycloak.v2`, adds `css/chargelatch.css`), bound as the realm's login theme.
- `KC_HEALTH_ENABLED=true` and a `HEALTHCHECK`. The image has no curl/wget and health lives on
  the management port **9000**, so the probe speaks HTTP over bash's `/dev/tcp`. Testcontainers
  under Bun only works with `Wait.forHealthCheck()`, so this is load-bearing, as is compose's
  `service_healthy`.

## The `chargelatch` realm

| Client               | Type                 | Notes                                                                  |
| -------------------- | -------------------- | ---------------------------------------------------------------------- |
| `chargelatch-api`    | confidential         | secret `dev-secret`; direct-access (password) grant on, for tests/tooling |
| `chargelatch-admin-web` | public, PKCE (S256) | redirects `http://localhost:5173/*`, `http://localhost:5273/*` (e2e)   |
| `chargelatch-admin-mobile` | public, PKCE (S256) | redirect `com.sonik.chargelatch.admin:/*` (Flutter app id)      |
| `chargelatch-automation` | confidential, **service account** | secret `dev-automation-secret`; `client_credentials` only (no user, no browser flow); its service-account user has realm role `admin`. For scripts, cron, integrations. |
| `chargelatch-factory` | public, PKCE (S256) | redirects `http://localhost:5174/*`, `http://localhost:5274/*` (e2e)   |

Every client has an audience mapper, so access tokens carry `aud: chargelatch-api`.
Realm roles: `admin`, `user`, `factory` (may issue device identities; enforced by the API on `/api/factory/*`). `admin` is also what `/api/admin/*` requires, e.g. to read a device's provisioning PoP.

### Dev-only fixtures — never use outside local dev / e2e

| User                    | Password | Roles           |
| ----------------------- | -------- | --------------- |
| `admin@chargelatch.dev` | `admin`  | `admin`, `user`, `factory` |
| `user@chargelatch.dev`  | `user`   | `user`          |
| `factory@chargelatch.dev` | `factory` | `factory`, `user` |

Machine-to-machine token (no user):

```sh
curl -s http://localhost:8080/realms/chargelatch/protocol/openid-connect/token \
  -d grant_type=client_credentials -d client_id=chargelatch-automation -d client_secret=dev-automation-secret
```

Admin console: <http://localhost:8080> with `admin` / `admin`. The fixture users, the
`dev-secret` client secret and the bootstrap admin are all committed and public. A production
realm must not contain them.

## Changing the realm

1. Edit in the admin console (dev Keycloak is backed by Postgres, so changes survive restarts).
2. `pnpm keycloak:export` (or `bun infra/keycloak/export-realm.ts <realm>` for another realm).
3. Review and commit the JSON diff, then `docker compose build keycloak`.

The export runs as a one-off container against the shared Postgres, so the dev server keeps
running. The script **strips the realm's key providers** from the file: a raw export contains the
signing private keys, and committing them would make every environment share keys that live in
git. Without them Keycloak generates fresh keys on import.

**`--import-realm` only imports a realm that does not exist yet.** So:

- admin-console edits are never overwritten on restart;
- a new `realms/<other>-realm.json` is imported on the next boot without touching existing data;
- hand-editing `chargelatch-realm.json` has **no effect** on a dev environment that already has
  the realm. Use the console + export, or reset with `docker compose down -v`.

## Themes

Compose bind-mounts `themes/` over `/opt/keycloak/themes`, and `start-dev` disables theme
caching, so edits show on a browser refresh. E2E and production get themes from the image build.

## One image everywhere

- **Dev:** compose builds this directory as `chargelatch/keycloak:dev`, backed by the `keycloak`
  database in the compose Postgres.
- **E2E:** `apps/e2e/src/helpers/keycloak.ts` builds the same Dockerfile through Testcontainers
  (`chargelatch/keycloak:e2e`) on the embedded dev database, since the baked realm import is
  what is under test.
- **Production:** same build context, but override the command (`start`, not `start-dev`), supply
  a real database/hostname, and import a realm without the dev fixtures.
