import { join } from "node:path";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";

// The same build context docker-compose.yml uses, so dev and e2e cannot drift.
export const EMQX_BUILD_CONTEXT = join(import.meta.dir, "../../../../infra/emqx");

export const EMQX_DASHBOARD = { username: "admin", password: "chargelatch-dev" };

export interface StartedEmqx {
  container: StartedTestContainer;
  /** mqtt://host:port for MQTT over TCP, what devices use. */
  mqttUrl: string;
  /** ws://host:port/mqtt for MQTT over WebSocket. */
  wsUrl: string;
  /** Base URL of the dashboard and its REST API (/api/v5). */
  dashboardUrl: string;
  stop(): Promise<void>;
}

export async function startEmqx(): Promise<StartedEmqx> {
  // deleteOnExit: false keeps the image so Docker's layer cache makes later runs fast.
  const image = await GenericContainer.fromDockerfile(EMQX_BUILD_CONTEXT).build("chargelatch/emqx:e2e", {
    deleteOnExit: false,
  });
  const container = await image
    .withExposedPorts(1883, 8083, 18083)
    .withWaitStrategy(Wait.forHealthCheck())
    .withStartupTimeout(120_000)
    .start();

  const host = container.getHost();
  return {
    container,
    mqttUrl: `mqtt://${host}:${container.getMappedPort(1883)}`,
    wsUrl: `ws://${host}:${container.getMappedPort(8083)}/mqtt`,
    dashboardUrl: `http://${host}:${container.getMappedPort(18083)}`,
    stop: async () => {
      await container.stop();
    },
  };
}

/** Bearer token for the EMQX REST API, for asserting broker state in tests. */
export async function emqxApiToken(dashboardUrl: string): Promise<string> {
  const res = await fetch(`${dashboardUrl}/api/v5/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(EMQX_DASHBOARD),
  });
  if (!res.ok) throw new Error(`EMQX dashboard login failed: ${res.status}`);
  return ((await res.json()) as { token: string }).token;
}
