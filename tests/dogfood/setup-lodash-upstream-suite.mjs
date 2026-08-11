import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { setupPinnedUpstreamSuite } from "./setup-pinned-upstream-suite.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

export function setupLodashUpstreamSuite(options = {}) {
  const setup = setupPinnedUpstreamSuite({
    here: HERE,
    pinFile: "lodash-upstream-suite-pin.json",
    cacheDirectory: ".lodash-upstream-suite",
    inventoryDirectory: "test",
    accept: (path) => path === "test/test.js",
    ...options,
  });
  const sourcePath = join(setup.root, "test/test.js");
  const sourceSha256 = createHash("sha256").update(readFileSync(sourcePath)).digest("hex");
  if (sourceSha256 !== setup.pin.testSourceSha256) {
    throw new Error(
      `[dogfood] lodash upstream test source mismatch: expected ${setup.pin.testSourceSha256}, got ${sourceSha256}`,
    );
  }
  return { ...setup, sourcePath };
}
