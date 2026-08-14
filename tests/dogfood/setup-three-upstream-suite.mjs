import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { setupPinnedUpstreamSuite } from "./setup-pinned-upstream-suite.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

export function setupThreeUpstreamSuite(options = {}) {
  return setupPinnedUpstreamSuite({
    here: HERE,
    pinFile: "three-upstream-suite-pin.json",
    cacheDirectory: ".npm-upstream-suites/three",
    inventoryDirectory: "test/unit/src",
    accept: (path) => /^test\/unit\/src\/.*\.tests\.js$/.test(path),
    force: options.force,
  });
}
