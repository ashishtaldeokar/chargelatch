import type { LiveDeviceState, RelayState } from "@chargelatch/device-protocol";

export type { MeterReading } from "@chargelatch/device-protocol";

/** A registered device plus its live state. */
export interface LiveDevice extends LiveDeviceState {
  macAddress: string;
  chipType: string;
  firmwareVersion: string | null;
}

export interface Api {
  /** The device registry with the API's view of each device. Live changes come from live.ts. */
  listDevices(): Promise<LiveDevice[]>;
  /** Resolves once the DEVICE has confirmed; rejects with the reason (offline, no confirmation). */
  setRelay(identity: string, on: boolean): Promise<RelayState>;
}

export function createApi(getToken: () => string | undefined, fetcher: typeof fetch = fetch): Api {
  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = getToken();
    if (!token) throw new Error("Not signed in");
    const res = await fetcher(path, {
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${token}`, ...(init.body ? { "content-type": "application/json" } : {}) },
    });
    // A reverse proxy without a /api route answers with the SPA's index.html: say so instead of
    // failing with "Unexpected token <" from JSON.parse.
    if (!res.headers.get("content-type")?.includes("json")) {
      throw new Error(`${path} did not return JSON (${res.status} ${res.headers.get("content-type") ?? "no content-type"}). Is /api proxied to the API server?`);
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? `${init.method ?? "GET"} ${path} failed: ${res.status}`);
    }
    return res.json() as Promise<T>;
  }

  return {
    listDevices: () => request<LiveDevice[]>("/api/admin/devices"),
    setRelay: (identity, on) => request<RelayState>(`/api/admin/devices/${identity}/relay`, { method: "PUT", body: JSON.stringify({ on }) }),
  };
}
