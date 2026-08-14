import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { setupPinnedUpstreamSuite } from "./setup-pinned-upstream-suite.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

export function setupAxiosUpstreamSuite(options = {}) {
  return setupPinnedUpstreamSuite({
    here: HERE,
    pinFile: "axios-upstream-suite-pin.json",
    cacheDirectory: ".npm-upstream-suites/axios",
    inventoryDirectory: "tests/unit",
    accept: (path) => /^tests\/unit\/.*\.test\.js$/.test(path),
    force: options.force,
  });
}
