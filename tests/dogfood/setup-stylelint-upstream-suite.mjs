import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { setupPinnedUpstreamSuite } from "./setup-pinned-upstream-suite.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

export function setupStylelintUpstreamSuite(options = {}) {
  return setupPinnedUpstreamSuite({
    here: HERE,
    pinFile: "stylelint-upstream-suite-pin.json",
    cacheDirectory: ".npm-upstream-suites/stylelint",
    inventoryDirectory: "lib",
    accept: (path) => /^lib\/.*\/__tests__\/.*\.(?:js|mjs|cjs)$/.test(path),
    force: options.force,
  });
}
