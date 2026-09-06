// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4162 — THE single place a test262 execution lane turns a compiled binary
 * plus a base import object into a live `WebAssembly.Instance`.
 *
 * There are three lanes that execute a compiled test262 module:
 *
 *   1. `scripts/test262-worker.mjs`      — the sharded CI fork worker
 *   2. `tests/test262-shared.ts`         — the in-process fixture-graph lane
 *   3. `tests/test262-runner.ts`         — `runTest262File`, used in-process by
 *      `scripts/validate-test262-baseline.ts`, `scripts/detect-vacuity.ts`,
 *      `scripts/harness-flip-probe.ts` and ad-hoc A/B measurement
 *
 * They must agree about WHICH import namespaces a given binary gets, because a
 * namespace supplied to one lane and not another does not merely lose tests —
 * **it overwrites their real error signature with an instantiation artifact.**
 * A descriptor test that would report `Test262Error: Expected obj[0] to be
 * writable` instead reports
 *
 *     TypeError: WebAssembly.instantiate(): Import #0 module="js2wasm:runtime-eval":
 *                module is not an object or function
 *
 * so every bucket histogram, cluster analysis and A/B built on the divergent
 * lane is measuring the instrument's own gap and attributing it to the
 * compiler. Measured 2026-08-06 across three independent ES5-standalone levers:
 * 82/162, 44/152, and a third hit that was not counted — roughly half of two
 * levers was instrument artifact, which is how a real mechanism gets sized at
 * +0 and abandoned. On the 162-file lever, 18 of the 82 masked files were
 * actually PASSING.
 *
 * It also corrupted `scripts/validate-test262-baseline.ts` (#2095), which the
 * #1897 standalone floor rests on: on clean main a 50-row standalone sample
 * carried two baseline-`pass` rows scored `fail` purely on this link error.
 *
 * This is the THIRD instance of one drift class. #3441 unified the sandbox
 * globals (`scripts/test262-sandbox-globals.mjs`) after the drift stranded
 * ~2,069 TypedArray-ctor tests; #3613 unified the thrown-payload renderer
 * (`scripts/lib/wasm-exn-render.mjs`) after the local lane reported an opaque
 * label where CI reported the real assertion text. Both were first diagnosed
 * as one-offs. The pattern is that `test262-worker.mjs` accretes fidelity fixes
 * and the in-process lanes do not.
 *
 * THE RULE, so there is not a fourth: a test262 lane does not call
 * `WebAssembly.instantiate` on a test binary itself. It calls
 * `instantiateTest262Module`. Any import namespace whose supply is CONDITIONAL
 * on the compiled module's own import list belongs in `attachConditionalImportNamespaces`
 * below and nowhere else. `tests/issue-4162.test.ts` fails the build if a lane
 * grows its own instantiate again.
 */

import {
  RUNTIME_EVAL_IMPORT_MODULE,
  instantiateRuntimeEvalNamespace,
  selectCachedRuntimeEvalProvider,
} from "./runtime-eval-provider.mjs";

export { RUNTIME_EVAL_IMPORT_MODULE };

// ── Runtime-eval provider (#2928 E6/E7) ────────────────────────────────
// One selection per process, memoised: `selectCachedRuntimeEvalProvider()`
// reads the cache and (for the interpreter tier) reassembles the provider
// source, which is not free. The MODULE is shared; the INSTANCE is not — see
// `attachConditionalImportNamespaces`.
let providerModule; // undefined = untried, null = unavailable
let providerAnnounced = false;

/**
 * Resolve (once) the runtime-eval provider module for this process, announcing
 * WHICH tier was selected on stderr the first time it is consulted.
 *
 * The announcement is load-bearing provenance, not chatter (#2928 E7): a
 * harness that silently selects a capability invalidates every cross-lane
 * comparison made against it. It is emitted lazily — only when a binary
 * actually links the namespace — so host-lane runs stay quiet.
 *
 * @param {string} label lane name for the announcement prefix
 * @returns {WebAssembly.Module | null}
 */
export function getTest262RuntimeEvalProviderModule(label = "test262") {
  if (providerModule !== undefined) return providerModule;
  const selection = selectCachedRuntimeEvalProvider();
  if (!providerAnnounced) {
    providerAnnounced = true;
    console.error(`[${label}] runtime-eval tier: ${selection.message}`);
  }
  // (#4238) The quickjs ENGINE supplies a 2-module bundle descriptor instead of
  // a single `WebAssembly.Module`; `instantiateRuntimeEvalNamespace`
  // discriminates on it. `selection.bundle` is absent for every other tier, so
  // the interpreter/refusal/none paths are unchanged.
  providerModule = selection.module ?? selection.bundle ?? null;
  return providerModule;
}

/** Test seam: forget the memoised provider selection. */
export function resetTest262RuntimeEvalProviderForTest() {
  providerModule = undefined;
  providerAnnounced = false;
}

/**
 * Attach every import namespace whose supply is conditional on what the
 * compiled module actually imports. Mutates and returns `importObj`.
 *
 * Today that is exactly one namespace, `js2wasm:runtime-eval`. It is emitted
 * only under `--target standalone` (see `ctx.standalone` in
 * `src/codegen/expressions/eval-inline.ts`), it is a MODULE-LEVEL import, and
 * its trigger is broad rather than exotic: `assembleOriginalHarness` injects a
 * `$262.evalScript` shim containing a direct `eval` into EVERY assembled test,
 * which trips `sourceUsesRuntimeEvalBoundary`. (It is NOT, as #4162 first
 * recorded, `propertyHelper.js`'s `Function.prototype.call.bind(...)` —
 * `isGlobalFunctionValueReference` excludes a property-access parent and that
 * construct compiles to zero imports. Only a first-class read of the `Function`
 * or `eval` VALUE, or a dynamic call of either, carries the import.)
 *
 * Each test gets a FRESH provider instance: the interpreter roots dynamic
 * functions at global env records, so a shared instance would leak state
 * between tests.
 *
 * @param {WebAssembly.Module} wasmModule the compiled test module
 * @param {Record<string, unknown>} importObj base imports from `buildImports`
 * @param {{ providerLabel?: string }} [options]
 * @returns {Record<string, unknown>} the same `importObj`
 */
export function attachConditionalImportNamespaces(wasmModule, importObj, options = {}) {
  const needsRuntimeEval = WebAssembly.Module.imports(wasmModule).some(
    (entry) => entry.module === RUNTIME_EVAL_IMPORT_MODULE,
  );
  if (needsRuntimeEval) {
    const provider = getTest262RuntimeEvalProviderModule(options.providerLabel);
    // A cache miss degrades to the status quo ante — the import stays
    // unresolved and instantiation fails exactly as it did before this wiring.
    // Never compile the provider here: the real one takes minutes and the fork
    // pool kills jobs at 30s.
    if (provider) importObj[RUNTIME_EVAL_IMPORT_MODULE] = instantiateRuntimeEvalNamespace(provider);
  }
  return importObj;
}

/**
 * The names of the import namespaces `importObj` would supply for `binary`.
 * Exists so the lane-parity guard can compare two lanes on one binary without
 * executing anything.
 *
 * @returns {string[]} sorted namespace names
 */
export function test262ImportNamespaceNames(binary, importObj, options = {}) {
  const wasmModule = new WebAssembly.Module(binary);
  attachConditionalImportNamespaces(wasmModule, importObj, options);
  return Object.keys(importObj)
    .filter((key) => typeof importObj[key] === "object" && importObj[key] !== null)
    .sort();
}

/**
 * Instantiate a compiled test262 module with the namespaces it needs.
 *
 * Standalone goes MODULE-FIRST so the import list is inspectable before
 * instantiation. The host lane keeps the binary-form async instantiate it has
 * always used — `new WebAssembly.Module()` compiles synchronously on the
 * calling thread, and the host lane never carries a conditional namespace, so
 * there is nothing to inspect and no reason to pay for it. A synchronous
 * `CompileError` from the module-first path rejects this promise and lands in
 * the caller's existing catch arm as the same error class the binary form
 * raised, so lane error classification is unchanged.
 *
 * Returns the `Instance` in both cases — normalising away the footgun that
 * `WebAssembly.instantiate` resolves to an `Instance` for a `Module` argument
 * but to `{ module, instance }` for a `BufferSource`.
 *
 * @param {BufferSource} binary
 * @param {Record<string, unknown>} importObj
 * @param {{ target?: string, providerLabel?: string, linkedModules?: readonly unknown[],
 *          linkedRuntime?: { instantiateLinkedProviders: Function, wireCompiledInstance: Function } }} [options]
 * @returns {Promise<WebAssembly.Instance>}
 */
import { resetTemporalRealmGlobals } from "./test262-temporal.mjs";

let announcedMissingLinkedProjectReset = false;

/**
 * (#5364) A runtime bundle built before the reset existed keeps today's
 * cross-row contamination rather than failing. Say so ONCE per process — a
 * silent degrade here is what makes a whole shard's Temporal `instanceof`
 * verdicts order-dependent.
 */
function announceMissingLinkedProjectReset() {
  if (announcedMissingLinkedProjectReset) return;
  announcedMissingLinkedProjectReset = true;
  console.error(
    "[test262] linked runtime has no resetLinkedProjectRegistry — cross-row decoder contamination is NOT suppressed " +
      "(rebuild scripts/runtime-bundle.mjs from scripts/runtime-bundle-entry.ts)",
  );
}

export async function instantiateTest262Module(binary, importObj, options = {}) {
  // (#5248) A test compiled against a LINKED provider — today only the
  // compile-once `Temporal` polyfill (#4628) — needs its provider modules
  // instantiated INTO `importObj` before the test binary is, and the consumer
  // registered in the cross-module decoder registry after. That lifecycle lives
  // in `src/linked-provider-runtime.ts` and is exactly what
  // `instantiateLinkedProject` does; doing it here rather than in a lane keeps
  // the #4162 rule intact (one place turns a binary into an instance).
  //
  // The import is DYNAMIC and reached only when a lane actually supplies
  // `linkedModules`: `scripts/test262-worker.mjs` runs against the prebuilt
  // `compiler-bundle.mjs` with no TypeScript loader, so a static `src/` import
  // here would break the sharded lane on load.
  //
  // (#5353) WHICH COPY of the linked-provider runtime does the wiring is a
  // correctness question, not a packaging one, so the caller may supply it.
  // `registerLinkedProviderModule` / `registerLinkedConsumerModule` write into
  // `src/runtime.ts`'s MODULE-LEVEL #5225 decoder registry, and the reads that
  // consult it happen inside the import object the lane built. The sharded
  // worker builds its imports from `scripts/runtime-bundle.mjs` while its
  // compiler lives in a second bundled copy of the runtime, so it passes its
  // own copy's helpers here; registering in the other copy leaves the reader's
  // registry empty, which does not throw — it silently answers a cross-module
  // struct field with the reader's `ref.test`-miss default (0). The in-process
  // lanes pass nothing and get the `src/` graph they already compile against.
  const linkedModules = options.linkedModules ?? [];
  if (linkedModules.length > 0) {
    const { instantiateLinkedProviders, wireCompiledInstance, resetLinkedProjectRegistry } =
      options.linkedRuntime ?? (await import("../src/linked-provider-runtime.js"));
    // (#5364) Retire the PREVIOUS row's linked project before this one
    // registers. Both test262 drivers run many rows in one process — the
    // sharded worker recycles a fork only on FATAL — and since #5353 every
    // Temporal row re-instantiates the same provider binary. Two instances of
    // one binary share canonical WasmGC types, so without this the #5225
    // registry answers a struct THIS row minted with a previous row's exports
    // and #5354's class-object lookup returns the previous row's singleton:
    // `x instanceof C` false while `x.constructor.name` reads right. Doing it
    // here rather than at each driver keeps the #4162 rule (one place turns a
    // binary into an instance) and guarantees the reset lands in the same
    // runtime copy as the registration above.
    if (typeof resetLinkedProjectRegistry === "function") resetLinkedProjectRegistry();
    else announceMissingLinkedProjectReset();
    // (#5364) The registry is only HALF of what a finished project leaves
    // behind. The compiled Temporal polyfill also claims two realm globals for
    // its internal-slot store, first-writer-wins, so every row after the first
    // reads its objects through row 1's provider instance no matter how clean
    // the decoder registry is — measured: the registry reset ALONE moved the
    // 123-row `: instanceof` count by 0. Retiring both is what makes a batched
    // row score the same as a solo one. `resetTemporalRealmGlobals` is a no-op
    // when no polyfill has run.
    resetTemporalRealmGlobals();
    const wasmModule = new WebAssembly.Module(binary);
    attachConditionalImportNamespaces(wasmModule, importObj, options);
    instantiateLinkedProviders(linkedModules, importObj);
    const instance = await WebAssembly.instantiate(wasmModule, importObj);
    wireCompiledInstance(importObj, instance, true);
    return instance;
  }
  if (options.target !== "standalone") {
    const { instance } = await WebAssembly.instantiate(binary, importObj);
    return instance;
  }
  const wasmModule = new WebAssembly.Module(binary);
  attachConditionalImportNamespaces(wasmModule, importObj, options);
  return await WebAssembly.instantiate(wasmModule, importObj);
}
