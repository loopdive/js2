// Marked 18.0.2 original Hooks unit tests against its matching published build.

import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { setupMarked } from "./setup-marked.mjs";
import { setupMarkedUpstreamSuite } from "./setup-marked-upstream-suite.mjs";
import {
  UPSTREAM_TEST_EXPORTS,
  UPSTREAM_TEST_SHIM,
  cliUpstreamHarness,
  compileAndRunUpstreamModule,
  summarizeUpstreamRuns,
  writeUpstreamReport,
} from "./upstream-suite-runner.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const GENERATED_ROOT = resolve(HERE, "..", "..", ".marked-upstream-suite-generated");
const REPORT_PATH = join(HERE, "report", "marked-upstream-suite.json");

const MARKED_ASSERT_SHIM = String.raw`
const assert = {
  ok(value, message) { const n = ++__upstreamAssertion; if (!value) __upstreamFail("assertion " + n + ": " + (message || "expected truthy value")); },
  strictEqual(actual, expected, message) { const n = ++__upstreamAssertion; if (actual !== expected) __upstreamFail("assertion " + n + ": " + (message || "strictEqual mismatch") + " actual=" + String(actual) + " expected=" + String(expected)); },
  deepStrictEqual(actual, expected, message) { const n = ++__upstreamAssertion; if (!__upstreamSame(actual, expected)) __upstreamFail("assertion " + n + ": " + (message || "deepStrictEqual mismatch")); },
};
function timeout() { return Promise.resolve(); }
`;

function moduleSpecifier(fromDirectory, target) {
  let value = relative(fromDirectory, target).replace(/\\/g, "/");
  if (!value.startsWith(".")) value = `./${value}`;
  return value;
}

function transformMarkedTest(source, generatedPath, packageRoot) {
  const implementation = join(packageRoot, "package", "lib", "marked.esm.js");
  return source
    .replace(
      /^import\s+\{\s*Marked\s*\}\s+from\s+['"]\.\.\/\.\.\/lib\/marked\.esm\.js['"];?\s*$/m,
      `import { Marked } from '${moduleSpecifier(dirname(generatedPath), implementation)}';`,
    )
    .replace(/^import\s+\{\s*timeout\s*\}\s+from\s+['"]\.\/utils\.js['"];?\s*$/m, "")
    .replace(/^import\s+\{[^\n]+\}\s+from\s+['"]node:test['"];?\s*$/m, "")
    .replace(/^import\s+assert\s+from\s+['"]node:assert['"];?\s*$/m, "");
}

export async function runHarness({ quiet = false } = {}) {
  const log = quiet ? () => {} : (...values) => console.log(...values);
  const packageSetup = setupMarked();
  const suite = setupMarkedUpstreamSuite();
  const runs = [];

  log(`[dogfood] marked@${suite.pin.version} upstream ${suite.pin.tag} (${suite.pin.commit.slice(0, 12)})`);
  for (const filePath of suite.selectedPaths) {
    const file = suite.relativePath(filePath);
    const generatedPath = join(GENERATED_ROOT, file.replace(/\.js$/, ".ts"));
    const transformed = transformMarkedTest(readFileSync(filePath, "utf-8"), generatedPath, packageSetup.root);
    const source = `${UPSTREAM_TEST_SHIM}\n${MARKED_ASSERT_SHIM}\n${transformed}\n${UPSTREAM_TEST_EXPORTS}`;
    const timeoutMs = Number(process.env.DOGFOOD_MARKED_TIMEOUT_MS ?? 300_000);
    const result = await compileAndRunUpstreamModule({ generatedPath, source, timeoutMs });
    runs.push({ file, result });
    log(
      `[dogfood] ${file}: ${result.native.statuses.filter(Boolean).length}/${result.native.count} native; ` +
        `${result.wasm?.statuses.filter(Boolean).length ?? 0}/${result.native.count} Wasm`,
    );
  }

  const report = summarizeUpstreamRuns({
    name: `marked@${suite.pin.version}`,
    pin: suite.pin,
    testFiles: suite.testFiles,
    selectedFiles: suite.pin.selectedFiles,
    runs,
  });
  writeUpstreamReport(REPORT_PATH, report);
  log(`[dogfood] ${report.summary.headline}; ${report.extraction.filesDeferred} upstream files explicitly deferred`);
  log(`[dogfood] report → ${REPORT_PATH}`);
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) cliUpstreamHarness(runHarness);
