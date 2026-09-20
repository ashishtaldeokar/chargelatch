import { join } from "node:path";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";

// The same build context docker-compose.yml uses, so dev and e2e cannot drift.
export const REDIS_BUILD_CONTEXT = join(import.meta.dir, "../../../../infra/redis");

export interface StartedRedis {
  container: StartedTestContainer;
  url: string;
  stop(): Promise<void>;
}

export async function startRedis(): Promise<StartedRedis> {
  // deleteOnExit: false keeps the image so Docker's layer cache makes later runs fast.
  const image = await GenericContainer.fromDockerfile(REDIS_BUILD_CONTEXT).build("chargelatch/redis:e2e", {
    deleteOnExit: false,
  });
  const container = await image
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forHealthCheck())
    .withStartupTimeout(60_000)
    .start();

  return {
    container,
    url: `redis://${container.getHost()}:${container.getMappedPort(6379)}`,
    stop: async () => {
      await container.stop();
    },
  };
}
