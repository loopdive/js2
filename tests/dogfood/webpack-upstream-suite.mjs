// webpack 5.109.2 original synchronous utility-unit slice.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { setupNpmCompatCatalogPackage } from "./npm-compat-catalog.mjs";
import { setupWebpackUpstreamSuite } from "./setup-webpack-upstream-suite.mjs";
import {
  UPSTREAM_TEST_EXPORTS,
  UPSTREAM_TEST_SHIM,
  cliUpstreamHarness,
  compileAndRunUpstreamModule,
  summarizeUpstreamRuns,
  writeUpstreamReport,
} from "./upstream-suite-runner.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const GENERATED_ROOT = resolve(HERE, "..", "..", ".webpack-upstream-suite-generated");
const REPORT_PATH = join(HERE, "report", "webpack-upstream-suite.json");

function moduleSpecifier(fromDirectory, target) {
  let value = relative(fromDirectory, target).replace(/\\/g, "/");
  if (!value.startsWith(".")) value = `./${value}`;
  return value;
}

function transformWebpackTest(source, generatedPath, packageRoot) {
  source = source.replace(/^\s*["']use strict["'];?\s*$/gm, "");
  return source.replace(
    /const\s+([A-Za-z_$][\w$]*)\s*=\s*require\((["'])(\.\.\/lib\/[^"']+)\2\);?/g,
    (_match, localName, quote, sourceSpecifier) => {
      const packageRelative = sourceSpecifier.replace(/^\.\.\//, "");
      let target = join(packageRoot, "package", packageRelative);
      if (!existsSync(target) && existsSync(`${target}.js`)) target = `${target}.js`;
      if (!existsSync(target)) throw new Error(`[dogfood] webpack published tarball is missing ${packageRelative}`);
      return `import ${localName} from ${quote}${moduleSpecifier(dirname(generatedPath), target)}${quote};`;
    },
  );
}

export async function runHarness({ quiet = false } = {}) {
  const log = quiet ? () => {} : (...values) => console.log(...values);
  const packageSetup = setupNpmCompatCatalogPackage("webpack");
  const suite = setupWebpackUpstreamSuite();
  const runs = [];

  log(`[dogfood] webpack@${packageSetup.version} upstream ${suite.pin.tag} (${suite.pin.commit.slice(0, 12)})`);
  for (const filePath of suite.selectedPaths) {
    const file = suite.relativePath(filePath);
    const generatedPath = join(GENERATED_ROOT, file.replace(/\.js$/, ".ts"));
    const transformed = transformWebpackTest(readFileSync(filePath, "utf-8"), generatedPath, packageSetup.root);
    const source = `${UPSTREAM_TEST_SHIM}\n${transformed}\n${UPSTREAM_TEST_EXPORTS}`;
    const result = await compileAndRunUpstreamModule({ generatedPath, source, timeoutMs: 240_000 });
    runs.push({ file, result });
    log(
      `[dogfood] ${file}: ${result.native.statuses.filter(Boolean).length}/${result.native.count} native; ` +
        `${result.wasm?.statuses.filter(Boolean).length ?? 0}/${result.native.count} Wasm`,
    );
  }

  const report = summarizeUpstreamRuns({
    name: `webpack@${packageSetup.version}`,
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
