import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { setupPinnedUpstreamSuite } from "./setup-pinned-upstream-suite.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

export function setupCookieUpstreamSuite(options = {}) {
  return setupPinnedUpstreamSuite({
    here: HERE,
    pinFile: "cookie-upstream-suite-pin.json",
    cacheDirectory: ".npm-upstream-suites/cookie",
    inventoryDirectory: "src",
    accept: (path) => /^src\/[^/]+\.spec\.ts$/.test(path),
    force: options.force,
  });
}
