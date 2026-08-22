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

const JEST_GET_TYPE_PIN = {
  version: "30.1.0",
  sourceSha256: "568e74bbefa9a86accea3c9289cfb93568cd4354bc822650a0e203b03bca341d",
};

const JEST_UTIL_PIN = {
  version: "30.4.1",
  sourceSha256: "ef7320f8e85b76a67a65ec29e9c55e724b7a25de5b2aad75c3ed1c82a53cc7d4",
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

function resolveJestGetTypeSource(suite, pin = JEST_GET_TYPE_PIN) {
  const sourcePath = join(suite.root, "packages/jest-get-type/src/index.ts");
  if (!existsSync(sourcePath)) {
    throw new Error(`[dogfood] Jest requires @jest/get-type@${pin.version}; source is missing`);
  }
  const source = readFileSync(sourcePath, "utf8");
  const packagePath = join(suite.root, "packages/jest-get-type/package.json");
  const packageVersion = JSON.parse(readFileSync(packagePath, "utf8")).version;
  if (packageVersion !== pin.version) {
    throw new Error(`[dogfood] @jest/get-type version mismatch: expected ${pin.version}, got ${packageVersion}`);
  }
  const sha256 = createHash("sha256").update(source).digest("hex");
  if (sha256 !== pin.sourceSha256) {
    throw new Error(`[dogfood] @jest/get-type source hash mismatch: expected ${pin.sourceSha256}, got ${sha256}`);
  }
  return { source, sha256 };
}

function resolveJestUtilFormatTimeSource(suite, pin = JEST_UTIL_PIN) {
  const sourcePath = join(suite.root, "packages/jest-util/src/formatTime.ts");
  if (!existsSync(sourcePath)) {
    throw new Error(`[dogfood] Jest requires jest-util@${pin.version}; source is missing`);
  }
  const source = readFileSync(sourcePath, "utf8");
  const packagePath = join(suite.root, "packages/jest-util/package.json");
  const packageVersion = JSON.parse(readFileSync(packagePath, "utf8")).version;
  if (packageVersion !== pin.version) {
    throw new Error(`[dogfood] jest-util version mismatch: expected ${pin.version}, got ${packageVersion}`);
  }
  const sha256 = createHash("sha256").update(source).digest("hex");
  if (sha256 !== pin.sourceSha256) {
    throw new Error(`[dogfood] jest-util formatTime source hash mismatch: expected ${pin.sourceSha256}, got ${sha256}`);
  }
  return { source, sha256 };
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

  // The selected jest-matcher-utils unit imports @jest/get-type by its
  // published package name. A source checkout has the workspace package but
  // no installed workspace links, so materialize a verified ESM package root
  // in the checkout's node_modules. The implementation bytes remain the
  // pinned upstream source; only the package-resolution seam is supplied.
  const getTypePin = suite.pin.dependencies?.["@jest/get-type"] ?? JEST_GET_TYPE_PIN;
  const getType = resolveJestGetTypeSource(suite, getTypePin);
  const getTypeRoot = join(suite.root, "node_modules/@jest/get-type");
  mkdirSync(getTypeRoot, { recursive: true });
  writeFileSync(
    join(getTypeRoot, "package.json"),
    JSON.stringify(
      {
        name: "@jest/get-type",
        version: getTypePin.version,
        type: "module",
        main: "./index.ts",
        exports: "./index.ts",
        _sourceSha256: getType.sha256,
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(join(getTypeRoot, "index.ts"), getType.source);

  // jest-jasmine2's queueRunner imports formatTime through the published
  // package name. Materialize only that exact release-tag utility in a tiny
  // ESM package adapter; its implementation remains the upstream source.
  const utilPin = suite.pin.dependencies?.["jest-util"] ?? JEST_UTIL_PIN;
  const util = resolveJestUtilFormatTimeSource(suite, utilPin);
  const utilRoot = join(suite.root, "node_modules/jest-util");
  mkdirSync(utilRoot, { recursive: true });
  writeFileSync(
    join(utilRoot, "package.json"),
    JSON.stringify(
      {
        name: "jest-util",
        version: utilPin.version,
        type: "module",
        main: "./index.ts",
        exports: "./index.ts",
        _sourceSha256: util.sha256,
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(
    join(utilRoot, "index.ts"),
    'export { default as formatTime } from "../../packages/jest-util/src/formatTime.ts";\n',
  );
  return suite;
}
