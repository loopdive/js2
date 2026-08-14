// One selectable entry point for source acquisition, js2wasm compilation,
// and original upstream unit-suite execution for npm-compat packages.

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import {
  NPM_COMPAT_UPSTREAM_NAMES,
  npmCompatUpstreamSource,
  setupNpmCompatUpstreamSource,
} from "./npm-compat-upstream-sources.mjs";

function parseCli(argv) {
  const names = [];
  let force = false;
  let sourceOnly = false;
  let skipCompile = false;
  let allowPending = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--all") names.push(...NPM_COMPAT_UPSTREAM_NAMES);
    else if (arg === "--force") force = true;
    else if (arg === "--source-only") sourceOnly = true;
    else if (arg === "--skip-compile") skipCompile = true;
    else if (arg === "--allow-pending") allowPending = true;
    else if (arg === "--package") names.push(argv[++index]);
    else if (arg.startsWith("--package=")) names.push(arg.slice("--package=".length));
    else throw new Error(`[dogfood] unknown argument ${arg}`);
  }
  if (names.length === 0) throw new Error("[dogfood] pass --package <name> or --all");
  return { names: [...new Set(names)], force, sourceOnly, skipCompile, allowPending };
}

function runScript(script) {
  const result = spawnSync("pnpm", ["run", script], { stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`[dogfood] ${script} exited ${result.status}`);
}

export function runPackage(name, options) {
  const pin = npmCompatUpstreamSource(name);
  const source = setupNpmCompatUpstreamSource(name, options);
  console.log(
    `[dogfood] ${name}@${pin.version}: verified GitHub ${pin.tag} at ${pin.commit.slice(0, 12)}; ` +
      `${source.testFiles?.length ?? "existing pinned"} unit files`,
  );
  if (options.sourceOnly) return { name, status: "source-verified" };

  if (!options.skipCompile) runScript(pin.compileScript);
  if (!pin.suiteScript) {
    const message = `[dogfood] ${name}@${pin.version}: original unit-suite adapter is not implemented`;
    if (!options.allowPending) throw new Error(message);
    console.warn(message);
    return { name, status: "adapter-pending" };
  }
  runScript(pin.suiteScript);
  return { name, status: "suite-ran" };
}

async function main() {
  const options = parseCli(process.argv.slice(2));
  const results = [];
  for (const name of options.names) results.push(runPackage(name, options));
  const ran = results.filter((result) => result.status === "suite-ran").length;
  const pending = results.filter((result) => result.status === "adapter-pending").length;
  console.log(`[dogfood] npm-compat upstream: ${ran} suites ran, ${pending} adapters pending`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
