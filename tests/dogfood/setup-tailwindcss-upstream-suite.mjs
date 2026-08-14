import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { setupPinnedUpstreamSuite } from "./setup-pinned-upstream-suite.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

export function setupTailwindcssUpstreamSuite(options = {}) {
  return setupPinnedUpstreamSuite({
    here: HERE,
    pinFile: "tailwindcss-upstream-suite-pin.json",
    cacheDirectory: ".npm-upstream-suites/tailwindcss",
    inventoryDirectory: "packages/tailwindcss",
    accept: (path) => /^packages\/tailwindcss\/.*\.(?:test|spec)\.(?:js|ts|tsx)$/.test(path),
    force: options.force,
  });
}
