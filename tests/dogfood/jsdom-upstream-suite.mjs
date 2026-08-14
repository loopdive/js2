// jsdom 30.0.1 original VirtualConsole API slice against the pinned npm tarball.

import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

import { setupJsdomUpstreamSuite } from "./setup-jsdom-upstream-suite.mjs";
import { setupNpmCompatCatalogPackage } from "./npm-compat-catalog.mjs";
import {
  UPSTREAM_TEST_EXPORTS,
  UPSTREAM_TEST_SHIM,
  cliUpstreamHarness,
  compileAndRunUpstreamModule,
  summarizeUpstreamRuns,
  writeUpstreamReport,
} from "./upstream-suite-runner.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const GENERATED_ROOT = resolve(HERE, "..", "..", ".jsdom-upstream-suite-generated");
const REPORT_PATH = join(HERE, "report", "jsdom-upstream-suite.json");

function moduleSpecifier(fromDirectory, target) {
  let value = relative(fromDirectory, target).replace(/\\/g, "/");
  if (!value.startsWith(".")) value = `./${value}`;
  return value;
}

function extractSelectedTests(source, filePath, selectedNames) {
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
  const selected = new Map();
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "it" &&
      node.arguments.length >= 2 &&
      (ts.isStringLiteral(node.arguments[0]) || ts.isNoSubstitutionTemplateLiteral(node.arguments[0]))
    ) {
      const name = node.arguments[0].text;
      if (selectedNames.includes(name)) selected.set(name, node.getText(sourceFile));
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  const missing = selectedNames.filter((name) => !selected.has(name));
  if (missing.length > 0)
    throw new Error(`[dogfood] jsdom selected tests missing from pinned source: ${missing.join(", ")}`);
  return selectedNames.map((name) => selected.get(name)).join("\n");
}

function transformJsdomTest(source, filePath, generatedPath, packageRoot, selectedNames) {
  const implementationPath = join(packageRoot, "package", "lib", "jsdom", "virtual-console.js");
  const callbacks = extractSelectedTests(source, filePath, selectedNames);
  const assertionShim = String.raw`
const assert = {
  equal(actual, expected, message) {
    if (actual != expected) __upstreamFail(message || "assert.equal mismatch");
  },
  deepEqual(actual, expected, message) {
    if (!__upstreamSame(actual, expected)) __upstreamFail(message || "assert.deepEqual mismatch");
  },
  throws(body, expected) {
    if (!__upstreamThrownMatches(__upstreamThrown(body), expected)) __upstreamFail("assert.throws mismatch");
  },
};`;
  return `import VirtualConsole from ${JSON.stringify(moduleSpecifier(dirname(generatedPath), implementationPath))};\n${assertionShim}\n${callbacks}`;
}

export async function runHarness({ quiet = false } = {}) {
  const log = quiet ? () => {} : (...values) => console.log(...values);
  const packageSetup = setupNpmCompatCatalogPackage("jsdom");
  const suite = setupJsdomUpstreamSuite();
  const runs = [];

  log(`[dogfood] jsdom@${packageSetup.version} upstream ${suite.pin.tag} (${suite.pin.commit.slice(0, 12)})`);
  for (const filePath of suite.selectedPaths) {
    const file = suite.relativePath(filePath);
    const generatedPath = join(GENERATED_ROOT, file.replace(/\.js$/, ".ts"));
    const transformed = transformJsdomTest(
      readFileSync(filePath, "utf-8"),
      filePath,
      generatedPath,
      packageSetup.root,
      suite.pin.selectedTests,
    );
    const source = `${UPSTREAM_TEST_SHIM}\n${transformed}\n${UPSTREAM_TEST_EXPORTS}`;
    const result = await compileAndRunUpstreamModule({ generatedPath, source, timeoutMs: 240_000 });
    runs.push({ file, result });
    log(
      `[dogfood] ${file}: ${result.native.statuses.filter(Boolean).length}/${result.native.count} native; ` +
        `${result.wasm?.statuses.filter(Boolean).length ?? 0}/${result.native.count} Wasm`,
    );
  }

  const report = summarizeUpstreamRuns({
    name: `jsdom@${packageSetup.version}`,
    pin: suite.pin,
    testFiles: suite.testFiles,
    selectedFiles: suite.pin.selectedFiles,
    runs,
  });
  report.extraction.callbacksSelected = suite.pin.selectedTests.length;
  report.extraction.callbacksDeferred = suite.pin.registrationSites - suite.pin.selectedTests.length;
  writeUpstreamReport(REPORT_PATH, report);
  log(`[dogfood] ${report.summary.headline}; ${report.extraction.callbacksDeferred} upstream registrations deferred`);
  log(`[dogfood] report → ${REPORT_PATH}`);
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) cliUpstreamHarness(runHarness);
