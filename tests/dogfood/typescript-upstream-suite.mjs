// TypeScript 5.9.3 original base64 and bigint utility unit slice.

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

function extractFunction(source, marker) {
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`TypeScript utility marker changed: ${marker}`);
  const open = source.indexOf("{", start);
  if (open < 0) throw new Error(`TypeScript utility body marker changed: ${marker}`);
  let depth = 0;
  let quote = null;
  let lineComment = false;
  let blockComment = false;
  for (let index = open; index < source.length; index++) {
    const current = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (current === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (current === "*" && next === "/") {
        blockComment = false;
        index++;
      }
      continue;
    }
    if (quote) {
      if (current === "\\") index++;
      else if (current === quote) quote = null;
      continue;
    }
    if (current === "/" && next === "/") {
      lineComment = true;
      index++;
      continue;
    }
    if (current === "/" && next === "*") {
      blockComment = true;
      index++;
      continue;
    }
    if (current === '"' || current === "'" || current === "`") {
      quote = current;
      continue;
    }
    if (current === "{") depth++;
    else if (current === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`TypeScript utility function is unterminated: ${marker}`);
}
function exactTypescriptProjection(utilitiesSource) {
  utilitiesSource = utilitiesSource.replace(/\r\n/g, "\n");
  const startMarker = "/**\n * Replace each instance of non-ascii characters";
  const endMarker = "/** @internal */\nexport function readJsonOrUndefined";
  const start = utilitiesSource.indexOf(startMarker);
  const end = utilitiesSource.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error("TypeScript base64 implementation markers changed");
  const declarations = utilitiesSource.slice(start, end);
  const parsePseudoBigInt = extractFunction(utilitiesSource, "export function parsePseudoBigInt");
  const characterCodes = `const CharacterCodes = { _0: 48, _9: 57, A: 65, B: 66, F: 70, O: 79, X: 88, a: 97, b: 98, o: 111, x: 120 } as const;`;
  return `const Debug = { assert(value: boolean, message?: string) { if (!value) throw new Error(message || "Debug assertion failed"); } };\n${characterCodes}\n${declarations}\n${parsePseudoBigInt}`;
}

function transformTypescriptTest(source, projectionSpecifier) {
  return source.replace(
    /^import\s+\*\s+as\s+ts\s+from\s+["']\.\.\/_namespaces\/ts\.js["'];?\s*$/m,
    `import { base64decode, base64encode, convertToBase64, parsePseudoBigInt } from ${JSON.stringify(projectionSpecifier)};\nconst ts = { base64decode, base64encode, convertToBase64, parsePseudoBigInt, sys: { base64decode: (input) => base64decode(undefined, input), base64encode: (input) => base64encode(undefined, input) } };`,
  );
}

export async function runHarness({ quiet = false } = {}) {
  const log = quiet ? () => {} : (...values) => console.log(...values);
  const suite = setupTypescriptUpstreamSuite();
  const utilitiesPath = join(suite.root, "src", "compiler", "utilities.ts");
  const projectionPath = join(GENERATED_ROOT, "release-base64.ts");
  mkdirSync(dirname(projectionPath), { recursive: true });
  writeFileSync(projectionPath, exactTypescriptProjection(readFileSync(utilitiesPath, "utf-8")));
  const runs = [];

  log(`[dogfood] typescript@${suite.pin.version} upstream ${suite.pin.tag} (${suite.pin.commit.slice(0, 12)})`);
  for (const filePath of suite.selectedPaths) {
    const file = suite.relativePath(filePath);
    const generatedPath = join(GENERATED_ROOT, file);
    const original = readFileSync(filePath, "utf-8");
    const transformed = transformTypescriptTest(original, moduleSpecifier(dirname(generatedPath), projectionPath));
    const source = `${UPSTREAM_TEST_SHIM}\nconst assert = __qunitAssert;\n${transformed}\n${UPSTREAM_TEST_EXPORTS}`;
    const result = await compileAndRunUpstreamModule({
      generatedPath,
      source,
      timeoutMs: 240_000,
      workerEnv: { DOGFOOD_PLATFORM: "node" },
    });
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
