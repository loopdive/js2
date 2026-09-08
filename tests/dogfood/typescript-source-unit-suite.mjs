// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Original upstream unit callbacks against complete source modules, not projections.
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { setupTypescriptUpstreamSuite } from "./setup-typescript-upstream-suite.mjs";
import { TYPESCRIPT_STANDALONE_TEST_EXPORTS } from "./typescript-upstream-suite.mjs";
import {
  UPSTREAM_TEST_EXPORTS,
  UPSTREAM_TEST_SHIM,
  compileAndRunUpstreamModule,
  writeUpstreamReport,
} from "./upstream-suite-runner.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FILES = { factory: 3, diagnosticCollection: 5 };

export const SOURCE_UNIT_DIAGNOSTIC_EXPORTS = String.raw`
let __sourceUnitError = "";
export function runStandaloneUpstreamTest(index: number): number {
  __sourceUnitError = "";
  try { return runSourceUnitTestBody(index); }
  catch (error) {
    __sourceUnitError = String((error as Error).message || error);
    throw error;
  }
}
export function upstreamStandaloneErrorLength(): number { return __sourceUnitError.length; }
export function upstreamStandaloneErrorCodeUnit(index: number): number { return __sourceUnitError.charCodeAt(index); }
`;

export async function runSourceUnitFile(name) {
  if (!Object.hasOwn(FILES, name)) throw new Error(`Unsupported source unit file: ${name}`);
  const suite = setupTypescriptUpstreamSuite();
  const originalPath = join(suite.root, "src/testRunner/unittests", `${name}.ts`);
  const generatedPath = resolve(HERE, "../../.typescript-upstream-suite-generated/source-modules", `${name}.ts`);
  mkdirSync(dirname(generatedPath), { recursive: true });
  const namespace = relative(dirname(generatedPath), join(suite.root, "src/compiler/_namespaces/ts.js"));
  const original = readFileSync(originalPath, "utf8");
  const importPattern = /^import \* as ts from "\.\.\/_namespaces\/ts\.js";/m;
  if (!importPattern.test(original)) throw new Error("Upstream namespace import changed");
  // Both files use compiler APIs only. Redirect the harness-wide namespace to
  // its compiler re-export; all original declarations and assertions remain.
  const transformed = original.replace(importPattern, `import * as ts from ${JSON.stringify(`./${namespace}`)};`);
  const testBody = TYPESCRIPT_STANDALONE_TEST_EXPORTS.replace("runStandaloneUpstreamTest", "runSourceUnitTestBody");
  const source = `${UPSTREAM_TEST_SHIM}\nconst assert = __qunitAssert;\n${transformed}\n${UPSTREAM_TEST_EXPORTS}\n${testBody}\n${SOURCE_UNIT_DIAGNOSTIC_EXPORTS}`;
  // Upstream's cyclic namespace graph relies on bundled initialization and
  // const-enum folding. Use the same source for the native reference, bundled
  // independently; Wasm still compiles the original source module graph.
  const nativeBundle = await build({
    stdin: { contents: source, resolveDir: dirname(generatedPath), loader: "ts" },
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    banner: {
      js: 'import { createRequire } from "node:module"; import { fileURLToPath } from "node:url"; import { dirname } from "node:path"; const require = createRequire(import.meta.url); const __filename = fileURLToPath(import.meta.url); const __dirname = dirname(__filename);',
    },
  });
  const result = await compileAndRunUpstreamModule({
    generatedPath,
    source,
    nativeSource: nativeBundle.outputFiles[0].text,
    timeoutMs: 1_200_000,
    workerEnv: {
      DOGFOOD_TARGET: "standalone",
      DOGFOOD_CONSUMER_DRIVEN_BARRELS: "1",
      DOGFOOD_PLATFORM: undefined,
      DOGFOOD_NODE_HOST_DEPS: undefined,
      DOGFOOD_INSTALL_JSDOM: undefined,
    },
  });
  return { file: suite.relativePath(originalPath), pin: suite.pin.commit, expectedTests: FILES[name], ...result };
}

export function sourceUnitFileSucceeded(result) {
  const expected = FILES[result?.file?.split("/").pop()?.replace(/\.ts$/, "")];
  if (!expected || result.expectedTests !== expected) return false;
  const passes = (run) =>
    !run?.fatal &&
    run?.count === expected &&
    Array.isArray(run.statuses) &&
    run.statuses.length === expected &&
    run.statuses.every((status) => status === true);
  const compilation = result.compile;
  return (
    passes(result.native) &&
    passes(result.wasm) &&
    compilation?.success === true &&
    compilation.validates === true &&
    compilation.requestedTarget === "standalone" &&
    compilation.actualTarget === "standalone" &&
    compilation.targetMatches === true &&
    compilation.importPolicyMatches === true &&
    Array.isArray(compilation.moduleImports) &&
    compilation.moduleImports.length === 0 &&
    Array.isArray(compilation.linkedModuleImports) &&
    compilation.linkedModuleImports.every((module) => Array.isArray(module.imports) && module.imports.length === 0)
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  // Guest callbacks must not turn an unfinished run into an implicit exit 0.
  process.exitCode = 1;
  const name = process.argv[2] ?? "factory";
  const result = await runSourceUnitFile(name);
  writeUpstreamReport(join(HERE, "report", `typescript-source-unit-${name}.json`), result);
  console.log(JSON.stringify(result));
  process.exitCode = sourceUnitFileSucceeded(result) ? 0 : 1;
}
