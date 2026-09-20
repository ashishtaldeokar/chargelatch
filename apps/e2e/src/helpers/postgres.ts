import { join } from "node:path";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";

// The same build context docker-compose.yml uses, so dev and e2e cannot drift.
export const POSTGRES_BUILD_CONTEXT = join(import.meta.dir, "../../../../infra/postgres");

export interface StartedPostgres {
  container: StartedTestContainer;
  /** Connection URL. Defaults to the `chargelatch` database created by the baked init scripts. */
  url(database?: string): string;
  stop(): Promise<void>;
}

export async function startPostgres(): Promise<StartedPostgres> {
  // deleteOnExit: false keeps the image so Docker's layer cache makes later runs fast.
  const image = await GenericContainer.fromDockerfile(POSTGRES_BUILD_CONTEXT).build("chargelatch/postgres:e2e", {
    deleteOnExit: false,
  });
  const container = await image
    .withExposedPorts(5432)
    .withEnvironment({ POSTGRES_USER: "postgres", POSTGRES_PASSWORD: "postgres", POSTGRES_DB: "postgres" })
    // Default and exec-based wait strategies hang under Bun; the image's HEALTHCHECK works.
    .withWaitStrategy(Wait.forHealthCheck())
    .withStartupTimeout(120_000)
    .start();

  return {
    container,
    url: (database = "chargelatch") =>
      `postgres://postgres:postgres@${container.getHost()}:${container.getMappedPort(5432)}/${database}`,
    stop: async () => {
      await container.stop();
    },
  };
}
