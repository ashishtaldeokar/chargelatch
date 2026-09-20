export interface Device {
  id: number;
  identity: string;
  macAddress: string;
  chipType: string;
  chipRevision: string | null;
  chipFeatures: string[];
  crystalMhz: number | null;
  flashSizeBytes: number | null;
  firmwareVersion: string | null;
  flashCount: number;
  lastFlashedAt: string | null;
  createdAt: string;
}

export type RegisteredDevice = Device & { created: boolean };

export interface DeviceRegistration {
  macAddress: string;
  chipType: string;
  chipRevision?: string;
  chipFeatures?: string[];
  crystalMhz?: number;
  flashSizeBytes?: number;
}

export interface FactoryApi {
  registerDevice(registration: DeviceRegistration): Promise<RegisteredDevice>;
  listDevices(): Promise<Device[]>;
  getFactoryPartition(deviceId: number, size: number): Promise<Uint8Array>;
  markFlashed(deviceId: number, firmwareVersion: string): Promise<Device>;
}

export function createFactoryApi(getToken: () => string | undefined, fetcher: typeof fetch = fetch): FactoryApi {
  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    const token = getToken();
    if (!token) throw new Error("Not signed in");
    const res = await fetcher(path, {
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${token}`, ...(init.body ? { "content-type": "application/json" } : {}) },
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? `${init.method ?? "GET"} ${path} failed: ${res.status}`);
    }
    return res;
  }

  return {
    registerDevice: async (registration) =>
      (await request("/api/factory/devices", { method: "POST", body: JSON.stringify(registration) })).json() as Promise<RegisteredDevice>,
    listDevices: async () => (await request("/api/factory/devices")).json() as Promise<Device[]>,
    getFactoryPartition: async (deviceId, size) =>
      new Uint8Array(await (await request(`/api/factory/devices/${deviceId}/partition?size=${size}`)).arrayBuffer()),
    markFlashed: async (deviceId, firmwareVersion) =>
      (await request(`/api/factory/devices/${deviceId}/flashed`, { method: "POST", body: JSON.stringify({ firmwareVersion }) })).json() as Promise<Device>,
  };
}
