import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { setupPinnedUpstreamSuite } from "./setup-pinned-upstream-suite.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

export function setupMarkedUpstreamSuite(options = {}) {
  return setupPinnedUpstreamSuite({
    here: HERE,
    pinFile: "marked-upstream-suite-pin.json",
    cacheDirectory: ".npm-upstream-suites/marked",
    inventoryDirectory: "test/unit",
    accept: (path) => /^test\/unit\/[^/]+\.test\.js$/.test(path),
    force: options.force,
  });
}
