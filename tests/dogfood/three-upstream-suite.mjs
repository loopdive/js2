// Three.js r185 original MathUtils QUnit module against pinned source.

import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { setupThreeUpstreamSuite } from "./setup-three-upstream-suite.mjs";
import {
  UPSTREAM_TEST_EXPORTS,
  UPSTREAM_TEST_SHIM,
  cliUpstreamHarness,
  compileAndRunUpstreamModule,
  summarizeUpstreamRuns,
  writeUpstreamReport,
} from "./upstream-suite-runner.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const GENERATED_ROOT = resolve(HERE, "..", "..", ".three-upstream-suite-generated");
const REPORT_PATH = join(HERE, "report", "three-upstream-suite.json");

function moduleSpecifier(fromDirectory, target) {
  let value = relative(fromDirectory, target).replace(/\\/g, "/");
  if (!value.startsWith(".")) value = `./${value}`;
  return value;
}

function transformThreeTest(source, filePath, generatedPath) {
  // Three's QUnit modules are default-exported for the browser runner. The
  // default value is intentionally unused by this adapter, but retaining the
  // export lets the compiler elide the registration call as an unused module
  // result. Keep the original module body and callbacks intact while making
  // the registration expression an ordinary top-level side effect.
  const registered = source.replace(/\bexport\s+default\s+QUnit\.module\b/g, "QUnit.module");
  return registered.replace(/from\s+(["'])(\.\.?\/[^"']+)\1/g, (_match, quote, specifier) => {
    const target = resolve(dirname(filePath), specifier);
    return `from ${quote}${moduleSpecifier(dirname(generatedPath), target)}${quote}`;
  });
}

export async function runHarness({ quiet = false } = {}) {
  const log = quiet ? () => {} : (...values) => console.log(...values);
  const suite = setupThreeUpstreamSuite();
  const runs = [];

  log(`[dogfood] three@${suite.pin.version} upstream ${suite.pin.tag} (${suite.pin.commit.slice(0, 12)})`);
  for (const filePath of suite.selectedPaths) {
    const file = suite.relativePath(filePath);
    const generatedPath = join(GENERATED_ROOT, file.replace(/\.js$/, ".ts"));
    const transformed = transformThreeTest(readFileSync(filePath, "utf-8"), filePath, generatedPath);
    const source = `${UPSTREAM_TEST_SHIM}\n${transformed}\n${UPSTREAM_TEST_EXPORTS}`;
    const result = await compileAndRunUpstreamModule({ generatedPath, source, timeoutMs: 240_000 });
    runs.push({ file, result });
    log(
      `[dogfood] ${file}: ${result.native.statuses.filter(Boolean).length}/${result.native.count} native; ` +
        `${result.wasm?.statuses.filter(Boolean).length ?? 0}/${result.native.count} Wasm`,
    );
  }

  const report = summarizeUpstreamRuns({
    name: `three@${suite.pin.version}`,
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
