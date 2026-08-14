// cookie@2.0.1's complete original Vitest source inventory against the
// matching byte-verified published implementation.

import { readFileSync } from "node:fs";
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
    const source = `${UPSTREAM_TEST_SHIM}\n${transformed}\n${UPSTREAM_TEST_EXPORTS}`;
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
