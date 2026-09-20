// Server-sent events over fetch(). The browser's EventSource cannot send an Authorization
// header, and putting a bearer token in the URL would leak it into logs and history.

export interface SseEvent {
  event: string;
  data: string;
}

/** Incremental parser: feed it decoded chunks, get back the events completed so far. */
export function createSseParser() {
  let buffer = "";
  return (chunk: string): SseEvent[] => {
    buffer += chunk.replaceAll("\r\n", "\n");
    const events: SseEvent[] = [];
    let end: number;
    while ((end = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);

      let event = "message";
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith(":")) continue; // comment, used by the server as keep-alive
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "event") event = value;
        else if (field === "data") data.push(value);
      }
      if (data.length > 0) events.push({ event, data: data.join("\n") });
    }
    return events;
  };
}

/** Reads an event stream until it ends or `signal` aborts. Rejects if the stream breaks. */
export async function readEventStream(response: Response, onEvent: (event: SseEvent) => void, signal: AbortSignal): Promise<void> {
  if (!response.ok || !response.body) throw new Error(`event stream failed: ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parse = createSseParser();
  signal.addEventListener("abort", () => void reader.cancel().catch(() => {}), { once: true });

  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    for (const event of parse(decoder.decode(value, { stream: true }))) onEvent(event);
  }
}
