import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { setupPinnedUpstreamSuite } from "./setup-pinned-upstream-suite.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

export function setupWebpackUpstreamSuite(options = {}) {
  return setupPinnedUpstreamSuite({
    here: HERE,
    pinFile: "webpack-upstream-suite-pin.json",
    cacheDirectory: ".npm-upstream-suites/webpack",
    inventoryDirectory: "test",
    accept: (path) => /^test\/[^/]+\.unittest\.js$/.test(path),
    force: options.force,
  });
}
