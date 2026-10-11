/**
 * Single source of truth for the test262 "original harness" sandbox globals.
 *
 * The oracle-v8 literal-harness sandbox is an `Object.create(null)` object that
 * is contextified via `vm.createContext`; each name below is pulled out of the
 * fresh realm with `runInContext(name, ctx)` and copied onto the sandbox so the
 * compiled body can resolve it through the `globalSandbox` bridge
 * (`__extern_get(globalThis, name)`). A name that is NOT on this list resolves
 * to undefined/null in the sandbox, so any harness `Object.getPrototypeOf(name)`
 * (or other `ToObject` coercion) throws `TypeError: Cannot convert null/undefined
 * to object` — during `__module_init`, before the test body runs.
 *
 * This list is imported by BOTH lanes that build such a sandbox:
 *   - `scripts/test262-worker.mjs` (sharded-CI / baseline lane)
 *   - `tests/test262-runner.ts`    (local vitest runner lane)
 *
 * They were previously two hand-maintained twins that drifted (#3227, #3428 B,
 * and #3419-vs-worker). The #3419 TypedArray cluster was added to the runner
 * list but never to the worker's, which stranded ~2,069 default-lane
 * TypedArray-constructor tests at `Cannot convert null to object [in
 * __module_init()]` (#3441). Extracting the one shared list makes drift
 * structurally impossible.
 *
 * NOTE: This module must stay a plain, side-effect-free `.mjs` — it is imported
 * by the forked worker (plain node, no TS loader) AND by the vitest runner. Do
 * NOT add top-level side effects here.
 */
export const SANDBOX_GLOBAL_NAMES = Object.freeze([
  "Array",
  "Object",
  "Function",
  "String",
  "Number",
  "Boolean",
  "Symbol",
  "Promise",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Date",
  "RegExp",
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "Math",
  "JSON",
  "Reflect",
  // (#3419) The TypedArray cluster + binary-data builtins. The oracle-v8
  // literal harness (testTypedArray.js:64) reads these as VALUES off globalThis
  // (`Object.getPrototypeOf(Int8Array)`, `[Int8Array, Uint8Array, …]`); without
  // them, `__extern_get(globalThis, "Int8Array")` returns undefined in the
  // sandbox and the whole TypedArray harness dies at
  // `Object.getPrototypeOf(undefined)` — ~2k tests. Same vm realm as the rest
  // of the sandbox, so intra-sandbox identities hold.
  "ArrayBuffer",
  "SharedArrayBuffer",
  "DataView",
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float16Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
  "BigInt",
  "EvalError",
  "URIError",
  "AggregateError",
  "Proxy",
  // (#3441) `Atomics` operates on SharedArrayBuffer views; the
  // `built-ins/Atomics/*` harness reads it the same way. It was on NEITHER twin
  // list, so those ~90 tests trapped identically at module init.
  "Atomics",
  // (#6492 round 16) The ES §19.2 global FUNCTIONS (+ the Annex B §B.2.1 pair).
  // They were on NEITHER list, so a compiled `globalThis.parseInt` read
  // answered `undefined` from the sandbox — silently, with no throw. That is
  // what broke the `$262.createRealm()` cluster: the realm shim
  // (`scripts/test262-fyi-runtime.js`) BUILDS the foreign realm's global by
  // copying these off `globalThis`, so `createRealm().global.parseInt` was
  // `undefined` while every hop of the chain ran correctly.
  "parseInt",
  "parseFloat",
  "isNaN",
  "isFinite",
  "decodeURI",
  "decodeURIComponent",
  "encodeURI",
  "encodeURIComponent",
  "escape",
  "unescape",
]);

/**
 * The subset above that §19.2 / §B.2.1 define as `{ [[Writable]]: true,
 * [[Enumerable]]: false, [[Configurable]]: true }` function-valued properties
 * of the global object.
 *
 * The copy loop in both sandbox builders assigns with `=`, which creates an
 * ENUMERABLE own property. For the constructors that predate this list that is
 * pre-existing behaviour; for the names added in #6492 round 16 it is a new
 * wrong answer, and the corpus checks it directly — `S15.1.2.2_A9.5` &c. assert
 * `this.propertyIsEnumerable('parseInt') === false`. Measured: those six rows
 * flipped pass→fail in BOTH lanes on the enumerable spelling (they had been
 * passing only because the property was absent altogether).
 *
 * The constructors are deliberately NOT re-attributed here: same latent defect,
 * but their current attributes are baked into the committed baseline, so that
 * is its own measured change.
 */
export const SANDBOX_NON_ENUMERABLE_GLOBAL_NAMES = Object.freeze([
  "parseInt",
  "parseFloat",
  "isNaN",
  "isFinite",
  "decodeURI",
  "decodeURIComponent",
  "encodeURI",
  "encodeURIComponent",
  "escape",
  "unescape",
]);

/**
 * Re-define the §19.2 function-valued globals a sandbox already carries with
 * their spec attributes. Call right after the `runInContext` copy loop; a name
 * the host realm lacks is skipped, never defined as `undefined`.
 *
 * Shared by both sandbox builders (`scripts/test262-worker.mjs`,
 * `tests/test262-runner.ts`) for the #3441 reason: two hand-kept twins drift.
 */
export function applySandboxGlobalFunctionAttributes(sandbox) {
  for (const name of SANDBOX_NON_ENUMERABLE_GLOBAL_NAMES) {
    const value = sandbox[name];
    if (value === undefined) continue;
    Object.defineProperty(sandbox, name, { value, writable: true, enumerable: false, configurable: true });
  }
}
