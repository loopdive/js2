// clsx@2.1.1's complete original uvu suite against the pinned npm tarball.

import { readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { setupClsx } from "./setup-clsx.mjs";
import { setupClsxUpstreamSuite } from "./setup-clsx-upstream-suite.mjs";
import {
  UPSTREAM_TEST_EXPORTS,
  UPSTREAM_TEST_SHIM,
  cliUpstreamHarness,
  compileAndRunUpstreamModule,
  summarizeUpstreamRuns,
  writeUpstreamReport,
} from "./upstream-suite-runner.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const GENERATED_ROOT = resolve(HERE, "..", "..", ".clsx-upstream-suite-generated");
const REPORT_PATH = join(HERE, "report", "clsx-upstream-suite.json");

const UVU_ASSERT_SHIM = String.raw`
const assert = {
  is(actual, expected, message) {
    const n = ++__upstreamAssertion;
    if (!Object.is(actual, expected)) {
      __upstreamFail("assertion " + n + ": " + (message || "is mismatch") + "; " + __upstreamValue(actual) + " !== " + __upstreamValue(expected));
    }
  },
  type(actual, expected, message) {
    const n = ++__upstreamAssertion;
    if (typeof actual !== expected) {
      __upstreamFail("assertion " + n + ": " + (message || "type mismatch") + "; " + typeof actual + " !== " + expected);
    }
  },
};
`;

function moduleSpecifier(fromDirectory, target) {
  let value = relative(fromDirectory, target).replace(/\\/g, "/");
  if (!value.startsWith(".")) value = `./${value}`;
  return value;
}

function transformClsxTest(source, generatedPath, packageRoot) {
  source = source
    .replace(/^import\s+\{\s*test\s*\}\s+from\s+['"]uvu['"];?\s*$/gm, "")
    .replace(/^import\s+\*\s+as\s+assert\s+from\s+['"]uvu\/assert['"];?\s*$/gm, "")
    .replace(/^test\.run\(\);?\s*$/gm, "");

  source = source.replace(/from\s+(['"])\.\.\/src(?:\/lite)?\1/g, (match, quote) => {
    const lite = match.includes("/lite");
    const target = join(packageRoot, "package", "dist", lite ? "lite.mjs" : "clsx.mjs");
    return `from ${quote}${moduleSpecifier(dirname(generatedPath), target)}${quote}`;
  });

  // Namespace objects containing callable exports are not yet a reliable
  // internal Wasm carrier. Preserve the upstream `mod.default`/`mod.clsx`
  // test body while making the two real ESM bindings explicit at the import
  // seam; this still tests both exports and their identity.
  source = source.replace(
    /import\s+\*\s+as\s+mod\s+from\s+(['"])([^'"]+)\1;/,
    (_match, quote, specifier) =>
      `import clsxDefault, { clsx as clsxNamed } from ${quote}${specifier}${quote};\n` +
      "const mod = { default: clsxDefault, clsx: clsxNamed };",
  );
  source = source.replace("const fn = mod.default;", "const fn = clsxDefault;");
  return source;
}

export async function runHarness({ quiet = false } = {}) {
  const log = quiet ? () => {} : (...values) => console.log(...values);
  const packageSetup = setupClsx();
  const suite = setupClsxUpstreamSuite();
  const runs = [];

  log(`[dogfood] clsx@${packageSetup.version} upstream ${suite.pin.tag} (${suite.pin.commit.slice(0, 12)})`);
  for (const filePath of suite.selectedPaths) {
    const file = suite.relativePath(filePath);
    const generatedPath = join(GENERATED_ROOT, `${basename(filePath, ".js")}.mjs`);
    const transformed = transformClsxTest(readFileSync(filePath, "utf-8"), generatedPath, packageSetup.root);
    const source = `${UPSTREAM_TEST_SHIM}\n${UVU_ASSERT_SHIM}\n${transformed}\n${UPSTREAM_TEST_EXPORTS}`;
    const result = await compileAndRunUpstreamModule({ generatedPath, source, timeoutMs: 180_000 });
    runs.push({ file, result });
    log(
      `[dogfood] ${file}: ${result.native.statuses.filter(Boolean).length}/${result.native.count} native; ` +
        `${result.wasm?.statuses.filter(Boolean).length ?? 0}/${result.native.count} Wasm`,
    );
  }

  const report = summarizeUpstreamRuns({
    name: `clsx@${packageSetup.version}`,
    pin: suite.pin,
    testFiles: suite.testFiles,
    selectedFiles: suite.pin.selectedFiles,
    runs,
  });
  writeUpstreamReport(REPORT_PATH, report);
  log(`[dogfood] ${report.summary.headline}`);
  log(`[dogfood] report → ${REPORT_PATH}`);
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) cliUpstreamHarness(runHarness);
