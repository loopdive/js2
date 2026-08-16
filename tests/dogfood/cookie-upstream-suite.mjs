// cookie@2.0.1's complete original Vitest source inventory against the
// matching byte-verified published implementation.

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { setupCookie } from "./setup-cookie.mjs";
import { setupCookieUpstreamSuite } from "./setup-cookie-upstream-suite.mjs";
import {
  UPSTREAM_TEST_EXPORTS,
  UPSTREAM_TEST_SHIM,
  cliUpstreamHarness,
  compileAndRunUpstreamModule,
  summarizeUpstreamRuns,
  writeUpstreamReport,
} from "./upstream-suite-runner.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const GENERATED_ROOT = resolve(HERE, "..", "..", ".cookie-upstream-suite-generated");
const REPORT_PATH = join(HERE, "report", "cookie-upstream-suite.json");

function moduleSpecifier(fromDirectory, target) {
  let value = relative(fromDirectory, target).replace(/\\/g, "/");
  if (!value.startsWith(".")) value = `./${value}`;
  return value;
}

function transformCookieTest(source, generatedPath, packageRoot, sourceRoot) {
  source = source.replace(/^import\s+\{[^}]+\}\s+from\s+["']vitest["'];?\s*$/gm, "");
  source = source.replace(/from\s+(["'])\.\/index\.js\1/g, (_match, quote) => {
    const target = join(packageRoot, "package", "dist", "index.js");
    return `from ${quote}${moduleSpecifier(dirname(generatedPath), target)}${quote}`;
  });
  source = source.replace(
    /^import\s+top\s+from\s+["']\.\.\/scripts\/(top-(?:set-)?cookie\.json)["']\s+with\s+\{\s*type:\s*["']json["']\s*\};?\s*$/m,
    (_match, file) => `const top = ${readFileSync(join(sourceRoot, "scripts", file), "utf-8")};`,
  );
  return source;
}

function readCookieSnapshots(snapshotPath) {
  const source = readFileSync(snapshotPath, "utf-8");
  const values = {};
  const pattern = /exports\[`([^`]*)`\] = `\n([\s\S]*?)\n`;/g;
  for (const match of source.matchAll(pattern)) {
    const key = match[1].replace(/ \d+$/, "").split(" > ").at(-1);
    if (key !== undefined) values[key] = match[2];
  }
  return values;
}

// The upstream suite uses Vitest's serialized snapshots for the generated
// top-site corpus. Keep those assertions real in both lanes: the expected
// pretty-format text is embedded in the generated module, and the small
// serializer below mirrors Vitest's `printBasicPrototype:false,
// escapeString:false` output used by the checked-in snapshots.
function buildCookieSnapshotShim(snapshotPath) {
  const snapshots = JSON.stringify(readCookieSnapshots(snapshotPath));
  return String.raw`
const __cookieSnapshotValues = ${snapshots};
function __cookieSnapshotSerialize(value, depth) {
  if (value === null) return "null";
  if (value instanceof Date) return value.toISOString();
  const kind = typeof value;
  if (kind === "string") return '"' + value + '"';
  if (kind === "number") {
    if (Number.isNaN(value)) return "NaN";
    if (value === Infinity) return "Infinity";
    if (value === -Infinity) return "-Infinity";
    if (Object.is(value, -0)) return "-0";
    return String(value);
  }
  if (kind === "boolean" || kind === "undefined") return String(value);
  if (kind !== "object") return String(value);
  const indent = "  ".repeat(depth);
  const childIndent = "  ".repeat(depth + 1);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    let output = "[\n";
    for (let index = 0; index < value.length; index++) {
      output += childIndent + __cookieSnapshotSerialize(value[index], depth + 1) + ",\n";
    }
    return output + indent + "]";
  }
  const keys = Object.keys(value).sort();
  if (keys.length === 0) return "{}";
  let output = "{\n";
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index];
    output += childIndent + '"' + key + '": ' + __cookieSnapshotSerialize(value[key], depth + 1) + ",\n";
  }
  return output + indent + "}";
}
__upstreamSnapshotMatcher = function (value) {
  const expected = __cookieSnapshotValues[__upstreamCurrentTestName];
  return expected !== undefined && __cookieSnapshotSerialize(value, 0) === expected;
};
`;
}

export async function runHarness({ quiet = false } = {}) {
  const log = quiet ? () => {} : (...values) => console.log(...values);
  const packageSetup = setupCookie();
  const suite = setupCookieUpstreamSuite();
  const runs = [];

  log(`[dogfood] cookie@${packageSetup.version} upstream ${suite.pin.tag} (${suite.pin.commit.slice(0, 12)})`);
  for (const filePath of suite.selectedPaths) {
    const file = suite.relativePath(filePath);
    const generatedPath = join(GENERATED_ROOT, `${basename(filePath, ".ts")}.ts`);
    const transformed = transformCookieTest(
      readFileSync(filePath, "utf-8"),
      generatedPath,
      packageSetup.root,
      suite.root,
    );
    const snapshotPath = join(suite.root, "src", "__snapshots__", `${basename(filePath)}.snap`);
    const snapshotShim = existsSync(snapshotPath) ? buildCookieSnapshotShim(snapshotPath) : "";
    const source = `${UPSTREAM_TEST_SHIM}\n${snapshotShim}\n${transformed}\n${UPSTREAM_TEST_EXPORTS}`;
    const result = await compileAndRunUpstreamModule({ generatedPath, source, timeoutMs: 300_000 });
    runs.push({ file, result });
    log(
      `[dogfood] ${file}: ${result.native.statuses.filter(Boolean).length}/${result.native.count} native; ` +
        `${result.wasm?.statuses.filter(Boolean).length ?? 0}/${result.native.count} Wasm`,
    );
  }

  const report = summarizeUpstreamRuns({
    name: `cookie@${packageSetup.version}`,
    pin: suite.pin,
    testFiles: suite.testFiles,
    selectedFiles: suite.pin.selectedFiles,
    runs,
  });
  writeUpstreamReport(REPORT_PATH, report);
  log(`[dogfood] ${report.summary.headline}; ${report.extraction.nativeFailed} harness-incompatible`);
  log(`[dogfood] report → ${REPORT_PATH}`);
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) cliUpstreamHarness(runHarness);
