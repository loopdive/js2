// Lodash 4.18.1 original QUnit module slices against the pinned npm tarball.

import { readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { setupNpmCompatCatalogPackage } from "./npm-compat-catalog.mjs";
import { setupLodashUpstreamSuite } from "./setup-lodash-upstream-suite.mjs";
import {
  UPSTREAM_TEST_EXPORTS,
  UPSTREAM_TEST_SHIM,
  cliUpstreamHarness,
  compileAndRunUpstreamModule,
  summarizeUpstreamRuns,
  writeUpstreamReport,
} from "./upstream-suite-runner.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const GENERATED_ROOT = resolve(HERE, "..", "..", ".lodash-upstream-suite-generated");
const REPORT_PATH = join(HERE, "report", "lodash-upstream-suite.json");

function moduleSpecifier(fromDirectory, target) {
  let value = relative(fromDirectory, target).replace(/\\/g, "/");
  if (!value.startsWith(".")) value = `./${value}`;
  return value;
}

function extractModule(source, name) {
  const marker = `QUnit.module('${name}');`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`[dogfood] lodash upstream module not found: ${name}`);
  const next = source.indexOf("QUnit.module(", start + marker.length);
  return source.slice(start, next < 0 ? source.length : next);
}

export async function runHarness({ quiet = false } = {}) {
  const log = quiet ? () => {} : (...values) => console.log(...values);
  const packageSetup = setupNpmCompatCatalogPackage("lodash");
  const suite = setupLodashUpstreamSuite();
  const generatedPath = join(GENERATED_ROOT, "lodash-selected-modules.ts");
  const fullSource = readFileSync(suite.sourcePath, "utf-8");
  const slices = suite.pin.selectedModules.map((name) => extractModule(fullSource, name));
  const methodNames = suite.pin.selectedModules.map((name) => name.slice("lodash.".length));
  const methodImports = methodNames.map((name) => {
    const path = moduleSpecifier(dirname(generatedPath), join(packageSetup.root, "package", `${name}.js`));
    return `import ${name} from ${JSON.stringify(path)};`;
  });
  const source = [
    ...methodImports,
    `const _ = { ${methodNames.join(", ")} };`,
    UPSTREAM_TEST_SHIM,
    ...slices,
    UPSTREAM_TEST_EXPORTS,
  ].join("\n");

  log(`[dogfood] lodash@${packageSetup.version} upstream ${suite.pin.tag} (${suite.pin.commit.slice(0, 12)})`);
  const result = await compileAndRunUpstreamModule({ generatedPath, source, timeoutMs: 300_000 });
  const runs = [{ file: basename(suite.sourcePath), result }];
  const report = summarizeUpstreamRuns({
    name: `lodash@${packageSetup.version}`,
    pin: suite.pin,
    testFiles: suite.testFiles,
    selectedFiles: suite.testFiles,
    runs,
  });
  report.upstreamSuite.selectedModules = suite.pin.selectedModules;
  report.extraction.modulesSelected = suite.pin.selectedModules.length;
  report.extraction.registrationSitesDeferred = suite.pin.registrationSites - report.extraction.testsRegistered;
  writeUpstreamReport(REPORT_PATH, report);
  log(
    `[dogfood] ${report.summary.headline}; ${report.extraction.registrationSitesDeferred} ` +
      `QUnit registration sites explicitly deferred`,
  );
  log(`[dogfood] report → ${REPORT_PATH}`);
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) cliUpstreamHarness(runHarness);
