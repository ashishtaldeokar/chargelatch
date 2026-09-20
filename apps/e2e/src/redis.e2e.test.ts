import { afterAll, beforeAll, expect, test } from "bun:test";
import { RedisClient } from "bun";
import { startRedis, type StartedRedis } from "./helpers/redis.ts";

let redis: StartedRedis;
let client: RedisClient;

beforeAll(async () => {
  redis = await startRedis();
  client = new RedisClient(redis.url);
}, 180_000);

afterAll(async () => {
  client?.close();
  await redis?.stop();
});

async function config(name: string): Promise<string> {
  const reply = (await client.send("CONFIG", ["GET", name])) as Record<string, string> | string[];
  return Array.isArray(reply) ? reply[1]! : reply[name]!;
}

test("answers and round-trips a value", async () => {
  expect(await client.send("PING", [])).toBe("PONG");
  await client.set("smoke", "ok");
  expect(await client.get("smoke")).toBe("ok");
});

test("is configured as a bounded LRU cache", async () => {
  expect(await config("maxmemory-policy")).toBe("allkeys-lru");
  expect(await config("maxmemory")).toBe(String(256 * 1024 * 1024));
});

test("has persistence disabled", async () => {
  expect(await config("save")).toBe("");
  expect(await config("appendonly")).toBe("no");
});
