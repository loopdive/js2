import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { setupPinnedUpstreamSuite } from "./setup-pinned-upstream-suite.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

export function setupJsdomUpstreamSuite(options = {}) {
  return setupPinnedUpstreamSuite({
    here: HERE,
    pinFile: "jsdom-upstream-suite-pin.json",
    cacheDirectory: ".npm-upstream-suites/jsdom",
    inventoryDirectory: "test/api",
    accept: (path) => /^test\/api\/[^/]+\.js$/.test(path),
    force: options.force,
  });
}
