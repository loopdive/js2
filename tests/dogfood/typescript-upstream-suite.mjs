// TypeScript 5.9.3 original base64 unit slice.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { setupTypescriptUpstreamSuite } from "./setup-typescript-upstream-suite.mjs";
import {
  UPSTREAM_TEST_EXPORTS,
  UPSTREAM_TEST_SHIM,
  cliUpstreamHarness,
  compileAndRunUpstreamModule,
  summarizeUpstreamRuns,
  writeUpstreamReport,
} from "./upstream-suite-runner.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const GENERATED_ROOT = resolve(HERE, "..", "..", ".typescript-upstream-suite-generated");
const REPORT_PATH = join(HERE, "report", "typescript-upstream-suite.json");

function moduleSpecifier(fromDirectory, target) {
  let value = relative(fromDirectory, target).replace(/\\/g, "/");
  if (!value.startsWith(".")) value = `./${value}`;
  return value;
}

function exactBase64Projection(utilitiesSource) {
  utilitiesSource = utilitiesSource.replace(/\r\n/g, "\n");
  const startMarker = "/**\n * Replace each instance of non-ascii characters";
  const endMarker = "/** @internal */\nexport function readJsonOrUndefined";
  const start = utilitiesSource.indexOf(startMarker);
  const end = utilitiesSource.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error("TypeScript base64 implementation markers changed");
  const declarations = utilitiesSource.slice(start, end);
  return `const Debug = { assert(value: boolean, message?: string) { if (!value) throw new Error(message || "Debug assertion failed"); } };\n${declarations}`;
}

function transformTypescriptTest(source, projectionSpecifier) {
  return source.replace(
    /^import\s+\*\s+as\s+ts\s+from\s+["']\.\.\/_namespaces\/ts\.js["'];?\s*$/m,
    `import { base64decode, convertToBase64 } from ${JSON.stringify(projectionSpecifier)};\nconst ts = { base64decode, convertToBase64 };`,
  );
}

export async function runHarness({ quiet = false } = {}) {
  const log = quiet ? () => {} : (...values) => console.log(...values);
  const suite = setupTypescriptUpstreamSuite();
  const utilitiesPath = join(suite.root, "src", "compiler", "utilities.ts");
  const projectionPath = join(GENERATED_ROOT, "release-base64.ts");
  mkdirSync(dirname(projectionPath), { recursive: true });
  writeFileSync(projectionPath, exactBase64Projection(readFileSync(utilitiesPath, "utf-8")));
  const runs = [];

  log(`[dogfood] typescript@${suite.pin.version} upstream ${suite.pin.tag} (${suite.pin.commit.slice(0, 12)})`);
  for (const filePath of suite.selectedPaths) {
    const file = suite.relativePath(filePath);
    const generatedPath = join(GENERATED_ROOT, file);
    const original = readFileSync(filePath, "utf-8");
    const transformed = transformTypescriptTest(original, moduleSpecifier(dirname(generatedPath), projectionPath));
    const source = `${UPSTREAM_TEST_SHIM}\nconst assert = __qunitAssert;\n${transformed}\n${UPSTREAM_TEST_EXPORTS}`;
    const result = await compileAndRunUpstreamModule({ generatedPath, source, timeoutMs: 240_000 });
    runs.push({ file, result });
    log(
      `[dogfood] ${file}: ${result.native.statuses.filter(Boolean).length}/${result.native.count} native; ` +
        `${result.wasm?.statuses.filter(Boolean).length ?? 0}/${result.native.count} Wasm`,
    );
  }

  const report = summarizeUpstreamRuns({
    name: `typescript@${suite.pin.version}`,
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
