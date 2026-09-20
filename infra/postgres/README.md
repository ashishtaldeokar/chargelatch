# Postgres (TimescaleDB + PostGIS)

`timescale/timescaledb-ha:pg17.11-ts2.30.1` (Postgres 17.11, TimescaleDB 2.30.1, PostGIS and
`timescaledb_toolkit` available) with the init scripts baked in and a `HEALTHCHECK`.

This is the Timescale-licensed (community) build, which includes compression, continuous
aggregates and retention policies. The `-oss` tag variant is Apache-2 only and lacks those.

## What is baked in, and why

`init/` → `/docker-entrypoint-initdb.d/`. One server hosts one database per consumer:

| Database      | Owner                  | Extensions             |
| ------------- | ---------------------- | ---------------------- |
| `keycloak`    | Keycloak (dev compose) | (timescaledb, inherited from template1, unused) |
| `chargelatch` | `apps/api`             | `timescaledb`, `postgis` |

Dev credentials: `postgres` / `postgres` on `localhost:5432`.

The app's first migration (`packages/db/migrations`) also runs `CREATE EXTENSION IF NOT EXISTS`
for both, so the schema is self-sufficient on a database that did not come from this image
(e.g. a managed production instance, which must have both extensions available).

The `HEALTHCHECK` probes over TCP on purpose: during first-boot init Postgres runs a temporary
socket-only server and then restarts, and a socket probe would report healthy too early.

Differences from the stock `postgres` image worth knowing:

- data lives in `/home/postgres/pgdata` (that is what the compose volume mounts), not
  `/var/lib/postgresql/data`;
- the image runs `timescaledb-tune` on first boot, sizing memory settings to the host.

## Adding a database or extension

Add a file to `init/` numbered **100 or higher** (the base image's own scripts use 000-010 and
must run first).

**Init scripts only run on the first boot of an empty data volume.** Anyone who already has a
`postgres-data` volume must either run the statements by hand:

```sh
docker compose exec postgres psql -U postgres -c 'CREATE DATABASE <name>;'
docker compose exec postgres psql -U postgres -d <name> -c 'CREATE EXTENSION IF NOT EXISTS postgis;'
```

or reset everything with `docker compose down -v` (this also wipes Keycloak's dev state, which
is then re-imported from `infra/keycloak/realms/`).

## One image everywhere

- **Dev:** compose builds this directory as `chargelatch/postgres:dev` on `localhost:5432`.
- **E2E:** `apps/e2e/src/helpers/postgres.ts` builds the same Dockerfile through Testcontainers
  (`chargelatch/postgres:e2e`) and hands tests the `chargelatch` database the init scripts made.
- **Production:** build the same Dockerfile, or use a managed Postgres offering both extensions.
