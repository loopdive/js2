// ESLint npm-compat workload (#1400 follow-up).
//
// The package-entry harness measures whether lib/api.js compiles and validates.
// This companion harness adds one consumed Linter.verify workload without
// turning a valid Wasm module into a correctness claim. Both sides return the
// diagnostic count for the same source/configuration, and the native side is
// evaluated at run time from the verified installed ESLint package.

import { fileURLToPath, pathToFileURL } from "node:url";

import { createNpmWorkloadHarness, isCli, runWorkloadHarnessCli } from "./npm-workload-harness.mjs";
import { setupEslint } from "./setup-eslint.mjs";

const REPOSITORY_ROOT = new URL("../..", import.meta.url);
const DRIVER_PATH = new URL(".tmp/eslint-dogfood-workload.mjs", REPOSITORY_ROOT);

// Keep the generated driver outside the extracted package. The bare `eslint`
// import therefore resolves through the repository's installed importer graph,
// while setup-eslint.mjs has already proved its bytes equal the pinned tarball.
const DRIVER_SOURCE = `
import { Linter } from "eslint";

export function runCase() {
  const linter = new Linter();
  const messages = linter.verify("var x = 1", { rules: { semi: ["error", "always"] } });
  return messages.length;
}
`;

const SOURCE = "var x = 1";
const CONFIG = { rules: { semi: ["error", "always"] } };

async function nativeOracle(setup) {
  // Use the same installed package path that setup-eslint validated, rather
  // than resolving a second copy from this harness's own module location.
  const eslint = await import(pathToFileURL(setup.entryModulePath).href);
  const linter = new eslint.Linter();
  return linter.verify(SOURCE, CONFIG).length;
}

export const runHarness = createNpmWorkloadHarness({
  name: "eslint",
  issue: 1400,
  reportName: "eslint-workload",
  setup: () => setupEslint(),
  driverPath: () => fileURLToPath(DRIVER_PATH),
  driverSource: DRIVER_SOURCE,
  oracle: nativeOracle,
  timeoutMs: Number(process.env.DOGFOOD_ESLINT_WORKLOAD_TIMEOUT_MS ?? 180_000),
});

if (isCli(import.meta.url, process.argv[1])) runWorkloadHarnessCli(runHarness);
