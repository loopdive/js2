import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { setupPinnedUpstreamSuite } from "./setup-pinned-upstream-suite.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

export function setupReduxUpstreamSuite(options = {}) {
  return setupPinnedUpstreamSuite({
    here: HERE,
    pinFile: "redux-upstream-suite-pin.json",
    cacheDirectory: ".npm-upstream-suites/redux",
    inventoryDirectory: "test",
    accept: (path) => /^test\/(?:[^/]+|utils\/[^/]+)\.spec\.ts$/.test(path),
    force: options.force,
  });
}
