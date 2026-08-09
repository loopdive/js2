import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { loadPinnedPackagePin, setupPinnedPackage } from "./setup-pinned-package.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

export function loadPin() {
  return loadPinnedPackagePin(HERE, "react-pin.json");
}

export function setupReact(options = {}) {
  return setupPinnedPackage({
    here: HERE,
    name: "react",
    pinFile: "react-pin.json",
    extractionDirectory: ".react",
    force: options.force,
  });
}
