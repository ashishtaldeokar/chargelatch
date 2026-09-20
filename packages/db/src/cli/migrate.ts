import { requireDatabaseUrl } from "../client.ts";
import { runMigrations } from "../migrate.ts";

await runMigrations(requireDatabaseUrl());
console.log("migrations applied");
