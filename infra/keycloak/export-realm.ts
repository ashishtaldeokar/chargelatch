// Snapshots a realm from the running dev stack back into infra/keycloak/realms/.
// Usage: bun infra/keycloak/export-realm.ts [realm]
import { $ } from "bun";
import { join } from "node:path";

const realm = process.argv[2] ?? "chargelatch";
const root = join(import.meta.dir, "../..");
const realmsDir = join(import.meta.dir, "realms");
const realmFile = join(realmsDir, `${realm}-realm.json`);

// A one-off container against the shared Postgres, so the dev server keeps running.
await $`docker compose run --rm -v ${realmsDir}:/export keycloak export --dir /export --realm ${realm} --users realm_file`.cwd(
  root,
);

// The export contains the realm's signing/encryption private keys. Never commit those:
// without key providers in the file, Keycloak generates fresh keys on import, so dev,
// e2e and production each get their own.
const exported = await Bun.file(realmFile).json();
delete exported.components?.["org.keycloak.keys.KeyProvider"];
await Bun.write(realmFile, JSON.stringify(exported, null, 2) + "\n");

console.log(`
Exported realm "${realm}" to infra/keycloak/realms/${realm}-realm.json (key material stripped)

Next:
  1. Review the diff:          git diff infra/keycloak/realms
  2. Commit it.
  3. Refresh the dev image:    docker compose build keycloak
`);
