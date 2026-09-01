import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { setupPinnedUpstreamSuite } from "./setup-pinned-upstream-suite.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

function fileSha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Run the same checked-in generator as TypeScript's `generate-diagnostics`
 * Hereby task and then verify its deterministic release-tag outputs. The
 * digest floor prevents a missing, partial, or locally stale generated source
 * file from silently changing the parser graph.
 */
export function generatePinnedTypescriptDiagnostics(root, pin, options = {}) {
  const specification = pin.generatedDiagnostics;
  if (!specification?.script || !specification?.input || !Array.isArray(specification.artifacts)) {
    throw new Error("[dogfood] typescript pin is missing its generated-diagnostics specification");
  }
  if (specification.artifacts.length === 0) {
    throw new Error("[dogfood] typescript generated-diagnostics artifact floor is empty");
  }

  const run = options.execFileSync ?? execFileSync;
  run(process.execPath, [specification.script, specification.input], {
    cwd: root,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  const artifacts = specification.artifacts.map((artifact) => {
    const path = join(root, artifact.path);
    const actualSha256 = existsSync(path) ? fileSha256(path) : null;
    if (actualSha256 !== artifact.sha256) {
      throw new Error(
        `[dogfood] typescript generated diagnostic artifact mismatch.\n` +
          `  path     ${artifact.path}\n` +
          `  expected ${artifact.sha256}\n` +
          `  got      ${actualSha256 ?? "missing"}`,
      );
    }
    return { path: artifact.path, sha256: actualSha256 };
  });

  return {
    command: [process.execPath, specification.script, specification.input],
    artifacts,
  };
}

export function setupTypescriptUpstreamSuite(options = {}) {
  const suite = setupPinnedUpstreamSuite({
    here: HERE,
    pinFile: "typescript-upstream-suite-pin.json",
    cacheDirectory: ".npm-upstream-suites/typescript",
    inventoryDirectory: "src/testRunner/unittests",
    accept: (path) => /^src\/testRunner\/unittests\/.*\.ts$/.test(path),
    force: options.force,
  });
  return {
    ...suite,
    generatedDiagnostics: generatePinnedTypescriptDiagnostics(suite.root, suite.pin, options),
  };
}
