// Copies the firmware build into public/firmware/ with a manifest the factory app flashes from.
// Usage: pnpm firmware:build && pnpm firmware:bundle
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { FirmwareManifest } from "../src/lib/firmware.ts";

const buildDir = join(import.meta.dir, "../../firmware/build");
const outDir = join(import.meta.dir, "../public/firmware");

const flasherArgs = Bun.file(join(buildDir, "flasher_args.json"));
if (!(await flasherArgs.exists())) {
  console.error(`No firmware build at ${buildDir}. Run \`pnpm firmware:build\` first.`);
  process.exit(1);
}

const args = (await flasherArgs.json()) as {
  flash_settings: { flash_mode: string; flash_size: string; flash_freq: string };
  flash_files: Record<string, string>;
  "partition-table": { offset: string };
  extra_esptool_args: { chip: string };
};
const project = (await Bun.file(join(buildDir, "project_description.json")).json()) as {
  project_name: string;
  project_version: string;
};

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const files: FirmwareManifest["files"] = [];
for (const [offset, path] of Object.entries(args.flash_files).sort(([a], [b]) => Number(a) - Number(b))) {
  const name = path.split("/").at(-1)!;
  const bytes = await Bun.file(join(buildDir, path)).bytes();
  await Bun.write(join(outDir, name), bytes);
  files.push({ name, offset: Number(offset), size: bytes.length, sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex") });
}

const manifest: FirmwareManifest = {
  name: project.project_name,
  version: project.project_version,
  chip: args.extra_esptool_args.chip,
  builtAt: new Date().toISOString(),
  flash: { mode: args.flash_settings.flash_mode, freq: args.flash_settings.flash_freq, size: args.flash_settings.flash_size },
  partitionTableOffset: Number(args["partition-table"].offset),
  files,
};
await Bun.write(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

console.log(`bundled ${manifest.name} ${manifest.version} (${manifest.chip}) into apps/factory/public/firmware/`);
for (const file of files) console.log(`  0x${file.offset.toString(16).padStart(6, "0")}  ${file.name}  ${file.size} bytes`);
