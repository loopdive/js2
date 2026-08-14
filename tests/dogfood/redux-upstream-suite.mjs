// Redux 5.0.1's complete original runtime unit suite against the pinned npm tarball.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as ts from "typescript";

import { setupNpmCompatCatalogPackage } from "./npm-compat-catalog.mjs";
import { setupReduxUpstreamSuite } from "./setup-redux-upstream-suite.mjs";
import {
  UPSTREAM_TEST_EXPORTS,
  UPSTREAM_TEST_SHIM,
  cliUpstreamHarness,
  compileAndRunUpstreamModule,
  summarizeUpstreamRuns,
  writeUpstreamReport,
} from "./upstream-suite-runner.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const GENERATED_ROOT = resolve(HERE, "..", "..", ".redux-upstream-suite-generated");
const REPORT_PATH = join(HERE, "report", "redux-upstream-suite.json");

const SUPPORT_FILES = [
  "test/helpers/actionTypes.ts",
  "test/helpers/actionCreators.ts",
  "test/helpers/reducers.ts",
  "test/helpers/middleware.ts",
  "src/utils/formatProdErrorMessage.ts",
  "src/utils/isAction.ts",
  "src/utils/isPlainObject.ts",
  "src/utils/warning.ts",
  "src/utils/symbol-observable.ts",
];

// Redux has one RxJS interoperability test. Keep its original callback and
// Observable protocol interaction, while supplying the narrow `from`/`map`
// test dependency at the same seam where Vitest's globals are supplied.
const RXJS_TEST_SHIM = String.raw`
function map(project) {
  return function(source) {
    return {
      subscribe(observer) {
        return source.subscribe(function(value) { observer(project(value)); });
      },
    };
  };
}
function from(input) {
  const observableKey = typeof Symbol === "function" && Symbol.observable ? Symbol.observable : "@@observable";
  const source = input[observableKey]();
  return {
    pipe(operator) { return operator(this); },
    subscribe(observer) {
      const target = typeof observer === "function" ? { next: observer } : observer;
      return source.subscribe(target);
    },
  };
}
`;

function moduleSpecifier(fromDirectory, target) {
  let value = relative(fromDirectory, target).replace(/\\/g, "/");
  if (!value.startsWith(".")) value = `./${value}`;
  return value;
}

function emittedSupportPath(relativePath) {
  return join(GENERATED_ROOT, relativePath.replace(/\.ts$/, ".mjs"));
}

function rewriteLocalExtension(source) {
  return source.replace(/from\s+(["'])(\.\.?\/[^"']+)(?:\.ts)?\1/g, (_match, quote, specifier) => {
    const withExtension = /\.[cm]?js$/.test(specifier) ? specifier : `${specifier}.mjs`;
    return `from ${quote}${withExtension}${quote}`;
  });
}

function emitSupportFiles(sourceRoot) {
  for (const file of SUPPORT_FILES) {
    const sourcePath = join(sourceRoot, file);
    const outputPath = emittedSupportPath(file);
    const transpiled = ts.transpileModule(readFileSync(sourcePath, "utf-8"), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ES2022,
      },
      fileName: sourcePath,
    });
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, rewriteLocalExtension(transpiled.outputText));
  }
}

function transformReduxTest(source, generatedPath, packageEntryPath) {
  source = source.replace(/^import\s+\{\s*vi\s*\}\s+from\s+['"]vitest['"];?\s*$/gm, "");
  source = source.replace(/^import\s+\{[^\n]+\}\s+from\s+['"]rxjs(?:\/operators)?['"];?\s*$/gm, "");

  source = source.replace(/from\s+(["'])(?:redux|\.\.\/src)\1/g, (_match, quote) => {
    return `from ${quote}${moduleSpecifier(dirname(generatedPath), packageEntryPath)}${quote}`;
  });
  source = source.replace(/from\s+(["'])(\.\/helpers\/[^"']+)\1/g, (_match, quote, specifier) => {
    const target = emittedSupportPath(`test/${specifier.slice(2)}.ts`);
    return `from ${quote}${moduleSpecifier(dirname(generatedPath), target)}${quote}`;
  });
  source = source.replace(/from\s+(["'])@internal\/utils\/([^"']+)\1/g, (_match, quote, name) => {
    const target = emittedSupportPath(`src/utils/${name}.ts`);
    return `from ${quote}${moduleSpecifier(dirname(generatedPath), target)}${quote}`;
  });
  source = source.replace(
    /from\s+(["'])\.\.\/src\/utils\/symbol-observable\1/g,
    (_match, quote) =>
      `from ${quote}${moduleSpecifier(dirname(generatedPath), emittedSupportPath("src/utils/symbol-observable.ts"))}${quote}`,
  );

  return source;
}

export async function runHarness({ quiet = false } = {}) {
  const log = quiet ? () => {} : (...values) => console.log(...values);
  const packageSetup = setupNpmCompatCatalogPackage("redux");
  const suite = setupReduxUpstreamSuite();
  const runs = [];

  emitSupportFiles(suite.root);
  log(`[dogfood] redux@${packageSetup.version} upstream ${suite.pin.tag} (${suite.pin.commit.slice(0, 12)})`);
  for (const filePath of suite.selectedPaths) {
    const file = suite.relativePath(filePath);
    const generatedPath = join(GENERATED_ROOT, file);
    const transformed = transformReduxTest(
      readFileSync(filePath, "utf-8"),
      generatedPath,
      packageSetup.entryModulePath,
    );
    const source = `${UPSTREAM_TEST_SHIM}\n${RXJS_TEST_SHIM}\n${transformed}\n${UPSTREAM_TEST_EXPORTS}`;
    const result = await compileAndRunUpstreamModule({ generatedPath, source, timeoutMs: 240_000 });
    runs.push({ file, result });
    log(
      `[dogfood] ${file}: ${result.native.statuses.filter(Boolean).length}/${result.native.count} native; ` +
        `${result.wasm?.statuses.filter(Boolean).length ?? 0}/${result.native.count} Wasm`,
    );
  }

  const report = summarizeUpstreamRuns({
    name: `redux@${packageSetup.version}`,
    pin: suite.pin,
    testFiles: suite.testFiles,
    selectedFiles: suite.pin.selectedFiles,
    runs,
  });
  writeUpstreamReport(REPORT_PATH, report);
  log(`[dogfood] ${report.summary.headline}`);
  log(`[dogfood] report → ${REPORT_PATH}`);
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) cliUpstreamHarness(runHarness);
