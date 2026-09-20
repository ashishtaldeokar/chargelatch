import { requireDatabaseUrl } from "../client.ts";
import { seed, seeds, type SeedName } from "../seed.ts";

const name = (process.argv[2] ?? "dev") as SeedName;
if (!(name in seeds)) {
  console.error(`unknown seed "${name}". available: ${Object.keys(seeds).join(", ")}`);
  process.exit(1);
}

await seed(requireDatabaseUrl(), name);
console.log(`seeded "${name}"`);
