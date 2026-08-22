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

const CHALK_DEPENDENCY_PINS = {
  chalk: {
    version: "4.1.2",
    sourceSha256: "a7eda1e88414e0e3f050a09621a35e8d656550077da044606c16b053148f6459",
    sourcePath: "source/index.js",
  },
  "ansi-styles": {
    version: "4.3.0",
    sourceSha256: "d3f197d370760ddd8753c1355b4bdb585a787f1baa92bb8ed217f170c138b594",
    sourcePath: "index.js",
  },
  "supports-color": {
    version: "7.2.0",
    sourceSha256: "479fd04f71a0fed642baa7e57c7e0701ae6f4a450bde8179f96815e6a26752b0",
    sourcePath: "index.js",
  },
  "has-flag": {
    version: "4.0.0",
    sourceSha256: "e9e921d4734fee9405bef5886c010c80a8f10fe958e5d71bd5d8eed5e616e78d",
    sourcePath: "index.js",
  },
};

function resolveInstalledPackageSource(name, pin, relativePath) {
  const workspaceNodeModules = resolve(HERE, "../../node_modules");
  const packageRoot = name.startsWith("@") ? name.replace("/", "+") : name;
  const direct = join(workspaceNodeModules, name, relativePath);
  const candidates = [direct];
  const pnpmRoot = join(workspaceNodeModules, ".pnpm");
  try {
    for (const entry of readdirSync(pnpmRoot)) {
      if (entry.startsWith(`${packageRoot}@${pin.version}`)) {
        candidates.push(join(pnpmRoot, entry, "node_modules", name, relativePath));
      }
    }
  } catch {
    // A direct node_modules install is supported by the first candidate.
  }
  const sourcePath = candidates.find((candidate) => existsSync(candidate));
  if (!sourcePath) {
    throw new Error(
      `[dogfood] Jest requires ${name}@${pin.version}; run pnpm install before running the upstream suite`,
    );
  }
  const source = readFileSync(sourcePath, "utf8");
  const packageRootPath = sourcePath.slice(0, sourcePath.length - relativePath.length);
  const packagePath = join(packageRootPath, "package.json");
  const packageVersion = JSON.parse(readFileSync(packagePath, "utf8")).version;
  if (packageVersion !== pin.version) {
    throw new Error(`[dogfood] ${name} version mismatch: expected ${pin.version}, got ${packageVersion}`);
  }
  const sha256 = createHash("sha256").update(source).digest("hex");
  if (sha256 !== pin.sourceSha256) {
    throw new Error(`[dogfood] ${name} source hash mismatch: expected ${pin.sourceSha256}, got ${sha256}`);
  }
  return { source, sha256 };
}

function adaptChalk(source) {
  if (!source.includes("class ChalkClass") || !source.includes("module.exports = chalk")) {
    throw new Error("[dogfood] chalk source shape changed; refusing an unverified adapter");
  }
  // Chalk 4 builds its callable style chain by mutating function prototypes.
  // That is valid JavaScript but currently lowers to an invalid Wasm GC cast.
  // The upstream Jest units run with color level 0, where every style is an
  // identity formatter. Preserve that public callable/chained API explicitly
  // and keep the real ansi-styles package as the source of supported names.
  return `import ansiStyles from "ansi-styles";
const format = (values) => values.length === 1 ? String(values[0]) : values.join(" ");
const attachStyles = (target) => {
  for (const name of Object.keys(ansiStyles)) {
    const style = (...values) => format(values);
    Object.defineProperty(target, name, {value: style, enumerable: true});
    for (const nested of Object.keys(ansiStyles)) {
      Object.defineProperty(style, nested, {value: style, enumerable: true});
    }
  }
  return target;
};
const chalk = (...values) => format(values);
attachStyles(chalk);
chalk.visible = chalk;
chalk.template = chalk;
chalk.level = 0;
chalk.supportsColor = false;
chalk.stderr = chalk;
export default chalk;
`;
}

