# Redis

`redis:8-alpine` with `redis.conf` baked in and a `HEALTHCHECK` (`redis-cli ping`).

## What is baked in, and why

Redis is a **pure cache** here:

- `maxmemory 256mb` + `maxmemory-policy allkeys-lru`: bounded, evicts least-recently-used keys.
- `save ""` + `appendonly no`: no persistence. There is deliberately **no volume** in compose.
  Everything cached can be rebuilt from Postgres, so a restart wiping it is fine. Do not store
  anything here that cannot be recomputed.
- `bind 0.0.0.0` + `protected-mode no`: needed so other containers (and the published dev port)
  can connect without auth. This is acceptable because the container network is the boundary.
  In production the port must not be published beyond that network.

## Changing config

Edit `redis.conf`, then `pnpm services:up` (it rebuilds). Commit the file.

## One image everywhere

- **Dev:** compose builds this directory as `chargelatch/redis:dev` on `localhost:6379`.
- **E2E:** `apps/e2e/src/helpers/redis.ts` builds the same Dockerfile through Testcontainers
  (`chargelatch/redis:e2e`) and waits on the `HEALTHCHECK`.
- **Production:** build and push the same Dockerfile.
