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
  },
};

for (const packageEntry of ["index.js", "runtime.js"]) {
  if (!fs.existsSync(resolve(DIST, packageEntry))) {
    throw new Error(`Missing dist/${packageEntry}; build the package library before the Test262 CLI`);
  }
}

fs.mkdirSync(DIST, { recursive: true });

await Promise.all([
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
    legalComments: "none",
    logLevel: "info",
  }),
]);

fs.chmodSync(resolve(DIST, "test262-fyi-cli.js"), 0o755);
console.log(`Test262 CLI written to ${relative(ROOT, resolve(DIST, "test262-fyi-cli.js"))}`);
console.log(`Test262 worker written to ${relative(ROOT, resolve(DIST, "test262-worker.js"))}`);
