import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const packagesDirectory = new URL("../packages/", import.meta.url);
const packageEntries = await readdir(packagesDirectory, { withFileTypes: true });
let failed = false;

for (const entry of packageEntries) {
  if (!entry.isDirectory()) continue;

  const packageDirectory = join(packagesDirectory.pathname, entry.name);
  const manifest = JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8"));
  if (manifest.private) continue;

  console.log(`Packing ${manifest.name}`);
  const result = Bun.spawnSync({
    cmd: ["npm", "pack", "--dry-run"],
    cwd: packageDirectory,
    stdout: "inherit",
    stderr: "inherit",
  });
  failed ||= result.exitCode !== 0;
}

if (failed) process.exit(1);
