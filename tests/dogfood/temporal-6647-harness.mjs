// #6647 — a top-level function DECLARATION that returns a freshly built object
// answers `null` at its call site when `eval` is reachable and the standalone
// Temporal provider is linked.
//
// With `eval` in the module the declaration gets a LIVE GLOBAL BINDING, so
// `compileIdentifierCall` stops emitting a direct `call` and routes the call
// through the generic dynamic dispatcher. That dispatcher can only produce an
// `externref`, and the function-value wrapper minted by
// `ensureFuncClosureSingleton` kept the callee's CONCRETE struct result type —
// so there was no arm it could match and the call answered `null`.
//
// Child process, same rationale as `temporal-s2-smoke-harness.mjs`: the ~3.3 MB
// provider compile OOMs / heartbeat-stalls a vitest worker in-process.
//
// Every probe records what it OBSERVED; the wrapper asserts. `ctrl*` probes are
// CONTROLS — they pass both before and after the fix, so a green run of the
// defect probes alone cannot be mistaken for the harness not running.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { instantiateLinkedProject } from "../../src/index.ts";
import { buildTemporalProvider, compileWithTemporalGlobal } from "../../src/temporal-provider.ts";
import { setupTemporalPolyfill, linkPolyfillSource } from "./setup-temporal-polyfill.mjs";

// `eval` anywhere in the module is what arms the live-global-binding lowering.
const EVAL = `function ev(s) { return eval(s); }\n`;
const KIND = `function kind(v) { return v === null ? 0 : (typeof v === "object" ? 1 : 2); }\n`;

const PROBES = {
  // (1) object literal, called by bare name — `0` (null) before the fix.
  objectLiteral: `${EVAL}${KIND}function g() { return { a: 1 }; }
    export function run() { return kind(g()); }`,
  // (2) the property read through that call — `-1` before the fix.
  objectProperty: `${EVAL}function g() { return { a: 7 }; }
    export function run() { var v = g(); return v === null ? -1 : v.a; }`,
  // (3) array literal, same shape.
  arrayLiteral: `${EVAL}${KIND}function g() { return [1, 2]; }
    export function run() { return kind(g()); }`,
  // (4) an object built statement-by-statement, not by a literal.
  builtObject: `${EVAL}${KIND}function g() { var o = {}; o.a = 1; return o; }
    export function run() { return kind(g()); }`,
  // (5) a top-level declaration called from INSIDE another function — the live
  //     global binding, not the call site's scope, is what decides.
  calledFromNested: `${EVAL}${KIND}function g() { return { a: 1 }; }
    function outer() { return g(); }
    export function run() { return kind(outer()); }`,
  // CONTROL (a) — identical source with NO `eval`: correct on both sides.
  ctrlNoEval: `${KIND}function g() { return { a: 1 }; }
    export function run() { return kind(g()); }`,
  // CONTROL (b) — `.apply` reaches the callee through a different dispatcher
  //               and was already correct.
  ctrlApply: `${EVAL}${KIND}function g() { return { a: 1 }; }
    export function run() { return kind(g.apply(undefined, [])); }`,
  // CONTROL (c) — a primitive result was never affected.
  ctrlStringResult: `${EVAL}function g() { return "s"; }
    export function run() { return g() === "s" ? 1 : 0; }`,
  // CONTROL (d) — the provider is genuinely linked and live.
  ctrlTemporal: `${EVAL}export function run() { return new Temporal.PlainDate(2024, 1, 1).day; }`,
};

const STANDALONE = { target: "standalone", hostBridge: "off" };

async function observe(source, provider, fileName) {
  try {
    const result = await compileWithTemporalGlobal(source, provider, {
      ...STANDALONE,
      fileName,
      allowJs: true,
      skipSemanticDiagnostics: true,
    });
    if (!result.success) {
      return { status: "compile-error", error: (result.errors ?? [])[0]?.message?.slice(0, 200) ?? "?" };
    }
    // A probe that names `eval` imports the runtime-eval seam. The defect is in
    // the CALL lowering, not in eval itself, so a refusing stub is enough — no
    // probe here ever evaluates a string.
    const module = new WebAssembly.Module(result.binary);
    const imports = {};
    for (const entry of WebAssembly.Module.imports(module)) {
      if (!entry.module.startsWith("js2wasm:runtime-eval")) continue;
      (imports[entry.module] ??= {})[entry.name] = () => null;
    }
    const { instance } = await instantiateLinkedProject(result, Object.keys(imports).length ? imports : {});
    return { status: "ok", value: instance.exports.run() };
  } catch (error) {
    return { status: "throw", error: String(error?.message ?? error).slice(0, 200) };
  }
}

export async function runTemporal6647Harness({ quiet = false } = {}) {
  const log = quiet ? () => {} : (...a) => console.log(...a);
  const linked = linkPolyfillSource(setupTemporalPolyfill());
  const cacheDir = process.env.JS2WASM_TEMPORAL_S2_CACHE ?? mkdtempSync(join(tmpdir(), "js2wasm-temporal-6647-"));
  const provider = await buildTemporalProvider({
    polyfillSource: linked.source,
    cacheDir,
    compileOptions: STANDALONE,
  });
  const report = {
    issue: 6647,
    provider: {
      namespace: provider.namespace,
      binaryBytes: provider.artifact.binary.length,
      cacheHit: provider.cacheHit,
    },
    probes: {},
  };
  for (const [label, source] of Object.entries(PROBES)) {
    report.probes[label] = await observe(source, provider, `/${label}.js`);
    log(`[temporal-6647] ${label}: ${JSON.stringify(report.probes[label])}`);
  }
  return report;
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const json = process.argv.includes("--json");
  const report = await runTemporal6647Harness({ quiet: json });
  if (json) process.stdout.write(`${JSON.stringify(report)}\n`);
}
