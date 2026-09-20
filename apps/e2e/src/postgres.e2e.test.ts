import { afterAll, beforeAll, expect, test } from "bun:test";
import { SQL } from "bun";
import { startPostgres, type StartedPostgres } from "./helpers/postgres.ts";

let postgres: StartedPostgres;
let sql: SQL;

beforeAll(async () => {
  postgres = await startPostgres();
  sql = new SQL(postgres.url());
}, 300_000);

afterAll(async () => {
  await sql?.close();
  await postgres?.stop();
});

test("accepts a connection and runs a query", async () => {
  const [row] = await sql`select 1 + 1 as sum, current_database() as db, version() as version`;
  expect(row.sum).toBe(2);
  expect(row.db).toBe("chargelatch");
  expect(row.version).toContain("PostgreSQL 17");
});

test("has timescaledb and postgis installed in the app database", async () => {
  const rows = await sql`select extname from pg_extension`;
  const installed = rows.map((r: { extname: string }) => r.extname);
  expect(installed).toEqual(expect.arrayContaining(["timescaledb", "postgis"]));
});

test("hypertables and geography queries work", async () => {
  await sql`create table readings (time timestamptz not null, station text, location geography(point, 4326), kw real)`;
  await sql`select create_hypertable('readings', by_range('time'))`;
  await sql`insert into readings values (now(), 'pune', st_makepoint(73.8567, 18.5204)::geography, 7.4)`;

  const [hypertable] = await sql`select hypertable_name from timescaledb_information.hypertables`;
  expect(hypertable.hypertable_name).toBe("readings");

  // Pune -> Mumbai is roughly 120 km.
  const [row] = await sql`
    select st_distance(location, st_makepoint(72.8777, 19.0760)::geography) / 1000 as km from readings`;
  expect(row.km).toBeGreaterThan(100);
  expect(row.km).toBeLessThan(140);
  await sql`drop table readings`;
});

test("the baked init scripts created the keycloak database", async () => {
  const [row] = await sql`select count(*)::int as n from pg_database where datname = 'keycloak'`;
  expect(row.n).toBe(1);
});

test("rejects an invalid query", async () => {
  // A Bun.sql query is a lazy thenable, not a Promise: handing it straight to
  // expect().rejects never settles. Await it inside an async wrapper instead.
  const run = async () => await sql`select * from table_that_does_not_exist`;
  expect(run()).rejects.toThrow();
});
