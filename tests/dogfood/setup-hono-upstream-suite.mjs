import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { setupPinnedUpstreamSuite } from "./setup-pinned-upstream-suite.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

export function setupHonoUpstreamSuite(options = {}) {
  return setupPinnedUpstreamSuite({
    here: HERE,
    pinFile: "hono-upstream-suite-pin.json",
    cacheDirectory: ".hono-upstream-suite",
    inventoryDirectory: "src",
    accept: (path) => /\.test\.(?:ts|tsx)$/.test(path),
    ...options,
  });
}
