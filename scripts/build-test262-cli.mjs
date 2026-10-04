#!/usr/bin/env node

// Build the npm-distributed one-shot Test262 engine CLI and its isolated
// compiler worker. Both outputs live in dist/ so @loopdive/js2 consumers can
// install one package and invoke js2-test262 without a source checkout.
import fs from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = resolve(ROOT, "dist");

const workerAliasPlugin = {
  name: "test262-worker-package-imports",
  setup(buildApi) {
    buildApi.onResolve({ filter: /^\.\/(?:compiler|runtime)-bundle\.mjs$/ }, (args) => {
      const path = args.path === "./compiler-bundle.mjs" ? "./index.js" : "./runtime.js";
      return { path, external: true };
    });
    // #6794 — scripts/test262-import-object.mjs reaches the linked-provider
    // runtime through a DYNAMIC `import("../src/linked-provider-runtime.js")`
    // for the in-process lanes. esbuild bundles a literal dynamic import, and
    // that file imports src/runtime.ts, which pulls in the whole compiler: a
    // second 20 MB copy inside dist/test262-worker.js. The worker never takes
    // that branch (it passes its own `linkedRuntime`), so point it at the
    // packaged runtime entry instead of bundling it.
    buildApi.onResolve({ filter: /^\.\.\/src\/linked-provider-runtime\.js$/ }, () => ({
      path: "./runtime.js",
      external: true,
    }));
  },
};

// The worker must load the compiler from the package's own dist/index.js and
// dist/runtime.js, never carry a bundled copy of src/. Fail the build if any
// src/ module leaked into it.
function assertNoBundledCompiler(result, outfile) {
  const inputs = Object.keys(result.metafile.outputs[outfile]?.inputs ?? {});
  const leaked = inputs.filter((input) => input.startsWith("src/"));
  if (leaked.length > 0) {
    throw new Error(
      `${outfile} bundles ${leaked.length} compiler source module(s) (e.g. ${leaked.slice(0, 3).join(", ")}); ` +
        "import them from the packaged ./index.js or ./runtime.js instead",
    );
  }
}

for (const packageEntry of ["index.js", "runtime.js"]) {
  if (!fs.existsSync(resolve(DIST, packageEntry))) {
    throw new Error(`Missing dist/${packageEntry}; build the package library before the Test262 CLI`);
  }
}

fs.mkdirSync(DIST, { recursive: true });

const [, workerBuild] = await Promise.all([
  build({
    absWorkingDir: ROOT,
    entryPoints: ["scripts/test262-fyi-cli.mjs"],
    outfile: "dist/test262-fyi-cli.js",
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node25",
    packages: "external",
    legalComments: "none",
    logLevel: "info",
  }),
  build({
    absWorkingDir: ROOT,
    entryPoints: ["scripts/test262-worker.mjs"],
    outfile: "dist/test262-worker.js",
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node25",
    packages: "external",
    plugins: [workerAliasPlugin],
    metafile: true,
    legalComments: "none",
    logLevel: "info",
  }),
]);
assertNoBundledCompiler(workerBuild, "dist/test262-worker.js");

fs.chmodSync(resolve(DIST, "test262-fyi-cli.js"), 0o755);
console.log(`Test262 CLI written to ${relative(ROOT, resolve(DIST, "test262-fyi-cli.js"))}`);
console.log(`Test262 worker written to ${relative(ROOT, resolve(DIST, "test262-worker.js"))}`);
