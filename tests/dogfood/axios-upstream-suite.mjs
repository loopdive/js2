// Axios 1.16.1 original synchronous unit slice against the pinned npm tarball.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { setupAxiosUpstreamSuite } from "./setup-axios-upstream-suite.mjs";
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
const GENERATED_ROOT = resolve(HERE, "..", "..", ".axios-upstream-suite-generated");
const REPORT_PATH = join(HERE, "report", "axios-upstream-suite.json");

function moduleSpecifier(fromDirectory, target) {
  let value = relative(fromDirectory, target).replace(/\\/g, "/");
  if (!value.startsWith(".")) value = `./${value}`;
  return value;
}

function transformAxiosTest(source, filePath, suiteRoot, generatedPath, packageRoot) {
  source = source.replace(/^import\s+\{[^\n]+\}\s+from\s+['"]vitest['"];?\s*$/gm, "");
  source = source.replace(
    /import\s+\{\s*AxiosHeaders\s*\}\s+from\s+(["'])\.\.\/\.\.\/\.\.\/index\.js\1;?/g,
    (_match, quote) => {
      const target = join(packageRoot, "package", "lib", "core", "AxiosHeaders.js");
      return `import AxiosHeaders from ${quote}${moduleSpecifier(dirname(generatedPath), target)}${quote};`;
    },
  );
  return source.replace(/from\s+(["'])(\.\.\/[^"']+)\1/g, (match, quote, specifier) => {
    if (specifier.includes("tests/dogfood/.npm-compat/axios/package/")) return match;
    const sourceTarget = resolve(dirname(filePath), specifier);
    const sourceRelative = relative(suiteRoot, sourceTarget).replace(/\\/g, "/");
    if (sourceRelative.startsWith("..") || (!sourceRelative.startsWith("lib/") && sourceRelative !== "index.js")) {
      throw new Error(`[dogfood] selected Axios test imports non-package source ${specifier}`);
    }
    const packageTarget = join(packageRoot, "package", sourceRelative);
    if (!existsSync(packageTarget)) {
      throw new Error(`[dogfood] Axios published tarball is missing ${sourceRelative} for ${specifier}`);
    }
    return `from ${quote}${moduleSpecifier(dirname(generatedPath), packageTarget)}${quote}`;
  });
}

export async function runHarness({ quiet = false } = {}) {
  const log = quiet ? () => {} : (...values) => console.log(...values);
  const packageSetup = setupNpmCompatCatalogPackage("axios");
  const suite = setupAxiosUpstreamSuite();
  const runs = [];

  log(`[dogfood] axios@${packageSetup.version} upstream ${suite.pin.tag} (${suite.pin.commit.slice(0, 12)})`);
  for (const filePath of suite.selectedPaths) {
    const file = suite.relativePath(filePath);
    const generatedPath = join(GENERATED_ROOT, file.replace(/\.js$/, ".ts"));
    const transformed = transformAxiosTest(
      readFileSync(filePath, "utf-8"),
      filePath,
      suite.root,
      generatedPath,
      packageSetup.root,
    );
    const source = `${UPSTREAM_TEST_SHIM}\n${transformed}\n${UPSTREAM_TEST_EXPORTS}`;
    const workerEnv = suite.pin.nodeHostDependencyFiles?.includes(file) ? { DOGFOOD_NODE_HOST_DEPS: "1" } : undefined;
    const result = await compileAndRunUpstreamModule({ generatedPath, source, timeoutMs: 240_000, workerEnv });
    runs.push({ file, result });
    log(
      `[dogfood] ${file}: ${result.native.statuses.filter(Boolean).length}/${result.native.count} native; ` +
        `${result.wasm?.statuses.filter(Boolean).length ?? 0}/${result.native.count} Wasm`,
    );
  }

  const report = summarizeUpstreamRuns({
    name: `axios@${packageSetup.version}`,
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
