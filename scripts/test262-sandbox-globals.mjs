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
]);
