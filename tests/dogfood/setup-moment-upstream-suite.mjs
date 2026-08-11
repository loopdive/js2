import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { setupPinnedUpstreamSuite } from "./setup-pinned-upstream-suite.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

export function setupMomentUpstreamSuite(options = {}) {
  return setupPinnedUpstreamSuite({
    here: HERE,
    pinFile: "moment-upstream-suite-pin.json",
    cacheDirectory: ".moment-upstream-suite",
    inventoryDirectory: "src/test",
    accept: (path) =>
      path.endsWith(".js") &&
      !path.includes("/helpers/") &&
      path !== "src/test/qunit.js" &&
      path !== "src/test/qunit-locale.js",
    ...options,
  });
}
