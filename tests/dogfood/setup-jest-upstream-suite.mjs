import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { setupPinnedUpstreamSuite } from "./setup-pinned-upstream-suite.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

const DETECT_NEWLINE_PIN = {
  version: "3.1.0",
  sourceSha256: "7306f2ecc168c9e20be4a2a3d44a0dad59ea21dc0bf4cd41ea85829bc79e2c18",
};

function resolveDetectNewlineSource(pin = DETECT_NEWLINE_PIN) {
  const workspaceNodeModules = resolve(HERE, "../../node_modules");
  const direct = join(workspaceNodeModules, "detect-newline/index.js");
  const candidates = [direct];
  const pnpmRoot = join(workspaceNodeModules, ".pnpm");
  try {
    for (const entry of readdirSync(pnpmRoot)) {
      if (entry.startsWith(`detect-newline@${pin.version}`)) {
        candidates.push(join(pnpmRoot, entry, "node_modules/detect-newline/index.js"));
      }
    }
  } catch {
    // The normal pnpm install has the hidden store; a direct hoisted install
    // is also supported by the first candidate.
  }
  const sourcePath = candidates.find((candidate) => existsSync(candidate));
  if (!sourcePath) {
    throw new Error(
      `[dogfood] Jest requires detect-newline@${pin.version}; ` + "run pnpm install before running the upstream suite",
    );
  }
  const source = readFileSync(sourcePath, "utf8");
  const packagePath = join(dirname(sourcePath), "package.json");
  const packageVersion = JSON.parse(readFileSync(packagePath, "utf8")).version;
  if (packageVersion !== pin.version) {
    throw new Error(`[dogfood] detect-newline version mismatch: expected ${pin.version}, got ${packageVersion}`);
  }
  const sha256 = createHash("sha256").update(source).digest("hex");
  if (sha256 !== pin.sourceSha256) {
    throw new Error(`[dogfood] detect-newline source hash mismatch: expected ${pin.sourceSha256}, got ${sha256}`);
  }
  return { source, sha256 };
}

export function adaptDetectNewline(source) {
  const adapted = source
    .replace(/^\s*["']use strict["'];?\s*/m, "")
    .replace(/module\.exports\s*=\s*detectNewline\s*;/, "export default detectNewline;")
    .replace(/module\.exports\.graceful\s*=\s*/, "export const graceful = ");
  if (!adapted.includes("export default detectNewline;") || !adapted.includes("export const graceful")) {
    throw new Error("[dogfood] detect-newline source shape changed; refusing an unverified adapter");
  }
  return adapted;
}

export function setupJestUpstreamSuite(options = {}) {
  const suite = setupPinnedUpstreamSuite({
    here: HERE,
    pinFile: "jest-upstream-suite-pin.json",
    cacheDirectory: ".npm-upstream-suites/jest",
    inventoryDirectory: "packages",
    accept: (path) => /^packages\/.*\/__tests__\/.*\.(?:test|spec)\.(?:js|jsx|ts|tsx)$/.test(path),
    force: options.force,
  });
  // jest-docblock's published source depends on the tiny CommonJS
  // `detect-newline` package. The compiler deliberately does not guess a
  // CommonJS default export, so materialize the pinned installed source as an
  // explicit ESM adapter inside the verified checkout. This keeps the
  // upstream test and implementation unchanged while making the real
  // dependency available to both Node's oracle and the Wasm project resolver.
  const dependencyPin = suite.pin.dependencies?.["detect-newline"] ?? DETECT_NEWLINE_PIN;
  const dependency = resolveDetectNewlineSource(dependencyPin);
  const dependencyRoot = join(suite.root, "node_modules", "detect-newline");
  mkdirSync(dependencyRoot, { recursive: true });
  writeFileSync(
    join(dependencyRoot, "package.json"),
    JSON.stringify(
      {
        name: "detect-newline",
        version: dependencyPin.version,
        type: "module",
        main: "./index.ts",
        exports: "./index.ts",
        _sourceSha256: dependency.sha256,
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(join(dependencyRoot, "index.ts"), adaptDetectNewline(dependency.source));
  return suite;
}
