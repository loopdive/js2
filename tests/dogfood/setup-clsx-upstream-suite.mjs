import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { setupPinnedUpstreamSuite } from "./setup-pinned-upstream-suite.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

export function setupClsxUpstreamSuite(options = {}) {
  return setupPinnedUpstreamSuite({
    here: HERE,
    pinFile: "clsx-upstream-suite-pin.json",
    cacheDirectory: ".npm-upstream-suites/clsx",
    inventoryDirectory: "test",
    accept: (path) => /^test\/[^/]+\.js$/.test(path),
    force: options.force,
  });
}
