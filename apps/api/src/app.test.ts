import { describe, expect, test } from "bun:test";
import type { User } from "@chargelatch/db";
import { fakeDeps } from "../test/fakes.ts";
import { createApp } from "./app.ts";

describe("api", () => {
  test("GET /api/health", async () => {
    const res = await createApp(fakeDeps()).request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  test("POST /api/users creates a user that is then listed", async () => {
    const app = createApp(fakeDeps());

    const created = await app.request("/api/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "linus@example.com", name: "Linus" }),
    });
    expect(created.status).toBe(201);

    const list = (await (await app.request("/api/users")).json()) as User[];
    expect(list.map((u) => u.email)).toEqual(["linus@example.com"]);
  });

  test("POST /api/users rejects an incomplete body", async () => {
    const res = await createApp(fakeDeps()).request("/api/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "nobody@example.com" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues: { path: string }[] };
    expect(body.issues.map((i) => i.path)).toEqual(["name"]);
  });

  test("POST /api/users rejects an invalid email", async () => {
    const res = await createApp(fakeDeps()).request("/api/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "not-an-email", name: "Nobody" }),
    });
    expect(res.status).toBe(400);
  });

  test("GET /api/openapi.json documents every route", async () => {
    const res = await createApp(fakeDeps()).request("/api/openapi.json");
    expect(res.status).toBe(200);
    const spec = (await res.json()) as {
      openapi: string;
      paths: Record<string, Record<string, unknown>>;
      components: { schemas: Record<string, unknown> };
    };
    expect(spec.openapi).toBe("3.1.0");
    expect(Object.keys(spec.paths)).toEqual(expect.arrayContaining(["/api/health", "/api/users", "/api/factory/devices"]));
    expect(Object.keys(spec.paths["/api/users"]!).sort()).toEqual(["get", "post"]);
    expect(Object.keys(spec.components.schemas)).toEqual(expect.arrayContaining(["User", "NewUser", "Error"]));
  });

  test("GET /api/docs serves swagger ui pointed at the spec", async () => {
    const res = await createApp(fakeDeps()).request("/api/docs");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("/api/openapi.json");
  });
});
