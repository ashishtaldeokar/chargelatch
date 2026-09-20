-- Idempotent: the dev/e2e image already creates these (infra/postgres/init), but the schema
-- must also stand on its own against a database that did not come from that image.
CREATE EXTENSION IF NOT EXISTS timescaledb;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS postgis;
