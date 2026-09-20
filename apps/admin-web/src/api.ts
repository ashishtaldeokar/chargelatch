import { readEventStream } from "./sse.ts";

export interface MeterReading {
  model: string;
  phases: number;
  ok: boolean;
  error?: string;
  values: Record<string, number>;
  receivedAt: string;
}

export interface LiveDevice {
  identity: string;
  macAddress: string;
  chipType: string;
  firmwareVersion: string | null;
  /** null: not heard from since the API connected to the broker. */
  online: boolean | null;
  firmware: string | null;
  relay: { on: boolean; updatedAt: string } | null;
  meter: MeterReading | null;
}

export interface Api {
  listDevices(): Promise<LiveDevice[]>;
  setRelay(identity: string, on: boolean): Promise<{ on: boolean; updatedAt: string }>;
  /**
   * Live updates. Reconnects by itself; `onConnection(false)` means the list may be stale, and
   * `onConnection(true)` is the cue to refetch it. Returns a function that stops everything.
   */
  watchDevices(onDevice: (device: LiveDevice) => void, onConnection: (connected: boolean) => void): () => void;
}

export function createApi(getToken: () => string | undefined, fetcher: typeof fetch = fetch): Api {
  const authorized = (init: RequestInit = {}): RequestInit => {
    const token = getToken();
    if (!token) throw new Error("Not signed in");
    return { ...init, headers: { ...init.headers, authorization: `Bearer ${token}`, ...(init.body ? { "content-type": "application/json" } : {}) } };
  };

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetcher(path, authorized(init));
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? `${init?.method ?? "GET"} ${path} failed: ${res.status}`);
    }
    return res.json() as Promise<T>;
  }

  return {
    listDevices: () => request<LiveDevice[]>("/api/admin/devices"),
    setRelay: (identity, on) => request(`/api/admin/devices/${identity}/relay`, { method: "PUT", body: JSON.stringify({ on }) }),
    watchDevices: (onDevice, onConnection) => {
      const controller = new AbortController();
      void (async () => {
        while (!controller.signal.aborted) {
          try {
            // authorized() is evaluated per attempt, so a silently renewed token is picked up.
            const res = await fetcher("/api/admin/devices/events", { ...authorized(), signal: controller.signal });
            onConnection(true);
            await readEventStream(res, (event) => event.event === "device" && onDevice(JSON.parse(event.data) as LiveDevice), controller.signal);
          } catch {
            // fall through to the retry below
          }
          if (controller.signal.aborted) return;
          onConnection(false);
          await new Promise((resolve) => setTimeout(resolve, 3000));
        }
      })();
      return () => controller.abort();
    },
  };
}
