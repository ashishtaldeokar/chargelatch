import { expect, test } from "bun:test";
import { createSseParser, readEventStream } from "./sse.ts";

test("parses events, ignoring keep-alive comments", () => {
  const parse = createSseParser();
  expect(parse(': keep-alive\n\nevent: device\ndata: {"a":1}\n\n')).toEqual([{ event: "device", data: '{"a":1}' }]);
});

test("reassembles an event split across network chunks", () => {
  const parse = createSseParser();
  expect(parse("event: dev")).toEqual([]);
  expect(parse('ice\ndata: {"identity":"SON')).toEqual([]);
  expect(parse('IK-1"}\n\nevent: device\ndata: 2\n\n')).toEqual([
    { event: "device", data: '{"identity":"SONIK-1"}' },
    { event: "device", data: "2" },
  ]);
});

test("handles CRLF, multi-line data and the default event name", () => {
  const parse = createSseParser();
  expect(parse("data: one\r\ndata: two\r\n\r\n")).toEqual([{ event: "message", data: "one\ntwo" }]);
});

test("reads a response stream until it ends, and rejects a failed response", async () => {
  const events: string[] = [];
  const body = new Response("event: device\ndata: 1\n\nevent: device\ndata: 2\n\n");
  await readEventStream(body, (event) => events.push(event.data), new AbortController().signal);
  expect(events).toEqual(["1", "2"]);

  expect(readEventStream(new Response("nope", { status: 403 }), () => {}, new AbortController().signal)).rejects.toThrow(/403/);
});
