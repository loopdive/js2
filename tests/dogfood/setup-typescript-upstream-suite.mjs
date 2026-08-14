import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { setupPinnedUpstreamSuite } from "./setup-pinned-upstream-suite.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

export function setupTypescriptUpstreamSuite(options = {}) {
  return setupPinnedUpstreamSuite({
    here: HERE,
    pinFile: "typescript-upstream-suite-pin.json",
    cacheDirectory: ".npm-upstream-suites/typescript",
    inventoryDirectory: "src/testRunner/unittests",
    accept: (path) => /^src\/testRunner\/unittests\/.*\.ts$/.test(path),
    force: options.force,
  });
}
