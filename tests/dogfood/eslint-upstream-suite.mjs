// eslint@10.0.3 upstream-suite dogfood harness.
//
// ESLint's npm tarball omits its tests. This harness checks out the immutable
// matching source tag, lifts every original body from the selected shared-
// utility units, and runs the same generated driver in Node and Wasm. CommonJS
// assertion and implementation requires are rebound: the implementation comes
// from the byte-verified published package and Chai/node:assert are represented
// by a deterministic assertion shim that both lanes share.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

import { compileProject } from "../../src/index.ts";
import { buildImports, wrapExports } from "../../src/runtime.ts";
import { setupEslint } from "./setup-eslint.mjs";
import { setupEslintUpstreamSuite } from "./setup-eslint-upstream-suite.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT_PATH = join(HERE, "report", "eslint-upstream-suite.json");
const GENERATED_ROOT = join(HERE, ".eslint-upstream-suite", "generated");

const DRIVER_SHIM = String.raw`
let __eslintTotal = 0;
let __eslintPassed = 0;
let __eslintFailures = [];

function __eslintDeepEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!__eslintDeepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    for (const key of aKeys) {
      if (!Object.prototype.hasOwnProperty.call(b, key) || !__eslintDeepEqual(a[key], b[key])) return false;
    }
    return true;
  }
  return false;
}

function __eslintAssert(value, message) {
  if (!value) throw new Error(message || "assertion failed");
}
// Keep the callable assertion separate from its methods. Assigning properties
// to a function is not a portable Wasm representation: the JS host sees those
// properties, while the compiled function value does not. The adapter rewrites
// method calls to this plain object below, so both lanes use the same API.
const __eslintAssertMethods = {
  strictEqual(actual, expected, message) {
    if (actual !== expected) throw new Error(message || "strictEqual");
  },
  deepStrictEqual(actual, expected, message) {
    if (!__eslintDeepEqual(actual, expected)) throw new Error(message || "deepStrictEqual");
  },
  isTrue(actual, message) {
    if (actual !== true) throw new Error(message || "isTrue");
  },
  isFalse(actual, message) {
    if (actual !== false) throw new Error(message || "isFalse");
  },
  throws(body, expected, message) {
    let error = null;
    try { body(); } catch (caught) { error = caught; }
    if (error === null) throw new Error(message || "throws");
    if (expected && typeof expected === "function" && !(error instanceof expected)) {
      throw new Error(message || "throws type");
    }
  },
};

function describe(_name, body) { body(); }
function it(_name, body) {
  __eslintTotal++;
  try {
    const result = body();
    if (result && typeof result.then === "function") throw new Error("async test not admitted");
    __eslintPassed++;
  } catch (_error) {
    if (__eslintFailures.length < 10) __eslintFailures.push({ name: String(_name), error: String(_error?.message ?? _error) });
  }
}
`;

function sourceSha256(source) {
  return createHash("sha256").update(source).digest("hex");
}

function replaceExactlyOnce(source, needle, replacement, label) {
  const first = source.indexOf(needle);
  if (first < 0 || source.indexOf(needle, first + needle.length) >= 0) {
    throw new Error(`[dogfood] expected exactly one ${label} declaration in the pinned ESLint test`);
  }
  return source.slice(0, first) + replacement + source.slice(first + needle.length);
}

