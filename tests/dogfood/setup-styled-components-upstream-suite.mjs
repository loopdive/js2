import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { setupPinnedUpstreamSuite } from "./setup-pinned-upstream-suite.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

export function setupStyledComponentsUpstreamSuite(options = {}) {
  return setupPinnedUpstreamSuite({
    here: HERE,
    pinFile: "styled-components-upstream-suite-pin.json",
    cacheDirectory: ".npm-upstream-suites/styled-components",
    inventoryDirectory: "packages/styled-components/src",
    accept: (path) => /^packages\/styled-components\/src\/.*\/test\/.*\.test\.(?:js|jsx|ts|tsx)$/.test(path),
    force: options.force,
  });
}
