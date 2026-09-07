#!/usr/bin/env node
// (#5337) Run the playground's compiled-acorn load sequence on JavaScriptCore.
//
// iOS Safari's engine deviates from V8 in two identity guarantees the host
// bridge authenticates with (see src/runtime/exported-function-identity.ts),
// and a test that only runs under V8 cannot see either. This bundles the
// runtime for a bare JS shell and runs the AST panel's exact steps under `jsc`
// (WebKitGTK: `apt-get install libjavascriptcoregtk-bin`; macOS: the shell in
// JavaScriptCore.framework). Skips cleanly, exit 0, when no `jsc` is found.
//
//   node scripts/jsc-acorn-smoke.mjs            # PASS / FAIL / SKIP
//   JSC=/path/to/jsc node scripts/jsc-acorn-smoke.mjs
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const jsc = process.env.JSC ?? whichJsc();
if (!jsc) {
  console.log("jsc-acorn-smoke: SKIP — no `jsc` shell on PATH (set JSC=/path/to/jsc)");
  process.exit(0);
}

const outDir = path.join(root, ".tmp", "jsc-smoke");
mkdirSync(outDir, { recursive: true });
const entry = path.join(outDir, "entry.js");
const bundle = path.join(outDir, "runtime-bundle.js");
const driver = path.join(outDir, "driver.js");

writeFileSync(
  entry,
  `import { buildCompiledAdapterImports, instantiateWasm, wrapExports } from "../../src/runtime.ts";
globalThis.__js2 = { buildCompiledAdapterImports, instantiateWasm, wrapExports };
`,
);
const stubs = path.join(root, "website/playground/stubs");
const alias = [];
for (const [mod, file] of [
  ["path", "path-shim.js"],
  ["fs", "node-fs-stub.js"],
  ["module", "node-module-stub.js"],
  ["child_process", "node-stub.js"],
  ["os", "node-stub.js"],
  ["crypto", "node-stub.js"],
  ["url", "node-stub.js"],
  ["worker_threads", "node-stub.js"],
]) {
  alias.push(`--alias:node:${mod}=${path.join(stubs, file)}`, `--alias:${mod}=${path.join(stubs, file)}`);
}
execFileSync(
  "npx",
  [
    "esbuild",
    entry,
    "--bundle",
    "--format=iife",
    "--platform=browser",
    "--target=es2022",
    `--outfile=${bundle}`,
    ...alias,
  ],
  { cwd: root, stdio: ["ignore", "ignore", "inherit"] },
);

const acornDir = path.join(root, "website/public/acorn");
writeFileSync(
  driver,
  `// jsc has no TextEncoder/TextDecoder, process, or console; ASCII-only shims suffice for this smoke.
globalThis.process = { env: {}, argv: [], platform: "browser", version: "" };
globalThis.window = globalThis; globalThis.self = globalThis;
globalThis.console = { log: print, warn: print, error: print, debug: print, info: print };
globalThis.performance = { now: () => Date.now() };
globalThis.TextEncoder ??= class { encode(s) { return Uint8Array.from(s, (c) => c.charCodeAt(0) & 0x7f); } };
globalThis.TextDecoder ??= class { decode(b) { return String.fromCharCode(...new Uint8Array(b.buffer ?? b)); } };
load(${JSON.stringify(bundle)});
const { buildCompiledAdapterImports, instantiateWasm, wrapExports } = globalThis.__js2;
const bytes = readFile(${JSON.stringify(path.join(acornDir, "acorn.wasm"))}, "binary");
const manifest = JSON.parse(readFile(${JSON.stringify(path.join(acornDir, "acorn.manifest.json"))}));
(async () => {
  const imports = buildCompiledAdapterImports(manifest);
  const { instance, nativeBuiltins } = await instantiateWasm(bytes, imports.env, imports.string_constants, imports.string_constants16);
  imports.setInstance(instance);
  const ex = wrapExports(instance, { signatures: manifest.exportSignatures, boundaryPolicies: manifest.exportBoundaries });
  const canary = ex.parse("0", { ecmaVersion: 2022, sourceType: "module" });
  const value = canary.body[0].expression.value;
  const ast = ex.parse("export class C { #n = 0; inc(by = 1) { this.#n += by; return this.#n; } }\\nconst s = [1, 2].map((x) => x ** 2);", { ecmaVersion: 2022, sourceType: "module" });
  print("RESULT nativeBuiltins=" + nativeBuiltins + " canary=" + value + " body=" + ast.body.length);
})().catch((e) => print("RESULT THREW " + e));
`,
);

const run = spawnSync(jsc, [driver], { encoding: "utf8", timeout: 300_000 });
const out = (run.stdout ?? "") + (run.stderr ?? "");
const result = out.split("\n").find((line) => line.startsWith("RESULT"));
process.stdout.write(out);
if (run.status === 0 && result === "RESULT nativeBuiltins=false canary=0 body=2") {
  console.log("jsc-acorn-smoke: PASS");
} else {
  console.log(`jsc-acorn-smoke: FAIL (${result ?? `jsc exit ${run.status}`})`);
  process.exit(1);
}

function whichJsc() {
  for (const candidate of [
    "jsc",
    "/usr/bin/jsc",
    "/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc",
  ]) {
    if (candidate.includes("/") ? existsSync(candidate) : spawnSync("which", [candidate]).status === 0)
      return candidate;
  }
  return undefined;
}
