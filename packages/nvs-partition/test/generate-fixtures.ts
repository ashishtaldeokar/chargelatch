// Regenerates test/fixtures/*.bin with ESP-IDF's own nvs_partition_gen.py, the reference the
// TypeScript generator must match byte-for-byte. Needs the IDF env: source ~/esp/esp-idf/export.sh
import { $ } from "bun";
import { join } from "node:path";
import { cases } from "./cases.ts";

const idf = process.env.IDF_PATH;
if (!idf) throw new Error("IDF_PATH is not set. Run: source ~/esp/esp-idf/export.sh");
const generator = join(idf, "components/nvs_flash/nvs_partition_generator/nvs_partition_gen.py");
const fixtures = join(import.meta.dir, "fixtures");

for (const [name, { data, size }] of Object.entries(cases)) {
  const rows = ["key,type,encoding,value"];
  for (const [namespace, values] of Object.entries(data)) {
    rows.push(`${namespace},namespace,,`);
    for (const [key, raw] of Object.entries(values)) {
      const entry = typeof raw === "string" ? { type: "string", value: raw } : raw;
      rows.push(`${key},data,${entry.type},"${String(entry.value).replaceAll('"', '""')}"`);
    }
  }
  const csv = join(fixtures, `${name}.csv`);
  await Bun.write(csv, rows.join("\n") + "\n");
  await $`python ${generator} generate ${csv} ${join(fixtures, `${name}.bin`)} ${size}`.quiet();
  console.log(`generated ${name}.bin`);
}
