import { expect, test } from "bun:test";
import { createFactoryApi } from "./api.ts";

const api = (fetcher: typeof fetch) => createFactoryApi(() => "token", fetcher);

test("explains an HTML answer, which means the reverse proxy has no /api route", async () => {
  const fetcher = (async () => new Response("<!doctype html><html></html>", { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
  expect(api(fetcher).listDevices()).rejects.toThrow(/did not return JSON \(200 text\/html\).*proxied/);
});

test("downloads the identity partition, which is binary, not JSON", async () => {
  const image = new Uint8Array([0xff, 0xfe, 0x00, 0x01]);
  const fetcher = (async () => new Response(image, { status: 200, headers: { "content-type": "application/octet-stream" } })) as unknown as typeof fetch;
  expect(await api(fetcher).getFactoryPartition(1, 24576)).toEqual(image);

  // ...but an HTML page in its place is still called out.
  const html = (async () => new Response("<!doctype html>", { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
  expect(api(html).getFactoryPartition(1, 24576)).rejects.toThrow(/did not return a binary partition/);
});

test("passes the API's own error message through", async () => {
  const fetcher = (async () => Response.json({ error: "No such device" }, { status: 404 })) as unknown as typeof fetch;
  expect(api(fetcher).markFlashed(9, "0.1.0")).rejects.toThrow("No such device");
});

test("sends the bearer token", async () => {
  let seen: RequestInit | undefined;
  const fetcher = (async (_url: unknown, init?: RequestInit) => {
    seen = init;
    return Response.json([]);
  }) as typeof fetch;
  await api(fetcher).listDevices();
  expect((seen!.headers as Record<string, string>).authorization).toBe("Bearer token");
});
