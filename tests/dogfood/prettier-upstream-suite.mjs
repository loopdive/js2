// Prettier 3.8.1 original synchronous unit slice against its pinned source.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { setupPrettierUpstreamSuite } from "./setup-prettier-upstream-suite.mjs";
import {
  UPSTREAM_TEST_EXPORTS,
  UPSTREAM_TEST_SHIM,
  cliUpstreamHarness,
  compileAndRunUpstreamModule,
  summarizeUpstreamRuns,
  writeUpstreamReport,
} from "./upstream-suite-runner.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const GENERATED_ROOT = resolve(HERE, "..", "..", ".prettier-upstream-suite-generated");
const REPORT_PATH = join(HERE, "report", "prettier-upstream-suite.json");

function moduleSpecifier(fromDirectory, target) {
  let value = relative(fromDirectory, target).replace(/\\/g, "/");
  if (!value.startsWith(".")) value = `./${value}`;
  return value;
}

function transformPrettierTest(source, filePath, generatedPath) {
  return source.replace(/from\s+(["'])(\.\.?\/[^"']+)\1/g, (_match, quote, specifier) => {
    const target = resolve(dirname(filePath), specifier);
    return `from ${quote}${moduleSpecifier(dirname(generatedPath), target)}${quote}`;
  });
}

function readPrettierSnapshots(snapshotPath) {
  const source = readFileSync(snapshotPath, "utf-8");
  const values = {};
  const pattern = /exports\[`([^`]*)`\] = `\n([\s\S]*?)\n`;/g;
  for (const match of source.matchAll(pattern)) {
    const key = match[1].replace(/ \d+$/, "");
    values[key] = match[2];
  }
  return values;
}

function buildPrettierSnapshotShim(snapshotPath) {
  const snapshots = JSON.stringify(readPrettierSnapshots(snapshotPath));
  return String.raw`
const __prettierSnapshotValues = ${snapshots};
function __prettierSnapshotSerialize(value, depth) {
  if (value === null) return "null";
  const kind = typeof value;
  if (kind === "string") return '"' + value + '"';
  if (kind === "number" || kind === "boolean" || kind === "undefined") return String(value);
  if (kind !== "object") return String(value);
  const indent = "  ".repeat(depth);
  const childIndent = "  ".repeat(depth + 1);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    let output = "[\n";
    for (let index = 0; index < value.length; index++) {
      output += childIndent + __prettierSnapshotSerialize(value[index], depth + 1) + ",\n";
    }
    return output + indent + "]";
  }
  const keys = Object.keys(value).sort();
  if (keys.length === 0) return "{}";
  let output = "{\n";
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index];
    output += childIndent + '"' + key + '": ' + __prettierSnapshotSerialize(value[key], depth + 1) + ",\n";
  }
  return output + indent + "}";
}
__upstreamSnapshotMatcher = function (value) {
  const expected = __prettierSnapshotValues["visitor keys " + __upstreamCurrentTestName];
  return expected !== undefined && __prettierSnapshotSerialize(value, 0) === expected;
};
`;
}

export async function runHarness({ quiet = false } = {}) {
  const log = quiet ? () => {} : (...values) => console.log(...values);
  const suite = setupPrettierUpstreamSuite();
  const runs = [];

  log(`[dogfood] prettier@${suite.pin.version} upstream ${suite.pin.tag} (${suite.pin.commit.slice(0, 12)})`);
  for (const filePath of suite.selectedPaths) {
    const file = suite.relativePath(filePath);
    const generatedPath = join(GENERATED_ROOT, file.replace(/\.js$/, ".ts"));
    const transformed = transformPrettierTest(readFileSync(filePath, "utf-8"), filePath, generatedPath);
    const snapshotPath = join(suite.root, "tests", "unit", "__snapshots__", `${filePath.split("/").at(-1)}.snap`);
    const snapshotShim = existsSync(snapshotPath) ? buildPrettierSnapshotShim(snapshotPath) : "";
    const source = `${UPSTREAM_TEST_SHIM}\n${snapshotShim}\n${transformed}\n${UPSTREAM_TEST_EXPORTS}`;
    const result = await compileAndRunUpstreamModule({ generatedPath, source, timeoutMs: 240_000 });
    runs.push({ file, result });
    log(
      `[dogfood] ${file}: ${result.native.statuses.filter(Boolean).length}/${result.native.count} native; ` +
        `${result.wasm?.statuses.filter(Boolean).length ?? 0}/${result.native.count} Wasm`,
    );
  }

  const report = summarizeUpstreamRuns({
    name: `prettier@${suite.pin.version}`,
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
