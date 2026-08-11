// Moment 2.30.1 original upstream unit files against the pinned npm tarball.

import { readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { setupNpmCompatCatalogPackage } from "./npm-compat-catalog.mjs";
import { setupMomentUpstreamSuite } from "./setup-moment-upstream-suite.mjs";
import {
  UPSTREAM_TEST_EXPORTS,
  UPSTREAM_TEST_SHIM,
  cliUpstreamHarness,
  compileAndRunUpstreamModule,
  summarizeUpstreamRuns,
  writeUpstreamReport,
} from "./upstream-suite-runner.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const GENERATED_ROOT = resolve(HERE, "..", "..", ".moment-upstream-suite-generated");
const REPORT_PATH = join(HERE, "report", "moment-upstream-suite.json");

function moduleSpecifier(fromDirectory, target) {
  let value = relative(fromDirectory, target).replace(/\\/g, "/");
  if (!value.startsWith(".")) value = `./${value}`;
  return value;
}

function transformMomentTest(source, generatedPath, entryModulePath) {
  source = source.replace(/^import\s+\{[^}]+\}\s+from\s+["']\.\.\/qunit["'];?\s*$/gm, "");
  const importPath = moduleSpecifier(dirname(generatedPath), entryModulePath);
  source = source.replace(
    /^import\s+moment\s+from\s+["']\.\.\/\.\.\/moment["'];?\s*$/m,
    `import moment from ${JSON.stringify(importPath)};`,
  );
  return source.replace(/\bmodule\s*\(/g, "suiteModule(");
}

export async function runHarness({ quiet = false } = {}) {
  const log = quiet ? () => {} : (...values) => console.log(...values);
  const packageSetup = setupNpmCompatCatalogPackage("moment");
  const suite = setupMomentUpstreamSuite();
  const runs = [];

  log(`[dogfood] moment@${packageSetup.version} upstream ${suite.pin.tag} (${suite.pin.commit.slice(0, 12)})`);
  for (const filePath of suite.selectedPaths) {
    const file = suite.relativePath(filePath);
    const generatedPath = join(GENERATED_ROOT, `${basename(filePath, ".js")}.ts`);
    const transformed = transformMomentTest(
      readFileSync(filePath, "utf-8"),
      generatedPath,
      packageSetup.entryModulePath,
    );
    const source = `${UPSTREAM_TEST_SHIM}\n${transformed}\n${UPSTREAM_TEST_EXPORTS}`;
    const result = await compileAndRunUpstreamModule({ generatedPath, source, timeoutMs: 300_000 });
    runs.push({ file, result });
    log(
      `[dogfood] ${file}: ${result.native.statuses.filter(Boolean).length}/${result.native.count} native; ` +
        `${result.wasm?.statuses.filter(Boolean).length ?? 0}/${result.native.count} Wasm`,
    );
  }

  const report = summarizeUpstreamRuns({
    name: `moment@${packageSetup.version}`,
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