function removeAssertRequire(source, sourcePath) {
  const patterns = [
    /const \{ assert \} = require\((['"])(?:chai|node:assert)\1\);/,
    /const assert = require\((['"])(?:chai|node:assert)\1\)(?:\.assert)?;/,
  ];
  const matches = patterns.filter((pattern) => pattern.test(source));
  if (matches.length !== 1) {
    throw new Error(`[dogfood] expected one Chai/assert require in ${sourcePath}`);
  }
  return source.replace(matches[0], "");
}

function generatedDriverSource(
  upstreamSource,
  sourcePath,
  implementationSpecifier,
  implementationModule,
  implementationExports,
) {
  let testSource = removeAssertRequire(upstreamSource, sourcePath);
  const modulePath = implementationModule.replace(/\.js$/, "");
  const escapedModulePath = modulePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const implementationRequirePattern = new RegExp(
    `require\\((?:['"])\\.\\.\\/\\.\\.\\/\\.\\.\\/${escapedModulePath}(?:\\.js)?(?:['"])\\)`,
  );
  const declarationPattern = new RegExp(`(?:^|\\n)(const[\\s\\S]*?${implementationRequirePattern.source}\\s*;)`);
  const declarationMatch = testSource.match(declarationPattern);
  if (!declarationMatch) throw new Error(`[dogfood] implementation require not found in ${sourcePath}`);
  const declaration = declarationMatch[1];
  const namespaceBinding = declaration.trim().match(/^const\s+([A-Za-z_$][\w$]*)\s*=/)?.[1];
  if (namespaceBinding) {
    for (const name of implementationExports) {
      testSource = testSource.replace(new RegExp(`\\b${namespaceBinding}\\.${name}\\b`, "g"), name);
    }
  }
  // The generated driver imports the implementation as ESM above. Remove the
  // original CommonJS declaration in every form, including destructuring
  // (`const { foo } = require(...)`); leaving `= ;` behind makes the native
  // oracle fail before it can register any callbacks.
  testSource = replaceExactlyOnce(testSource, declaration, "", "implementation require");
  testSource = testSource
    .replace(/\bassert\.(strictEqual|deepStrictEqual|isTrue|isFalse|throws)\b/g, "__eslintAssertMethods.$1")
    .replace(/\bassert\(/g, "__eslintAssert(");
  return [
    `import { ${implementationExports.join(", ")} } from ${JSON.stringify(implementationSpecifier)};`,
    DRIVER_SHIM,
    testSource,
    `export function eslintTotal() { return __eslintTotal; }
export function eslintPassed() { return __eslintPassed; }
export function eslintFailures() { return __eslintFailures; }
export function eslintFailureSummary() { return __eslintFailures.map(item => item.name + ":" + item.error).join(" | "); }
`,
  ].join("\n");
}

function recordError(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function readDriverResults(exports) {
  const total = exports.eslintTotal();
  const passed = exports.eslintPassed();
  return {
    total,
    passed,
    failed: total - passed,
    failureSummary: exports.eslintFailureSummary?.() ?? "",
  };
}

function relativeModuleSpecifier(fromDirectory, target) {
  let specifier = relative(fromDirectory, target).replaceAll("\\", "/");
  if (!specifier.startsWith(".")) specifier = `./${specifier}`;
  return specifier;
}

async function runFile({ file, sourcePath, implementationPath, implementationExports, index }) {
  const upstreamSource = readFileSync(sourcePath, "utf-8");
  const driverPath = join(GENERATED_ROOT, `${String(index).padStart(2, "0")}-${file.split("/").at(-1)}`);
  const implementationSpecifier = relativeModuleSpecifier(dirname(driverPath), implementationPath);
  const implementationModule = implementationPath.replace(/^.*?node_modules\/eslint\//, "");
  const generated = generatedDriverSource(
    upstreamSource,
    file,
    implementationSpecifier,
    implementationModule,
    implementationExports,
  );
  writeFileSync(driverPath, generated);

  let native = { total: 0, passed: 0, failed: 0 };
  let nativeError = null;
  try {
    const nativeModule = await import(`${pathToFileURL(driverPath).href}?run=${Date.now()}-${index}`);
    native = readDriverResults(nativeModule);
  } catch (error) {
    nativeError = recordError(error);
  }

  const compileStarted = performance.now();
  let compiled;
  try {
    compiled = await compileProject(driverPath, {
      allowJs: true,
      skipSemanticDiagnostics: true,
      target: "gc",
      platform: "node",
    });
  } catch (error) {
    compiled = { success: false, errors: [{ message: recordError(error) }] };
  }
  const compileMs = Math.round(performance.now() - compileStarted);
  const validates = compiled.success === true && WebAssembly.validate(compiled.binary);
  let wasm = { total: native.total, passed: 0, failed: native.total };
  let runtimeError = null;
  if (validates) {
    try {
      const imports = buildImports(compiled.imports, undefined, compiled.stringPool);
      const { instance } = await WebAssembly.instantiate(compiled.binary, imports);
      const candidate = readDriverResults(wrapExports(instance.exports, compiled.stringPool));
      if (candidate.total !== native.total) {
        runtimeError = `Wasm registered ${candidate.total} tests; native registered ${native.total}`;
      } else {
        wasm = candidate;
      }
    } catch (error) {
      runtimeError = recordError(error);
    }
  }
  if (runtimeError !== null) wasm = { total: native.total, passed: 0, failed: native.total };

  return {
    file,
    native,
    nativeError,
    wasm,
    runtimeError,
    compile: {
      success: compiled.success === true,
      validates,
      durationMs: compileMs,
      binaryBytes: compiled.success ? compiled.binary.byteLength : 0,
      errors: compiled.errors ?? [],
    },
    sourceSha256: sourceSha256(upstreamSource),
  };
}

export async function runHarness({ quiet = false } = {}) {
  const log = quiet ? () => {} : (...values) => console.log(...values);
  const { pin: suitePin, testPaths } = setupEslintUpstreamSuite();
  const { root: implementationRoot, version, pin: implementationPin } = setupEslint();
  mkdirSync(GENERATED_ROOT, { recursive: true });
  const files = [];
  for (let index = 0; index < testPaths.length; index++) {
    const file = suitePin.testFiles[index];
    const implementationModule = suitePin.implementationModules?.[file];
    if (!implementationModule) throw new Error(`[dogfood] no implementation module pin for ${file}`);
    const implementationPath = join(implementationRoot, implementationModule);
    const result = await runFile({
      file,
      sourcePath: testPaths[index],
      implementationPath,
      implementationExports: suitePin.implementationExports[file],
      index,
    });
    files.push(result);
    log(
      `[dogfood] ${file}: ${result.native.passed}/${result.native.total} native; ` +
        `${result.wasm.passed}/${result.native.total} Wasm`,
    );
  }

  const upstreamTestsSeen = files.reduce((total, file) => total + file.native.total, 0);
  const nativePassed = files.reduce((total, file) => total + file.native.passed, 0);
  const nativeFailed = files.reduce((total, file) => total + file.native.failed, 0);
  const passed = files.reduce((total, file) => total + (file.runtimeError ? 0 : file.wasm.passed), 0);
  const failed = files.reduce((total, file) => total + (file.runtimeError ? file.native.total : file.wasm.failed), 0);
  const compile = {
    success: files.every((file) => file.compile.success),
    validates: files.every((file) => file.compile.validates),
    durationMs: files.reduce((total, file) => total + file.compile.durationMs, 0),
    binaryBytes: files.reduce((total, file) => total + file.compile.binaryBytes, 0),
    errors: files.flatMap((file) => file.compile.errors),
  };

  const report = {
    issue: 1400,
    generatedAt: new Date().toISOString(),
    package: {
      name: "eslint",
      version,
      source: implementationPin.tarball,
      implementationModules: suitePin.implementationModules,
    },
    upstreamSuite: {
      repo: suitePin.repo,
      tag: suitePin.tag,
      commit: suitePin.commit,
      testFiles: suitePin.testFiles,
      sourceSha256: Object.fromEntries(files.map((file) => [file.file, file.sourceSha256])),
      scope: "five selected original shared-utility units; not ESLint's full test suite",
    },
    extraction: {
      upstreamTestsSeen,
      admitted: upstreamTestsSeen,
      rejected: 0,
      sourceEdits: [
        "rebind Chai/node:assert to one deterministic assertion shim shared by Node and Wasm",
        "rebind each package-relative implementation require to the byte-verified eslint@10.0.3 payload",
      ],
    },
    compile,
    results: {
      scored: upstreamTestsSeen,
      nativePassed,
      nativeFailed,
      passed,
      failed,
      files,
    },
    summary: {
      headline: `${passed}/${upstreamTestsSeen} original cases match; Node ${nativePassed}/${upstreamTestsSeen}`,
      wholePackageEntry: "separate bounded probe; currently exceeds its 180s compile budget",
    },
  };

  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  log(
    `[dogfood] eslint@${version} upstream ${suitePin.tag}: ${report.summary.headline} ` +
      `(compile ${compile.durationMs}ms, ${report.compile.binaryBytes} bytes)`,
  );
  log(`[dogfood] full report → ${REPORT_PATH}`);
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const jsonOnly = process.argv.includes("--json");
  runHarness({ quiet: jsonOnly })
    .then((report) => {
      if (jsonOnly) process.stdout.write(`${JSON.stringify(report)}\n`);
    })
    .catch((error) => {
      if (jsonOnly) process.stdout.write(`${JSON.stringify({ fatal: recordError(error) })}\n`);
      else console.error(error);
      process.exitCode = 1;
    });
}
