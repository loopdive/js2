import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { loadPinnedPackagePin, setupPinnedPackage } from "./setup-pinned-package.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

export function loadPin() {
  return loadPinnedPackagePin(HERE, "prettier-pin.json");
}

export function setupPrettier(options = {}) {
  return setupPinnedPackage({
    here: HERE,
    name: "prettier",
    pinFile: "prettier-pin.json",
    extractionDirectory: ".prettier",
    force: options.force,
  });
}