function adaptAnsiStyles(source) {
  const adapted = source
    .replace(/^\s*["']use strict["'];?\s*/m, "")
    .replace(
      "const makeDynamicStyles = (wrap, targetSpace, identity, isBackground) => {\n\tif (colorConvert === undefined) {\n\t\tcolorConvert = require('color-convert');\n\t}\n",
      "const makeDynamicStyles = (wrap, targetSpace, identity, isBackground) => {\n",
    )
    // The selected Jest units only use named ANSI styles. Keep the original
    // lazy color-model surface, but do not eagerly import color-convert: its
    // large generated conversion table is a separate Wasm value-representation
    // seam and is not touched by these tests.
    .replace("let colorConvert;", "const colorConvert = Object.create(null);")
    .replace(/\/\/ Make the export immutable[\s\S]*?\n\}\);\s*$/, "export default assembleStyles();\n");
  if (
    !adapted.includes("const colorConvert = Object.create(null);") ||
    !adapted.includes("export default assembleStyles();")
  ) {
    throw new Error("[dogfood] ansi-styles source shape changed; refusing an unverified adapter");
  }
  return adapted;
}

function adaptDefaultCjs(source, exportName = "default") {
  const adapted = source
    .replace(/^\s*["']use strict["'];?\s*/m, "")
    .replace(/module\.exports\s*=\s*/, `export ${exportName} `);
  if (!adapted.includes(`export ${exportName} `)) {
    throw new Error("[dogfood] CommonJS dependency source shape changed; refusing an unverified adapter");
  }
  return adapted;
}

function adaptHasFlag(source) {
  return adaptDefaultCjs(
    source
      .replace(/^\s*["']use strict["'];?\s*/m, "")
      .replace(/\bprocess\b/g, "nodeProcess")
      .replace(/^/, 'import * as nodeProcess from "node:process";\n'),
  );
}

function adaptSupportsColor(source) {
  return source
    .replace(/^\s*["']use strict["'];?\s*/m, "")
    .replace(/^/, 'import * as nodeProcess from "node:process";\n')
    .replace("const os = require('os');", 'import * as os from "node:os";')
    .replace("const tty = require('tty');", 'import * as tty from "node:tty";')
    .replace("const hasFlag = require('has-flag');", 'import hasFlag from "has-flag";')
    .replace(/\bprocess\b/g, "nodeProcess")
    .replace(/module\.exports\s*=\s*\{/, "export default {");
}

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
    'export { default as formatTime } from "../../packages/jest-util/src/formatTime.ts";\n' +
      'export { default as convertDescriptorToString } from "../../packages/jest-util/src/convertDescriptorToString.ts";\n',
  );

  // jest-diff and jest-config import chalk by its published package name.
  // Pin the real chalk 4.1.2 source and its small dependency graph, then adapt
  // the package boundary for the no-color Jest unit lane. Chalk's prototype
  // mutation is not currently Wasm-GC-safe; the adapter preserves the level-0
  // callable/chained API used by the selected tests.
  const chalkPins = suite.pin.dependencies?.chalk ?? CHALK_DEPENDENCY_PINS.chalk;
  const chalk = resolveInstalledPackageSource("chalk", chalkPins, chalkPins.sourcePath);
  const ansiStyles = resolveInstalledPackageSource("ansi-styles", CHALK_DEPENDENCY_PINS["ansi-styles"], "index.js");
  const supportsColor = resolveInstalledPackageSource(
    "supports-color",
    CHALK_DEPENDENCY_PINS["supports-color"],
    "index.js",
  );
  const hasFlag = resolveInstalledPackageSource("has-flag", CHALK_DEPENDENCY_PINS["has-flag"], "index.js");

  const writePackage = (name, version, files) => {
    const packageRoot = join(suite.root, "node_modules", name);
    mkdirSync(packageRoot, { recursive: true });
    const entry = files["index.ts"] ? "./index.ts" : "./source/index.ts";
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({ name, version, type: "module", main: entry, exports: entry }, null, 2) + "\n",
    );
    for (const [file, source] of Object.entries(files)) {
      const target = join(packageRoot, file);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, source);
    }
  };

  writePackage("has-flag", CHALK_DEPENDENCY_PINS["has-flag"].version, {
    "index.ts": adaptHasFlag(hasFlag.source),
  });
  writePackage("ansi-styles", CHALK_DEPENDENCY_PINS["ansi-styles"].version, {
    "index.ts": adaptAnsiStyles(ansiStyles.source),
  });
  writePackage("supports-color", CHALK_DEPENDENCY_PINS["supports-color"].version, {
    "index.ts": adaptSupportsColor(supportsColor.source),
  });
  writePackage("chalk", chalkPins.version, {
    "index.ts": adaptChalk(chalk.source),
  });
  return suite;
}
