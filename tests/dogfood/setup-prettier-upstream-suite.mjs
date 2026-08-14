import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { setupPinnedUpstreamSuite } from "./setup-pinned-upstream-suite.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

export function setupPrettierUpstreamSuite(options = {}) {
  return setupPinnedUpstreamSuite({
    here: HERE,
    pinFile: "prettier-upstream-suite-pin.json",
    cacheDirectory: ".npm-upstream-suites/prettier",
    inventoryDirectory: "tests/unit",
    accept: (path) => /^tests\/unit\/[^/]+\.js$/.test(path),
    force: options.force,
  });
}
