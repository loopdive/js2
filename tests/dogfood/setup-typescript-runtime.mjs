import { mkdirSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { setupPinnedPackage } from "./setup-pinned-package.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Independent Node-compatible oracle, compiled into Wasm rather than imported from the host. */
export function setupTypescriptRuntime() {
  const pins = JSON.parse(readFileSync(join(HERE, "typescript-runtime-pin.json"), "utf8"));
  const packages = Object.fromEntries(
    Object.entries(pins).map(([name, pin]) => [
      name,
      setupPinnedPackage({
        here: HERE,
        name,
        pin,
        extractionDirectory: `.npm-compat/typescript-runtime/${name}`,
        wireDependencies: false,
      }),
    ]),
  );
  const dependencyDirectory = join(dirname(packages.buffer.entryModulePath), "node_modules");
  mkdirSync(dependencyDirectory, { recursive: true });
  for (const name of ["base64-js", "ieee754"]) {
    const target = dirname(packages[name].entryModulePath);
    const link = join(dependencyDirectory, name);
    try {
      symlinkSync(relative(dependencyDirectory, target), link, "dir");
    } catch (error) {
      if (error.code !== "EEXIST" || realpathSync(link) !== realpathSync(target)) throw error;
    }
  }
  return { entry: packages.buffer.entryModulePath, pins };
}
