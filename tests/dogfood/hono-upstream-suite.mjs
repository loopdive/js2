// Hono v4.12.16 original upstream unit tests against the pinned npm tarball.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { setupNpmCompatCatalogPackage } from "./npm-compat-catalog.mjs";
import { setupHonoUpstreamSuite } from "./setup-hono-upstream-suite.mjs";
import {
  UPSTREAM_TEST_EXPORTS,
  UPSTREAM_TEST_SHIM,
  cliUpstreamHarness,
  compileAndRunUpstreamModule,
  summarizeUpstreamRuns,
  writeUpstreamReport,
} from "./upstream-suite-runner.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const GENERATED_ROOT = resolve(HERE, "..", "..", ".hono-upstream-suite-generated");
const REPORT_PATH = join(HERE, "report", "hono-upstream-suite.json");

function moduleSpecifier(fromDirectory, target) {
  let value = relative(fromDirectory, target).replace(/\\/g, "/");
  if (!value.startsWith(".")) value = `./${value}`;
  return value;
}

function transformHonoTest(source, filePath, sourceRoot, packageRoot, generatedPath) {
  source = source.replace(/^import\s+type\s+(?:\{[\s\S]*?\}|[A-Za-z_$][\w$]*)\s+from\s+["'][^"']+["'];?\s*/gm, "");
  source = source.replace(/^import\s+\{[^}]+\}\s+from\s+["']vitest["'];?\s*$/gm, "");
  return source.replace(/from\s+(["'])(\.[^"']*)\1/g, (_match, quote, specifier) => {
    const sourceTarget = resolve(dirname(filePath), specifier).replace(/\.(?:ts|tsx|js)$/, "");
    const sourceRelative = relative(join(sourceRoot, "src"), sourceTarget).replace(/\\/g, "/");
    if (sourceRelative.startsWith("..") || sourceRelative.includes(".test")) {
      throw new Error(`[dogfood] selected Hono test imports non-package source ${specifier}`);
    }
    let packageTarget = join(
      packageRoot,
      "package",
      "dist",
      sourceRelative === "" ? "index.js" : `${sourceRelative}.js`,
    );
    if (!existsSync(packageTarget) && sourceRelative !== "") {
      const indexTarget = join(packageRoot, "package", "dist", sourceRelative, "index.js");
      if (existsSync(indexTarget)) packageTarget = indexTarget;
    }
    if (!existsSync(packageTarget)) {
      throw new Error(`[dogfood] Hono published dist is missing ${sourceRelative}.js for ${specifier}`);
    }
    return `from ${quote}${moduleSpecifier(dirname(generatedPath), packageTarget)}${quote}`;
  });
}

export async function runHarness({ quiet = false } = {}) {
  const log = quiet ? () => {} : (...values) => console.log(...values);
  const packageSetup = setupNpmCompatCatalogPackage("hono");
  const suite = setupHonoUpstreamSuite();
  const runs = [];

  log(`[dogfood] hono@${packageSetup.version} upstream ${suite.pin.tag} (${suite.pin.commit.slice(0, 12)})`);
  for (const filePath of suite.selectedPaths) {
    const file = suite.relativePath(filePath);
    const generatedPath = join(GENERATED_ROOT, `${file.replace(/\.(?:ts|tsx)$/, "")}.ts`);
    const transformed = transformHonoTest(
      readFileSync(filePath, "utf-8"),
      filePath,
      suite.root,
      packageSetup.root,
      generatedPath,
    );
    const source = `${UPSTREAM_TEST_SHIM}\n${transformed}\n${UPSTREAM_TEST_EXPORTS}`;
    const result = await compileAndRunUpstreamModule({
      generatedPath,
      source,
      timeoutMs: 240_000,
      // Hono's buffer/crypto originals intentionally import the Node crypto
      // builtin. Keep that dependency at the host boundary for those files;
      // the other selected web-facing units remain on the hermetic web lane.
      workerEnv: /(?:^|\/)utils\/(?:buffer|crypto)\.test\.ts$/.test(file) ? { DOGFOOD_PLATFORM: "node" } : undefined,
    });
    runs.push({ file, result });
    log(
      `[dogfood] ${file}: ${result.native.statuses.filter(Boolean).length}/${result.native.count} native; ` +
        `${result.wasm?.statuses.filter(Boolean).length ?? 0}/${result.native.count} Wasm`,
    );
  }

  const report = summarizeUpstreamRuns({
    name: `hono@${packageSetup.version}`,
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
