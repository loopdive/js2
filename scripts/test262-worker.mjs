/**
 * Unified test262 worker — compiles AND executes a test in one process.
 * Uses child_process.fork for full memory isolation.
 *
 * Protocol:
 *   Parent sends: { id, source, execute, isNegative, isRuntimeNegative, target?, wasmPath?, metaPath? }
 *   Worker sends: { id, status, error?, ret?, compileMs?, execMs?, errorCodes?, ... }
 *
 * When execute=false: compile only, write to disk (for cache warming).
 * When execute=true: compile + instantiate + run test(), return full result.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { compile, createIncrementalCompiler } from "./compiler-bundle.mjs";
import { buildImports } from "./runtime-bundle.mjs";
import { poisonRecycleReason } from "./test262-poison-error.mjs";
import { negativeCompileErrorMatches, negativeCompileSucceededVerdict } from "./negative-verdict.mjs";

// ── Bundle hash (#1521) ────────────────────────────────────────────────
// Each cache entry written below carries a `bundle_hash` field. When the
// runner restores a stale cache (via the `test262-cache-v2-` loose
// restore-keys fallback), it can detect entries from a different compiler
// bundle and recompile them. Entries written from the *same* bundle as the
// current run can be reused immediately — even across PRs.
//
// Hash inputs (in priority order):
//   1. TEST262_BUNDLE_HASH env var (set by CI from `hashFiles(...)` digest)
//   2. sha256 of `scripts/compiler-bundle.mjs` (computed locally as fallback)
//
// Computed once per worker startup — cheap (a few MB read + sha256).
const _workerDir = dirname(fileURLToPath(import.meta.url));
function computeBundleHash() {
  const fromEnv = process.env.TEST262_BUNDLE_HASH;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  try {
    const buf = readFileSync(join(_workerDir, "compiler-bundle.mjs"));
    return createHash("sha256").update(buf).digest("hex").slice(0, 16);
  } catch {
    return "no-bundle";
  }
}
const BUNDLE_HASH = computeBundleHash();

let compileCount = 0;
const GC_INTERVAL = 25;
const RECREATE_INTERVAL = 100;
const WORKER_RECYCLE_INTERVAL = Math.max(0, parseInt(process.env.TEST262_WORKER_RECYCLE_INTERVAL || "0", 10) || 0);

let incrementalCompiler = null;
function createFreshCompiler() {
  try {
    incrementalCompiler = createIncrementalCompiler({
      fileName: "test.ts",
      sourceMap: true,
      sourceMapUrl: "test.wasm.map",
      emitWat: false,
      skipSemanticDiagnostics: true,
    });
  } catch (e) {
    incrementalCompiler = null;
  }
}
createFreshCompiler();

// Suppress unhandled Promise rejections from async tests
process.on("unhandledRejection", () => {});

// ── Prototype-poisoning sandbox ───────────────────────────────────────
// test262 tests routinely mutate built-in prototypes. Since compile and
// execute share the same process, residual poison breaks the TypeScript
// compiler + js2wasm codegen on subsequent compilations (#1153 / #1154).
//
// Concrete crashes observed in test262 CI before this sandbox grew:
//   - Array.prototype.reduce deleted → "constructSigs.reduce is not a function"
//   - WeakMap.prototype.set deleted → "cache.set is not a function"
//   - RegExp.prototype.exec deleted → "commentDirectiveRegEx.exec is not a
//     function" inside typescript.js (scanner)
//   - Array.prototype.from deleted → #1154 iteration/spread cluster
//
// Strategy: capture the ORIGINAL VALUE of each method we restore, then
// after every test re-assign it if it changed.  We do NOT use
// Object.defineProperty on builtin prototypes — that disturbs V8's
// internal shape/IC caches and causes many tests to fail (#1153 attempt 1).
// Simple value re-assignment is enough: the descriptor for a method that
// was replaced (e.g. `Array.prototype.reduce = () => {...}`) still has
// writable:true, so `=` restores the original function.
//
// For numeric-index accessors added to Array.prototype (configurable data
// or accessor properties), we delete.  For tests that add non-configurable
// poison, we exit for worker-pool restart — recovery is impossible.

// --- Category 1: numeric Array.prototype keys and Object.prototype keys
// (must be deleted, not re-assigned — they're properties not on the
// original descriptor set).
const _origArrayIterator = Array.prototype[Symbol.iterator];
// Capture the original descriptor so we can fully restore even when a test
// poisoned @@iterator via Object.defineProperty with `writable:false` (#1160).
// Plain `=` assignment silently fails on such a frozen descriptor — the
// descriptor itself must be re-applied via Object.defineProperty.
const _origArrayIteratorDesc = Object.getOwnPropertyDescriptor(Array.prototype, Symbol.iterator);
const _origArrayProtoNumericKeys = new Set(Object.getOwnPropertyNames(Array.prototype).filter((k) => /^\d+$/.test(k)));
const _origObjectProtoKeys = new Set(Object.getOwnPropertyNames(Object.prototype));
// Symbol-keyed properties that are originally present on Object.prototype and
// Array.prototype (normally none and just @@iterator/@@unscopables, respectively).
// Snapshot at module load so restoreBuiltins can detect and remove any added
// later by tests or by runtime misroutes (#1160 follow-up: a host-array index
// assignment with key 1-14 was hitting the well-known-symbol code path in
// runtime._safeSet, leaving Object.prototype[Symbol.iterator] = <number> for
// every subsequent compile to trip over).
const _origObjectProtoSymbols = new Set(Object.getOwnPropertySymbols(Object.prototype));
const _origArrayProtoSymbols = new Set(Object.getOwnPropertySymbols(Array.prototype));

// #1220 — extra-property cleanup for additional prototypes.
//
// test262 tests sometimes attach own properties to host prototypes via
// `Object.defineProperty(SomeProto, name, { get(){...} })` WITHOUT
// `configurable: true`. The descriptor defaults to non-configurable, which
// means the FIRST run in a fork installs the accessor and EVERY subsequent
// run that tries to defineProperty the same key fails with
// `TypeError: Cannot redefine property: <name>`.
//
// Concrete failures observed in the baseline:
//   - built-ins/Iterator/prototype/map/this-non-object.js installs
//     Number.prototype.next (the iter-helper falls back to receiver's
//     `next` via the prototype chain). Subsequent same-fork runs throw
//     "Cannot redefine property: next".
//   - built-ins/TypedArray/prototype/findLastIndex/get-length-ignores-length-prop.js
//     installs accessors on %TypedArray%.prototype.length AND on every
//     concrete TA.prototype.length (Int8Array..Float64Array). Same
//     "Cannot redefine property: length" on second run.
//
// The existing Object.prototype / Array.prototype "delete extras" loops
// (lines below) handle their respective protos. We replicate the same
// approach for additional prototypes that tests realistically poison.
//
// When `delete` succeeds (descriptor was configurable) the slate is clean
// for the next test. When `delete` fails because the descriptor is
// non-configurable, we deliberately do NOT exit-for-respawn here even
// though that's what the Array.prototype FATAL precedent does. Reason:
// ~51 TypedArray.prototype + ~30 Number.prototype tests in test262 install
// non-configurable accessors. Forcing fork respawn on each one cost +71
// compile_timeouts in CI (in-flight tests in the same fork lost their
// IPC response when the worker called process.exit(1) before libuv flushed
// the previous test's result message). Net effect was -7 pass.
//
// Trade-off accepted: the 3 tests we'd "fix" with the FATAL approach
// (Iterator/map/this-non-object.js, TypedArray/.../get-length-ignores-length-prop.js,
// + 1 sibling) stay broken on second-run-in-same-fork. Bug A's Promise
// snapshot still gives +26 cleanly. Recover the 3 tests later with a
// safer mechanism (e.g. process.disconnect() before exit, or per-test
// fork recycle for known-polluter test paths).
const _typedArrayProto = Object.getPrototypeOf(Int8Array.prototype); // %TypedArray%.prototype
const _iteratorProto = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));
const _PROTO_EXTRA_CLEANUP = [
  ["Number.prototype", Number.prototype],
  ["Boolean.prototype", Boolean.prototype],
  ["%TypedArray%.prototype", _typedArrayProto],
  ["Int8Array.prototype", Int8Array.prototype],
  ["Uint8Array.prototype", Uint8Array.prototype],
  ["Uint8ClampedArray.prototype", Uint8ClampedArray.prototype],
  ["Int16Array.prototype", Int16Array.prototype],
  ["Uint16Array.prototype", Uint16Array.prototype],
  ["Int32Array.prototype", Int32Array.prototype],
  ["Uint32Array.prototype", Uint32Array.prototype],
  ["Float32Array.prototype", Float32Array.prototype],
  ["Float64Array.prototype", Float64Array.prototype],
  ["%IteratorPrototype%", _iteratorProto],
  ["Map.prototype", Map.prototype],
  ["Set.prototype", Set.prototype],
  ["Date.prototype", Date.prototype],
  ["Promise.prototype", Promise.prototype],
  ["Error.prototype", Error.prototype],
];
const _protoExtraOrig = _PROTO_EXTRA_CLEANUP.map(([name, proto]) => ({
  name,
  proto,
  names: new Set(Object.getOwnPropertyNames(proto)),
  symbols: new Set(Object.getOwnPropertySymbols(proto)),
}));

// --- Category 2: specific methods the compiler + TypeScript use.
// Captured by VALUE at startup. Restored by simple assignment.
// When adding here: verify a test262 test that poisons the method actually
// triggered a compile_error before the entry was added.
const _METHOD_SNAPSHOTS = [
  // Array.prototype — higher-order methods are used all over codegen + TS
  [
    "Array.prototype",
    Array.prototype,
    [
      "reduce",
      "reduceRight",
      "map",
      "filter",
      "forEach",
      "find",
      "findIndex",
      "findLast",
      "findLastIndex",
      "some",
      "every",
      "indexOf",
      "lastIndexOf",
      "includes",
      "push",
      "pop",
      "shift",
      "unshift",
      "slice",
      "splice",
      "concat",
      "join",
      "reverse",
      "sort",
      "flat",
      "flatMap",
      "fill",
      "copyWithin",
      "at",
      Symbol.unscopables,
      "entries",
      "keys",
      "values",
      "toString",
      "toLocaleString",
    ],
  ],
  [
    "String.prototype",
    String.prototype,
    [
      "charAt",
      "charCodeAt",
      "codePointAt",
      "concat",
      "endsWith",
      "includes",
      "indexOf",
      "lastIndexOf",
      "match",
      "matchAll",
      "normalize",
      "padEnd",
      "padStart",
      "repeat",
      "replace",
      "replaceAll",
      "search",
      "slice",
      "split",
      "startsWith",
      "substring",
      "substr",
      "toLowerCase",
      "toUpperCase",
      "trim",
      "trimStart",
      "trimEnd",
      Symbol.iterator,
      "toString",
      "valueOf",
      "at",
    ],
  ],
  [
    "Number.prototype",
    Number.prototype,
    ["toString", "toFixed", "toPrecision", "toExponential", "valueOf", "toLocaleString"],
  ],
  ["Boolean.prototype", Boolean.prototype, ["toString", "valueOf"]],
  [
    "RegExp.prototype",
    RegExp.prototype,
    [
      "exec",
      "test",
      "toString",
      Symbol.match,
      Symbol.matchAll,
      Symbol.replace,
      Symbol.search,
      Symbol.split,
    ],
  ],
  [
    "Map.prototype",
    Map.prototype,
    ["get", "set", "has", "delete", "clear", "forEach", "entries", "keys", "values", Symbol.iterator],
  ],
  [
    "Set.prototype",
    Set.prototype,
    ["add", "has", "delete", "clear", "forEach", "entries", "keys", "values", Symbol.iterator],
  ],
  ["WeakMap.prototype", WeakMap.prototype, ["get", "set", "has", "delete"]],
  ["WeakSet.prototype", WeakSet.prototype, ["add", "has", "delete"]],
  ["%TypedArray%.prototype", _typedArrayProto, ["entries", "keys", "values", Symbol.iterator]],
  ["Error.prototype", Error.prototype, ["toString"]],
  ["Function.prototype", Function.prototype, ["call", "apply", "bind", "toString"]],
  [
    "Object.prototype",
    Object.prototype,
    ["hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable", "toString", "valueOf", "toLocaleString"],
  ],
  ["Promise.prototype", Promise.prototype, ["then", "catch", "finally"]],
  [
    "Date.prototype",
    Date.prototype,
    [
      "getTime",
      "getFullYear",
      "getMonth",
      "getDate",
      "getDay",
      "getHours",
      "getMinutes",
      "getSeconds",
      "getMilliseconds",
      "getTimezoneOffset",
      "toISOString",
      "toJSON",
      "toString",
      "valueOf",
      "toLocaleString",
    ],
  ],
];

// --- Category 3: static "namespace" methods (Array.from, Object.keys, etc.)
// These live on the CONSTRUCTOR, not the prototype, so they bypass the
// prototype-descriptor logic entirely.
const _STATIC_SNAPSHOTS = [
  ["Array", Array, ["from", "of", "isArray"]],
  [
    "Object",
    Object,
    [
      "keys",
      "values",
      "entries",
      "assign",
      "freeze",
      "isFrozen",
      "getOwnPropertyNames",
      "getOwnPropertyDescriptor",
      "getOwnPropertySymbols",
      "getPrototypeOf",
      "setPrototypeOf",
      "defineProperty",
      "defineProperties",
      "create",
      "is",
    ],
  ],
  ["String", String, ["fromCharCode", "fromCodePoint", "raw"]],
  ["Number", Number, ["isFinite", "isInteger", "isNaN", "isSafeInteger", "parseFloat", "parseInt"]],
  [
    "Math",
    Math,
    [
      "abs",
      "ceil",
      "floor",
      "round",
      "trunc",
      "sign",
      "min",
      "max",
      "pow",
      "sqrt",
      "log",
      "log2",
      "log10",
      "exp",
      "random",
      "sin",
      "cos",
      "tan",
      "asin",
      "acos",
      "atan",
      "atan2",
      "hypot",
      "fround",
      "imul",
      "clz32",
    ],
  ],
  ["JSON", JSON, ["parse", "stringify"]],
  [
    "Reflect",
    Reflect,
    [
      "get",
      "set",
      "has",
      "deleteProperty",
      "ownKeys",
      "getOwnPropertyDescriptor",
      "defineProperty",
      "getPrototypeOf",
      "setPrototypeOf",
      "construct",
      "apply",
    ],
  ],
  ["RegExp", RegExp, []],
  // #1220 — Tests under built-ins/Promise/{all,any,race,allSettled}/invoke-resolve*.js
  // intentionally replace `Promise.resolve` with custom callables (or non-callables
  // like `null` / `"string"`) to verify spec invocation semantics. Without snapshot+
  // restore, those mutations leak across tests in the same fork process and Node's
  // own `Promise.all` (which calls `this.resolve(value)` internally) crashes with
  // "TypeError: resolve is not a function" on every subsequent test that uses any
  // Promise static method. The runtime-side host imports in src/runtime.ts:2955-2965
  // close over the global `Promise` constructor, so the poisoned static methods are
  // also reached directly by compiled `Promise.resolve(x)` / `Promise.all(arr)`.
  // Symmetric with the existing Array/Object/String/etc. entries.
  ["Promise", Promise, ["resolve", "reject", "all", "allSettled", "any", "race"]],
];

// --- Category 4: accessor properties on RegExp.prototype (getters).
// When poisoned (e.g. `Object.defineProperty(RegExp.prototype, 'flags',
// { get() { return undefined } })` in test262's flags-undefined-throws.js),
// V8 internal helpers that call `.split(regex)`, `.matchAll(regex)` etc.
// propagate the poisoned getter into `new RegExp(r, r.flags + "y")` and
// throw "Invalid flags supplied to RegExp constructor 'undefinedy'" on any
// subsequent compile step (e.g. validation.ts splits source by /\r?\n/u).
// (#1157)
// Accessors MUST be restored via Object.defineProperty with the original
// descriptor — value-assignment hits the poisoned setter (or no-op).
const _ACCESSOR_SNAPSHOTS = [
  [
    "RegExp.prototype",
    RegExp.prototype,
    [
      "flags",
      "source",
      "global",
      "ignoreCase",
      "multiline",
      "sticky",
      "unicode",
      "unicodeSets",
      "dotAll",
      "hasIndices",
    ],
  ],
];

const _snapshotValue = (obj, key) => {
  try {
    return obj[key];
  } catch {
    return undefined;
  }
};
const _snapshotDescriptor = (obj, key) => {
  try {
    // Own descriptor first; fall back to walking the prototype chain so that
    // e.g. Array.from (which lives on the constructor) is still captured when
    // a test replaced it via Object.defineProperty earlier in the run.
    return Object.getOwnPropertyDescriptor(obj, key);
  } catch {
    return undefined;
  }
};
const _methodOrig = _METHOD_SNAPSHOTS.map(([name, obj, keys]) => ({
  name,
  obj,
  values: keys.map((k) => [k, _snapshotValue(obj, k), _snapshotDescriptor(obj, k)]),
}));
const _staticOrig = _STATIC_SNAPSHOTS.map(([name, obj, keys]) => ({
  name,
  obj,
  values: keys.map((k) => [k, _snapshotValue(obj, k), _snapshotDescriptor(obj, k)]),
}));
const _accessorOrig = _ACCESSOR_SNAPSHOTS.map(([name, obj, keys]) => ({
  name,
  obj,
  descriptors: keys
    .map((k) => [k, Object.getOwnPropertyDescriptor(obj, k)])
    .filter(([, d]) => d !== undefined && typeof d.get === "function"),
}));

// Same sentinel-style dirty check as the JS-host test262 runner (#1310),
// applied in the unified sharded worker so both js-host and standalone matrix
// targets recycle a fork after a test mutates core host prototypes.
const _RECYCLE_SENTINELS = [
  ["Array.prototype.push", Array.prototype, "push"],
  ["Array.prototype[Symbol.iterator]", Array.prototype, Symbol.iterator],
  ["Object.prototype.hasOwnProperty", Object.prototype, "hasOwnProperty"],
  ["Function.prototype.call", Function.prototype, "call"],
  ["String.prototype.slice", String.prototype, "slice"],
  ["Promise.prototype.then", Promise.prototype, "then"],
  ["Set.prototype.add", Set.prototype, "add"],
  ["Map.prototype.set", Map.prototype, "set"],
  ["WeakMap.prototype.set", WeakMap.prototype, "set"],
  ["WeakSet.prototype.add", WeakSet.prototype, "add"],
];
const _recycleSentinelOrig = _RECYCLE_SENTINELS.map(([label, obj, key]) => [label, obj, key, _snapshotValue(obj, key)]);

function detectRecycleSentinelMutation() {
  for (let i = 0; i < _recycleSentinelOrig.length; i++) {
    const [label, obj, key, orig] = _recycleSentinelOrig[i];
    let cur;
    try {
      cur = obj[key];
    } catch {
      return label;
    }
    if (cur !== orig) return label;
  }
  return undefined;
}

function recycleCleanup(reason) {
  return { recycle: true, reason };
}

function cleanCleanup() {
  return { recycle: false, reason: undefined };
}

// Restore a (prototype-or-constructor) method property. Value-assignment is
// the hot path — cheap and does not disturb V8 IC caches. When that silently
// fails (e.g. because a test poisoned the property via Object.defineProperty
// with writable:false / configurable:false), we retry with defineProperty
// using the captured original descriptor. This is required to recover from
// issue #1160: tests that replace Array.prototype[Symbol.iterator] with a
// non-callable value via defineProperty would otherwise persist across tests,
// making subsequent compiler internals like `Array.from(nodeArray)` throw
// `%Array%.from requires that the property of the first argument,
// items[Symbol.iterator], when exists, be a function`.
function _restoreMethodProp(obj, key, orig, origDesc) {
  if (orig === undefined) return;
  let cur;
  try {
    cur = obj[key];
  } catch {
    cur = undefined;
  }
  if (cur === orig) return;

  // Hot path: plain assignment. Succeeds when the descriptor is still
  // writable. Silently no-ops (or throws in strict mode) when the test
  // made it non-writable.
  try {
    obj[key] = orig;
  } catch {}

  // Re-check and fall back to defineProperty if the value is still wrong
  // AND we have the original descriptor to re-apply. Only reached on the
  // cold "test poisoned via defineProperty" path.
  try {
    if (obj[key] === orig) return;
  } catch {
    // accessor threw — try defineProperty anyway
  }
  if (origDesc) {
    try {
      Object.defineProperty(obj, key, origDesc);
    } catch {}
  }
}

function restoreBuiltins() {
  // Restore Array.prototype[Symbol.iterator].
  // Critical for the compiler's internal Array.from calls (on TypeScript
  // NodeArrays + other plain arrays). If left poisoned to a non-function
  // value, Array.from throws "%Array%.from requires that the property of
  // the first argument, items[Symbol.iterator], when exists, be a function"
  // — which surfaces as an L1:0 Codegen error during the next test's
  // compilation (#1160).
  if (Array.prototype[Symbol.iterator] !== _origArrayIterator) {
    try {
      Array.prototype[Symbol.iterator] = _origArrayIterator;
    } catch {}
    // If = silently failed (defineProperty-poisoned descriptor), re-apply
    // the original descriptor so the property is a function again.
    if (Array.prototype[Symbol.iterator] !== _origArrayIterator && _origArrayIteratorDesc) {
      try {
        Object.defineProperty(Array.prototype, Symbol.iterator, _origArrayIteratorDesc);
      } catch {}
    }
  }

  // If Symbol.iterator is STILL non-callable at this point, the descriptor
  // must be non-configurable. Every subsequent `for...of` in this function
  // would throw `T is not iterable` because it walks an array (the return
  // value of Object.getOwnPropertyNames) whose prototype we can't repair.
  // Bail out now so the caller restarts the fork rather than cascade-failing.
  {
    const cur = Array.prototype[Symbol.iterator];
    if (typeof cur !== "function") {
      const reason = `Array.prototype[Symbol.iterator] is non-configurable ${typeof cur} (#1160)`;
      console.error(`[unified-worker pid=${process.pid}] FATAL: ${reason} — recycling`);
      return recycleCleanup(reason);
    }
    // #1221: callability probe. The typeof check above only catches
    // non-callable poison. A test that assigns a Wasm-throwing function
    // (`Array.prototype[Symbol.iterator] = wasmInstance.exports.thrower`)
    // and made the descriptor non-configurable bypasses the typeof check
    // — but the very next `for...of` below (and every for-of in the TS
    // compiler's internals) would invoke it and throw a
    // WebAssembly.Exception. Without an exit here, that exception
    // propagates out of restoreBuiltins → out of doCompile → caught at
    // the outer try with status:"compile_error", error:"[object
    // WebAssembly.Exception]" — and EVERY subsequent test in this fork
    // hits the same trap (the blast radius can be ~100s of tests). Probe
    // by calling it on an empty array; if it throws, the fork is
    // unrecoverable — exit so the pool respawns.
    try {
      const probeIter = cur.call([]);
      // Some valid iterators are objects without .next yet — calling
      // .next() on the probe is the real correctness signal. Wrap so a
      // throw from .next() also trips the FATAL branch.
      if (probeIter && typeof probeIter.next === "function") probeIter.next();
    } catch (probeErr) {
      const kind = probeErr?.constructor?.name ?? typeof probeErr;
      const reason = `Array.prototype[Symbol.iterator] throws when called (${kind}) (#1221)`;
      console.error(`[unified-worker pid=${process.pid}] FATAL: ${reason} — recycling`);
      return recycleCleanup(reason);
    }
  }

  // Remove numeric-indexed accessor properties added to Array.prototype
  for (const key of Object.getOwnPropertyNames(Array.prototype)) {
    if (/^\d+$/.test(key) && !_origArrayProtoNumericKeys.has(key)) {
      try {
        delete Array.prototype[key];
      } catch {}
    }
  }

  // Remove properties added to Object.prototype
  for (const key of Object.getOwnPropertyNames(Object.prototype)) {
    if (!_origObjectProtoKeys.has(key)) {
      try {
        delete Object.prototype[key];
      } catch {}
    }
  }

  // Remove SYMBOL-keyed properties added to Object.prototype (#1160 follow-up).
  // The original Array.from regression was traced to host-array index assignments
  // (e.g. `srcArr[1] = undefined`) being mis-routed by runtime._safeSet onto the
  // well-known Symbol code path, which under accumulated fork state could leave
  // `Object.prototype[Symbol.iterator] = <number>`. Subsequent compiles would
  // then call Array.from({length: N}, ...) (in src/codegen/declarations.ts) and
  // V8 would throw "%Array%.from requires that the property of the first
  // argument, items[Symbol.iterator], when exists, be a function" because the
  // plain object's @@iterator inherited from Object.prototype was a non-callable
  // non-null value. The runtime is being fixed to gate the symbol-ID path on
  // _isWasmStruct(obj); this cleanup is defence-in-depth that also catches any
  // future poisoning we haven't anticipated.
  for (const sym of Object.getOwnPropertySymbols(Object.prototype)) {
    if (!_origObjectProtoSymbols.has(sym)) {
      try {
        delete Object.prototype[sym];
      } catch {}
    }
  }
  // Same defence on Array.prototype: tests that poison
  // `Array.prototype[Symbol.unscopables]` etc. otherwise persist across tests.
  for (const sym of Object.getOwnPropertySymbols(Array.prototype)) {
    if (!_origArrayProtoSymbols.has(sym) && sym !== Symbol.iterator) {
      try {
        delete Array.prototype[sym];
      } catch {}
    }
  }

  // #1220 — Delete extra own keys/symbols added to additional prototypes
  // (Number, %TypedArray%, %Iterator%, etc). See comment on _PROTO_EXTRA_CLEANUP.
  //
  // Tests routinely call Object.defineProperty(SomeProto, k, { get(){...} }).
  // When `configurable: true` is set the next test starts clean. When the
  // descriptor defaults to non-configurable, `delete` silently no-ops and
  // the next test's defineProperty throws "Cannot redefine property: <k>".
  // We accept that outcome (see the _PROTO_EXTRA_CLEANUP block comment for
  // the rationale against process.exit(1) recovery here).
  for (const { proto, names, symbols } of _protoExtraOrig) {
    for (const k of Object.getOwnPropertyNames(proto)) {
      if (!names.has(k)) {
        try {
          delete proto[k];
        } catch {}
      }
    }
    for (const s of Object.getOwnPropertySymbols(proto)) {
      if (!symbols.has(s)) {
        try {
          delete proto[s];
        } catch {}
      }
    }
  }

  // Restore specific methods on prototypes (value-assignment, defineProperty fallback).
  for (const { obj, values } of _methodOrig) {
    for (const [key, orig, origDesc] of values) {
      _restoreMethodProp(obj, key, orig, origDesc);
    }
  }

  // Validate restore — if any method is still not the original, the descriptor
  // is non-configurable and the fork is poisoned. Restart so the next test
  // gets a clean environment. (#1295)
  for (const { obj, values } of _methodOrig) {
    for (const [key, orig] of values) {
      if (obj[key] !== orig) {
        const reason = `prototype method ${String(key)} not restored (non-configurable poison) (#1295)`;
        console.error(`[unified-worker pid=${process.pid}] FATAL: ${reason} — recycling`);
        return recycleCleanup(reason);
      }
    }
  }

  // Restore static/namespace methods on constructors.
  for (const { obj, values } of _staticOrig) {
    for (const [key, orig, origDesc] of values) {
      _restoreMethodProp(obj, key, orig, origDesc);
    }
  }

  // Restore accessor properties (getters) via Object.defineProperty when
  // their backing get function differs from the snapshot. These are cold
  // paths (RegExp.prototype.flags etc.) so defineProperty is safe here —
  // it does not disturb V8's hot-path ICs the way Array.prototype accessors
  // would.
  for (const { obj, descriptors } of _accessorOrig) {
    for (const [key, orig] of descriptors) {
      const cur = Object.getOwnPropertyDescriptor(obj, key);
      if (!cur || cur.get !== orig.get || cur.set !== orig.set) {
        try {
          Object.defineProperty(obj, key, orig);
        } catch {}
      }
    }
  }

  // Detect non-configurable poison on Array.prototype — cannot be cleaned up.
  for (const key of Object.getOwnPropertyNames(Array.prototype)) {
    if (/^\d+$/.test(key)) {
      const desc = Object.getOwnPropertyDescriptor(Array.prototype, key);
      if (desc && !desc.configurable) {
        const reason = `non-configurable Array.prototype[${key}]`;
        console.error(`[unified-worker pid=${process.pid}] FATAL: ${reason} — recycling`);
        return recycleCleanup(reason);
      }
    }
  }

  // Non-configurable additions to Object.prototype also require restart.
  for (const key of Object.getOwnPropertyNames(Object.prototype)) {
    if (!_origObjectProtoKeys.has(key)) {
      const desc = Object.getOwnPropertyDescriptor(Object.prototype, key);
      if (desc && !desc.configurable) {
        const reason = `non-configurable Object.prototype[${key}]`;
        console.error(`[unified-worker pid=${process.pid}] FATAL: ${reason} — recycling`);
        return recycleCleanup(reason);
      }
    }
  }

  // Same for Symbol-keyed additions on Object.prototype: if the property is
  // non-configurable AND points at a non-callable, non-null value, no future
  // test can recover (Array.from on plain objects will keep failing). Restart.
  for (const sym of Object.getOwnPropertySymbols(Object.prototype)) {
    if (_origObjectProtoSymbols.has(sym)) continue;
    const desc = Object.getOwnPropertyDescriptor(Object.prototype, sym);
    if (!desc) continue;
    const dataVal = desc.value;
    const isHarmful =
      dataVal != null && typeof dataVal !== "function" && (desc.get == null || typeof dataVal !== "function");
    if (!desc.configurable && isHarmful) {
      const reason = `non-configurable Object.prototype[${String(sym)}] = ${typeof dataVal} (#1160)`;
      console.error(`[unified-worker pid=${process.pid}] FATAL: ${reason} — recycling`);
      return recycleCleanup(reason);
    }
  }
  return cleanCleanup();
}

function compileTargetFromMessage(target) {
  return target === "linear" || target === "wasi" || target === "standalone" ? target : undefined;
}

function summarizeImportName(desc) {
  if (!desc || typeof desc !== "object") return undefined;
  const moduleName = desc.module ?? desc.moduleName ?? desc.module_name ?? "env";
  const name = desc.name ?? desc.field ?? desc.fieldName ?? desc.importName;
  if (!name) return undefined;
  return `${moduleName}::${name}`;
}

function summarizeImports(imports) {
  if (!Array.isArray(imports)) return [];
  return [...new Set(imports.map(summarizeImportName).filter(Boolean))].sort();
}

function classifyHostImportLeak(importNames) {
  if (!Array.isArray(importNames) || importNames.length === 0) return undefined;
  const joined = importNames.join(" ");
  if (/__extern_|__object_|__defineProperty|__get_builtin|__new_plain_object|__register_|__proto_method_call/.test(joined)) {
    return "dynamic_object_property";
  }
  if (/__iterator|__array_from_iter|__gen_|generator|async_iterator/.test(joined)) return "iterator_protocol";
  if (/RegExp_|regexp/i.test(joined)) return "regexp";
  if (/JSON_/i.test(joined)) return "json";
  if (/__extern_eval|__dynamic_import|Function_new/.test(joined)) return "dynamic_code";
  if (/wasm:js-string/.test(joined)) return "js_string";
  if (/wasi_snapshot_preview1/.test(joined)) return "wasi";
  return "host_import";
}

function buildResultMetadata(result, reachedTest) {
  const imports = summarizeImports(result?.imports);
  const hostImportLeakClass = classifyHostImportLeak(imports);
  return {
    ...(imports.length > 0 ? { imports } : {}),
    ...(hostImportLeakClass ? { hostImportLeakClass } : {}),
    reachedTest,
  };
}

function makeWorkerRecycleError(reason) {
  const err = new Error(reason);
  err.workerRecycleReason = reason;
  return err;
}

async function doCompile(source, sourceMapUrl, target, inferModuleStrictArguments) {
  // Defence-in-depth: restore any poisoned builtins BEFORE each compile.
  // postCompileCleanup runs after the previous test, but under rare worker
  // interruption scenarios it may not have completed. Doing a cheap pre-
  // compile restore guarantees the compiler always starts with a clean
  // Array.prototype[Symbol.iterator] et al. (#1160)
  let preCleanup;
  try {
    preCleanup = restoreBuiltins();
  } catch (err) {
    const kind = err?.constructor?.name ?? typeof err;
    throw makeWorkerRecycleError(`restoreBuiltins before compile threw (${kind})`);
  }
  if (preCleanup.recycle) {
    throw makeWorkerRecycleError(`worker built-ins poisoned before compile: ${preCleanup.reason}`);
  }
  const compileFn = incrementalCompiler ? incrementalCompiler.compile : compile;
  // (#3049 C1) Host lane (no target) defers top-level init: `__module_init`
  // is exported instead of wired to the wasm `(start)` section, and the exec
  // path below calls it right after `setExports` so top-level code runs
  // against a fully-wired runtime. Aligned with compiler-fork-worker.mjs +
  // tests/test262-runner.ts (#1251 both-paths rule). Standalone/wasi/linear
  // targets keep their own `_start` init model.
  const deferOpt = target ? {} : { deferTopLevelInit: true };
  return incrementalCompiler
    ? compileFn(source, { sourceMapUrl: sourceMapUrl || "test.wasm.map", target, inferModuleStrictArguments, ...deferOpt })
    : (await compile(source, {
              fileName: "test.ts",
              sourceMap: true,
              sourceMapUrl: sourceMapUrl || "test.wasm.map",
              emitWat: false,
              skipSemanticDiagnostics: true,
              target,
              inferModuleStrictArguments,
              ...deferOpt,
            }));
}

/**
 * Extract a human-readable message from a Wasm runtime error.
 * Handles `WebAssembly.Exception` (extracts payload via `__exn_tag`),
 * generic `Error` (pulls `.message` + function-name annotation), and
 * anything else (falls back to `String(err)`). If `instance` is null
 * (e.g. the throw happened during `WebAssembly.instantiate` from a
 * start function), tag lookup is skipped.
 */
/**
 * (#2870) Stringify a thrown payload WITHOUT ever letting a host TypeError
 * escape. A `--target standalone` module's thrown value is frequently a Wasm-GC
 * error struct (an `anyref` with no JS-reachable `toString`); calling `String()`
 * on it makes the HOST `ToPrimitive` throw `Cannot convert object to primitive
 * value`. Unguarded, that host throw escaped this formatter and was recorded as
 * the test's failure — masking the REAL signature behind a phantom TypeError and
 * collapsing ~2,014 heterogeneous standalone failures onto one string (#2862).
 */
function safeStringifyThrown(v) {
  try {
    return String(v);
  } catch {
    const t = typeof v;
    return t === "object" || t === "function"
      ? "uncaught Wasm-GC exception (non-stringifiable payload)"
      : `uncaught Wasm exception (${t})`;
  }
}

/**
 * (#2962) Render a natively-thrown Wasm-GC payload through the module's own
 * `__exn_render_prepare` / `__exn_render_char` exports (standalone/wasi
 * binaries emit them at finalize) — the module runs the payload through the
 * same `__any_to_string` chain its in-module `String(x)` uses, so an
 * `$Error_struct` renders "TypeError: boom" per §20.5.3.4 and a Test262Error
 * yields its real assertion message. Returns `null` when the exports are
 * absent (JS-host binaries), the payload renders empty, or anything throws —
 * the caller then falls back to the #2870 opaque label. Kept in sync with
 * `tryNativeExnRender` in tests/test262-runner.ts.
 */
function tryNativeExnRender(instance, payload) {
  try {
    const prep = instance?.exports?.__exn_render_prepare;
    const chr = instance?.exports?.__exn_render_char;
    if (typeof prep !== "function" || typeof chr !== "function") return null;
    const len = prep(payload);
    if (typeof len !== "number" || len <= 0 || len > 65536) return null;
    let out = "";
    for (let i = 0; i < len; i++) out += String.fromCharCode(chr(i));
    return out;
  } catch {
    return null;
  }
}

function extractWasmExceptionMessage(err, instance) {
  if (err instanceof WebAssembly.Exception) {
    let payload = null;
    if (instance) {
      try {
        const tag = instance.exports.__exn_tag ?? instance.exports.__tag;
        if (tag) payload = err.getArg(tag, 0);
      } catch {}
    }
    if (payload instanceof Error) {
      return payload.message ?? safeStringifyThrown(payload);
    }
    if (payload != null) {
      // (#2962) A host-opaque GC payload renders through the module's own
      // exports before falling back to the #2870 label; host-readable
      // primitives keep the direct String() path.
      const t = typeof payload;
      if (t === "object" || t === "function") {
        const native = tryNativeExnRender(instance, payload);
        if (native != null) return native;
      }
      return safeStringifyThrown(payload);
    }
    return instance ? "TypeError (null/undefined access)" : "wasm exception during module init";
  }
  if (err instanceof Error) {
    let info = err.message ?? String(err);
    const stack = err.stack ?? "";
    if (/illegal cast|null|unreachable|out of bounds/.test(info)) {
      // (#1316 / #1317) Extract every wasm frame in trap-first order so
      // the error chain reaches more than the leaf function — for
      // `illegal cast` and `dereferencing a null pointer` traps the
      // leaf is often a tiny lifted helper whose name alone is
      // uninformative without its caller.
      const frameRe = /at\s+(\S+)\s+\(wasm:\/\//g;
      const frames = [];
      let m;
      while ((m = frameRe.exec(stack)) !== null) frames.push(m[1]);
      if (frames.length > 0) {
        info = `${info} [in ${frames[0]}()`;
        if (frames.length > 1) {
          // Cap at 3 caller frames so the line stays readable inside the
          // 300-char `error.substring(0, 300)` truncation downstream.
          info += ` ← ${frames.slice(1, 4).join(" ← ")}`;
        }
        info += "]";
      }
    }
    return info;
  }
  return safeStringifyThrown(err);
}

function extractWasmFuncName(err) {
  // (#2962) guarded stringify — same #2870 hazard: `String(err)` on an exotic
  // thrown value (poisoned/prototype-less) throws a host TypeError mid-record.
  const stack = err?.stack ?? err?.message ?? safeStringifyThrown(err);
  const atMatch = stack.match(/at\s+(\w[\w$]*)\s+\(wasm:\/\//);
  if (atMatch) return atMatch[1];
  const fnMatch = stack.match(/function\s+#\d+:"([^"]+)"/);
  if (fnMatch) return fnMatch[1];
  return undefined;
}

function extractWasmByteOffset(err) {
  const text = `${err?.message ?? ""}\n${err?.stack ?? ""}`;
  const hexMatch = text.match(/:0x([0-9a-fA-F]+)/);
  if (hexMatch) return parseInt(hexMatch[1], 16);
  const plusMatch = text.match(/@\+(\d+)/);
  if (plusMatch) return parseInt(plusMatch[1], 10);
  const offsetMatch = text.match(/\boffset\s+(\d+)\b/i);
  if (offsetMatch) return parseInt(offsetMatch[1], 10);
  return undefined;
}

function decodeVLQSegment(segment) {
  const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const values = [];
  let i = 0;
  while (i < segment.length) {
    let vlq = 0;
    let shift = 0;
    let continuation = true;
    while (continuation && i < segment.length) {
      const digit = BASE64.indexOf(segment[i]);
      if (digit === -1) break;
      vlq |= (digit & 0x1f) << shift;
      continuation = (digit & 0x20) !== 0;
      shift += 5;
      i++;
    }
    const isNeg = (vlq & 1) === 1;
    values.push(isNeg ? -(vlq >>> 1) : vlq >>> 1);
  }
  return values;
}

function lookupSourceMapOffset(sourceMapJson, wasmOffset) {
  try {
    const sm = JSON.parse(sourceMapJson);
    const mappings = sm.mappings;
    if (!mappings) return undefined;
    const sources = sm.sources ?? [];
    const segments = mappings.split(",");
    let absWasmOffset = 0;
    let absSourceIdx = 0;
    let absLine = 0;
    let absCol = 0;
    let best;
    for (const seg of segments) {
      if (!seg) continue;
      const values = decodeVLQSegment(seg);
      if (values.length < 4) continue;
      absWasmOffset += values[0];
      absSourceIdx += values[1];
      absLine += values[2];
      absCol += values[3];
      if (absWasmOffset <= wasmOffset) {
        best = { line: absLine + 1, column: absCol + 1, source: sources[absSourceIdx] ?? "" };
      } else {
        break;
      }
    }
    return best;
  } catch {
    return undefined;
  }
}

function extractWatFunctionSnippet(wat, funcName) {
  if (!wat) return undefined;
  const lines = wat.split("\n");
  let start = -1;
  if (funcName) start = lines.findIndex((line) => line.includes(`(func $${funcName}`));
  if (start === -1) start = lines.findIndex((line) => line.includes("(func "));
  if (start === -1) return undefined;
  const snippet = lines
    .slice(start, Math.min(start + 8, lines.length))
    .map((line) => line.trim())
    .join(" ");
  return snippet.length > 220 ? `${snippet.slice(0, 217)}...` : snippet;
}

async function buildInvalidBinaryError(source, sourceMapUrl, result, target) {
  let detailErr;
  try {
    const imports = buildImports(result.imports, undefined, result.stringPool);
    await WebAssembly.instantiate(result.binary, imports);
  } catch (err) {
    detailErr = err;
  }

  const parts = [];
  const offset = detailErr ? extractWasmByteOffset(detailErr) : undefined;
  const mapped = offset !== undefined && result.sourceMap ? lookupSourceMapOffset(result.sourceMap, offset) : undefined;
  const funcName = detailErr ? extractWasmFuncName(detailErr) : undefined;
  if (mapped) parts.push(`L${mapped.line}:${mapped.column}`);
  parts.push(`invalid Wasm binary (${detailErr?.message ?? "WebAssembly.validate failed"})`);
  if (funcName) parts.push(`[in ${funcName}()]`);
  if (offset !== undefined) parts.push(`[@+${offset}]`);

  try {
    const watResult = await compile(source, {
      fileName: "test.ts",
      sourceMap: true,
      sourceMapUrl: sourceMapUrl || "test.wasm.map",
      emitWat: true,
      skipSemanticDiagnostics: true,
      target,
    });
    if (watResult.success && watResult.wat) {
      const snippet = extractWatFunctionSnippet(watResult.wat, funcName);
      if (snippet) parts.push(`[wat: ${snippet}]`);
    }
  } catch {}

  return parts.join(" ");
}

process.on("message", async (msg) => {
  const { id, source, execute, isNegative, isRuntimeNegative, expectedErrorType } = msg;
  const target = compileTargetFromMessage(msg.target);
  const compileStart = performance.now();

  let result;
  try {
    result = await doCompile(source, msg.sourceMapUrl, target, msg.inferModuleStrictArguments);
  } catch (err) {
    // Thrown exception may have poisoned the incremental compiler's internal
    // state.  Recreate immediately so subsequent compilations don't cascade-fail.
    incrementalCompiler = null;
    createFreshCompiler();
    if (err instanceof WebAssembly.Exception) {
      // Poisoned String.prototype (or similar built-in) — Wasm throw escaped
      // from the TS compiler internals. Send fail (not compile_error) and
      // restart the fork so subsequent tests get a clean environment.
      sendResult(
        {
          id,
          status: "fail",
          error: "wasm exception during compile (poisoned built-in)",
          isException: true,
          compileMs: performance.now() - compileStart,
        },
        "wasm exception during compile (poisoned built-in)",
      );
      return;
    }
    const errMsg = err?.message ?? String(err);
    sendResult(
      {
        id,
        status: "compile_error",
        error: errMsg,
        compileMs: performance.now() - compileStart,
      },
      err?.workerRecycleReason || poisonRecycleReason(errMsg),
    );
    return;
  }
  const compileMs = performance.now() - compileStart;
  const compileMetadata = buildResultMetadata(result, false);

  const hasErrors = !result.success || result.errors.some((e) => e.severity === "error");

  if (hasErrors) {
    const errMsg = result.errors
      .filter((e) => e.severity === "error")
      .map((e) => `L${e.line}:${e.column} ${e.message}`)
      .join("; ");
    const errorCodes = result.errors.filter((e) => e.severity === "error" && e.code).map((e) => e.code);
    const recycleReason = poisonRecycleReason(errMsg);

    // Write error to disk cache if paths provided
    if (msg.wasmPath && msg.metaPath) {
      try {
        writeFileSync(msg.wasmPath, new Uint8Array(0));
        writeFileSync(
          msg.metaPath,
          JSON.stringify({
            ok: false,
            error: errMsg || "unknown",
            errorCodes,
            compileMs,
            bundle_hash: BUNDLE_HASH,
          }),
        );
      } catch {}
    }

    if (recycleReason) {
      sendResult(
        {
          id,
          status: "compile_error",
          error: errMsg || "unknown",
          errorCodes,
          compileMs,
          ...compileMetadata,
        },
        recycleReason,
      );
      return;
    }

    // (#2912) Negative parse/early/resolution test, compile-FAILED arm.
    // Real error-type gate (was the dead `hasEarlyError ? "pass" : "pass"`):
    // score a conformance pass only when the raised compile error is consistent
    // with the test's expected `negative.type`. For the SyntaxError population
    // (all of test262's parse/early/resolution negatives) any compile-time
    // rejection is a static/syntax rejection => pass; a future wrong-type
    // negative rejected with an unrelated diagnostic now fails.
    if (execute && isNegative) {
      const matched = negativeCompileErrorMatches(expectedErrorType, errorCodes, errMsg);
      if (matched) {
        sendResult({ id, status: "pass", compileMs, errorCodes, ...compileMetadata });
      } else {
        sendResult({
          id,
          status: "compile_error",
          error: `expected ${expectedErrorType} but compiler rejected for an unrelated reason: ${errMsg || "unknown"}`,
          errorCodes,
          compileMs,
          ...compileMetadata,
        });
      }
    } else {
      sendResult({
        id,
        status: "compile_error",
        error: errMsg || "unknown",
        errorCodes,
        compileMs,
        ...compileMetadata,
      });
    }
    return;
  }

  // (#2912) Negative test that COMPILED (no severity-error) but emitted
  // warnings — e.g. an ES early error demoted to a warning (#2898). Route
  // through the same error-type gate: for the SyntaxError population any such
  // diagnostic is a static rejection => pass. (This warning arm is part of the
  // documented-lenient compile-SUCCEEDED fallback; strictly requiring a
  // severity-error diagnostic of the expected type is the #2912 follow-up.)
  if (execute && isNegative && result.errors.length > 0) {
    const warnCodes = result.errors.filter((e) => e.code).map((e) => e.code);
    const warnMsg = result.errors.map((e) => e.message).join("; ");
    const matched = negativeCompileErrorMatches(expectedErrorType, warnCodes, warnMsg);
    if (matched) {
      sendResult({ id, status: "pass", compileMs, errorCodes: warnCodes, ...compileMetadata });
      return;
    }
    // wrong-type warning — fall through to the compile/instantiate arms below
  }

  // Validate Wasm binary before proceeding
  if (!WebAssembly.validate(result.binary)) {
    const errMsg = await buildInvalidBinaryError(source, msg.sourceMapUrl, result, target);
    if (msg.wasmPath && msg.metaPath) {
      try {
        writeFileSync(msg.wasmPath, new Uint8Array(0));
        writeFileSync(msg.metaPath, JSON.stringify({ ok: false, error: errMsg, compileMs, bundle_hash: BUNDLE_HASH }));
      } catch {}
    }
    sendResult({ id, status: "compile_error", error: errMsg, compileMs, ...compileMetadata });
    return;
  }

  // Compilation succeeded — write to disk cache
  if (msg.wasmPath && msg.metaPath) {
    try {
      writeFileSync(msg.wasmPath, result.binary);
      writeFileSync(
        msg.metaPath,
        JSON.stringify({
          ok: true,
          stringPool: result.stringPool,
          imports: result.imports,
          sourceMap: result.sourceMap || null,
          compileMs,
          bundle_hash: BUNDLE_HASH,
        }),
      );
    } catch {}
  }

  // Compile-only mode: done
  if (!execute) {
    sendResult({ id, status: "compiled", compileMs, ...compileMetadata });
    return;
  }

  // ── Execute ──────────────────────────────────────────────────────

  // (#2920) Negative parse/early/resolution test that COMPILED with NO
  // diagnostic — the STRICT compile-SUCCEEDED arm (the follow-up to #2912's
  // deliberately-lenient fallback). The compiler did not detect the expected
  // early error, so this is a conformance FAIL regardless of whether the
  // produced Wasm happens to instantiate or link. Previously an INCIDENTAL
  // instantiate/link failure was scored `pass` (~439 host-lane false passes,
  // the #2898 fragility — `await`/`yield` as a binding identifier, escaped
  // keywords, duplicate module exports, unresolved imports). No instantiate
  // attempt is needed: we already know we failed to reject the program at
  // compile time. Intentional verdict tightening (coordinated baseline
  // refresh, plan/issues/2920); identical across gc/standalone.
  if (isNegative) {
    const { status, error } = negativeCompileSucceededVerdict(expectedErrorType, undefined);
    sendResult({ id, status, error, compileMs, ...compileMetadata });
    return;
  }

  const execStart = performance.now();
  let instance;
  try {
    const importObj = buildImports(result.imports, undefined, result.stringPool);

    try {
      const wasmResult = await WebAssembly.instantiate(result.binary, importObj);
      instance = wasmResult.instance;
    } catch (err) {
      const execMs = performance.now() - execStart;
      // Real Wasm compile/link failures stay as compile_error. A throw from
      // the module's start function — which surfaces as WebAssembly.Exception
      // or a plain Error — is a runtime throw, not a compile failure.
      if (err instanceof WebAssembly.CompileError || err instanceof WebAssembly.LinkError) {
        sendResult({
          id,
          status: "compile_error",
          error: err.message ?? String(err),
          instantiateError: true,
          compileMs,
          execMs,
          ...compileMetadata,
        });
        return;
      }

      if (isRuntimeNegative) {
        sendResult({ id, status: "pass", compileMs, execMs, runtimeNegativePass: true, ...compileMetadata });
        return;
      }

      sendResult({
        id,
        status: "fail",
        error: extractWasmExceptionMessage(err, null),
        isException: true,
        instantiateError: true,
        compileMs,
        execMs,
        ...compileMetadata,
      });
      return;
    }

    // Wire up setExports for callback support
    if (typeof importObj.setExports === "function") {
      importObj.setExports(instance.exports);
    }

    // (#3049 C1) Deferred top-level init (host lane): run the exported
    // `__module_init` now that `setExports` has wired the runtime. A throw
    // here keeps the classification the same code had when it surfaced from
    // the `(start)` section during instantiate: runtime-negative → pass,
    // anything else → an honest runtime fail (never malformed-wasm
    // compile_error). Standalone/wasi modules don't export `__module_init`
    // (they keep `_start`), so this is a no-op for them.
    const moduleInit = instance.exports.__module_init;
    if (typeof moduleInit === "function") {
      try {
        moduleInit();
      } catch (initErr) {
        const execMs = performance.now() - execStart;
        if (isRuntimeNegative) {
          sendResult({ id, status: "pass", compileMs, execMs, runtimeNegativePass: true, ...buildResultMetadata(result, true) });
          return;
        }
        sendResult({
          id,
          status: "fail",
          error: extractWasmExceptionMessage(initErr, instance),
          isException: true,
          compileMs,
          execMs,
          ...buildResultMetadata(result, true),
        });
        return;
      }
    }

    const testFn = instance.exports.test;
    if (typeof testFn !== "function") {
      sendResult({
        id,
        status: "compile_error",
        error: "no test export",
        compileMs,
        execMs: performance.now() - execStart,
        ...compileMetadata,
      });
      return;
    }

    // Run the test
    try {
      const ret = testFn();
      const execMs = performance.now() - execStart;

      if (isRuntimeNegative) {
        sendResult({
          id,
          status: "fail",
          error: "expected runtime error but succeeded",
          ret,
          compileMs,
          execMs,
          runtimeNegativeNoThrow: true,
          ...buildResultMetadata(result, true),
        });
      } else if (ret === -262) {
        // (#2939/#2940) Vacuity correction — the harness-wrapper callback never
        // executed (invoked wrapper + zero counted asserts). Scored `fail` with
        // a `vacuous` marker so host_free_pass / the standalone floor exclude it
        // and the report can tally the integrity correction separately.
        sendResult({
          id,
          status: "fail",
          vacuous: true,
          error: "vacuous: harness-wrapper callback never executed (#2940) — no assertion ran",
          ret,
          compileMs,
          execMs,
          ...buildResultMetadata(result, true),
        });
      } else {
        sendResult({ id, status: ret === 1 ? "pass" : "fail", ret, compileMs, execMs, ...buildResultMetadata(result, true) });
      }
      return;
    } catch (execErr) {
      const execMs = performance.now() - execStart;

      if (isRuntimeNegative) {
        sendResult({ id, status: "pass", compileMs, execMs, runtimeNegativePass: true, ...buildResultMetadata(result, true) });
        return;
      }

      let errInfo = extractWasmExceptionMessage(execErr, instance);

      // Annotate with source location via source map
      const byteOffset = extractWasmByteOffset(execErr);
      const mapped =
        byteOffset !== undefined && result.sourceMap ? lookupSourceMapOffset(result.sourceMap, byteOffset) : undefined;
      if (mapped) {
        errInfo = `L${mapped.line}:${mapped.column} ${errInfo}`;
      }

      sendResult({
        id,
        status: "fail",
        error: errInfo,
        isException: true,
        compileMs,
        execMs,
        ...buildResultMetadata(result, true),
      });
      return;
    }
  } catch (outerErr) {
    // #1221: A WebAssembly.Exception that escapes the inner try (e.g. thrown
    // by `restoreBuiltins` walking a poisoned Symbol.iterator, or by a
    // microtask resumed at an `await` boundary) is a runtime throw, not a
    // compile failure. Route it through extractWasmExceptionMessage so the
    // error text is meaningful instead of "[object WebAssembly.Exception]"
    // and emit status:"fail" so the dashboard groups it with real runtime
    // failures. The inner instantiate catch already handles the common case
    // (#1155) — this closes the remaining outer-catch leak that produced up
    // to ~1,176 misclassified rows in the test262 baseline.
    if (outerErr instanceof WebAssembly.Exception) {
      sendResult({
        id,
        status: "fail",
        error: extractWasmExceptionMessage(outerErr, instance ?? null),
        isException: true,
        compileMs,
        execMs: performance.now() - execStart,
        ...compileMetadata,
      });
    } else {
      sendResult({
        id,
        status: "compile_error",
        error: outerErr.message ?? String(outerErr),
        compileMs,
        execMs: performance.now() - execStart,
        ...compileMetadata,
      });
    }
    return;
  }
});

function postCompileCleanup() {
  const dirtySentinel = detectRecycleSentinelMutation();

  // Restore any built-in prototypes mutated by the test (must happen BEFORE
  // the next compile — the TS parser uses for...of on Arrays internally).
  let cleanup;
  try {
    cleanup = restoreBuiltins();
  } catch (err) {
    const kind = err?.constructor?.name ?? typeof err;
    cleanup = recycleCleanup(`restoreBuiltins threw (${kind})`);
  }

  if (dirtySentinel && !cleanup.recycle) {
    cleanup = recycleCleanup(`prototype sentinel changed: ${dirtySentinel}`);
  }

  compileCount++;
  if (WORKER_RECYCLE_INTERVAL > 0 && compileCount % WORKER_RECYCLE_INTERVAL === 0 && !cleanup.recycle) {
    cleanup = recycleCleanup(`worker recycle interval ${WORKER_RECYCLE_INTERVAL}`);
  }

  if (cleanup.recycle) {
    return cleanup;
  }

  if (compileCount % RECREATE_INTERVAL === 0) {
    try {
      incrementalCompiler?.dispose?.();
    } catch (_e) {
      // dispose() may fail if the service is already in a bad state
    }
    incrementalCompiler = null;
    const heapMB = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    console.error(`[unified-worker] RECREATE at compile ${compileCount}, heap=${heapMB}MB`);
    if (typeof globalThis.gc === "function") globalThis.gc();
    createFreshCompiler();
  } else if (compileCount % GC_INTERVAL === 0 && typeof globalThis.gc === "function") {
    globalThis.gc();
  }

  return cleanup;
}

// ── Realm-contamination canary (#1957) ─────────────────────────────────
// Tests share this process's JS realm, but test262's contract is a fresh
// realm per test: many tests deliberately mutate intrinsics
// (Array.prototype.length, JSON, Iterator.prototype.next, String.prototype …)
// through the compiled wasm's host imports. Those mutations previously leaked
// into every later test in the fork — and into the TS compiler itself, which
// runs in the same realm ("wasm exception during compile (poisoned
// built-in)", #1862). Which victims got hit was a function of shard
// assignment, so the baseline carried arbitrary contaminated entries and any
// shard-weight change redistributed them (blocked #1953 with deterministic
// net −1 flips).
//
// Strategy: BEHAVIORAL detection, targeted reset. After every result we diff
// a broad intrinsic surface (constructors + prototypes + iterator/generator
// prototypes + Math/JSON/Reflect/globalThis own descriptors) against a
// snapshot taken at worker startup. Only when actual drift is detected does
// the worker request a recycle via the existing pool protocol — the
// contaminating test keeps its own (valid) verdict, and the NEXT test gets a
// pristine process. Clean tests pay only the diff (~1ms); no per-test realm
// or process churn.
//
// Lazy runtime installs: the runtime intentionally installs helpers onto
// some intrinsics on first use (e.g. iterator helpers, generator
// prototypes — see _iteratorHelpersInstalled in src/runtime.ts). Those are
// NOT contamination. They are absorbed in two ways: surfaces the runtime
// owns are listed in REALM_CANARY_IGNORE, and in `recycle` mode the first
// post-drift snapshot re-baselines so a one-time install never causes a
// recycle loop.
//
// Modes (TEST262_REALM_CANARY): "" (off) | "log" (report drift to stderr,
// re-baseline, never recycle — measurement mode) | "recycle" (request a
// worker recycle on drift outside the ignore list).
const REALM_CANARY_MODE = process.env.TEST262_REALM_CANARY || "";

// Surfaces the runtime intentionally installs onto / mutates as part of
// normal operation. Label prefixes. Extend ONLY with evidence from `log`
// mode runs — every entry here is a hole in the canary.
const REALM_CANARY_IGNORE = [
  // Legacy RegExp statics (annexB) — written by EVERY regexp match as normal
  // engine behavior, not contamination. Measured in log mode 2026-06-11:
  // they flip on the first regexp-using test and would otherwise cause a
  // recycle storm. Residual hole: the few annexB legacy-statics tests can
  // still contaminate each other — accepted.
  "RegExp.input",
  "RegExp.$",
  "RegExp.lastMatch",
  "RegExp.lastParen",
  "RegExp.leftContext",
  "RegExp.rightContext",
  "RegExp.multiline",
  // Node internals lazily install symbol-keyed globals on first use
  // (observed: Symbol(undici.globalDispatcher.1) on first fetch-adjacent
  // path). Symbol-keyed globalThis additions are Node plumbing, not test262
  // contamination — a fresh worker would just re-install them and recycle
  // forever.
  "globalThis.Symbol(",
];

function realmCanaryIgnored(label) {
  return REALM_CANARY_IGNORE.some((p) => label.startsWith(p));
}

function collectIntrinsicSurface() {
  const roots = new Map();
  const add = (label, obj) => {
    if (obj && (typeof obj === "object" || typeof obj === "function") && !roots.has(label)) {
      roots.set(label, obj);
    }
  };
  const ctors = [
    Array, Object, String, Number, Boolean, Function, RegExp, Date, Symbol, Promise,
    Map, Set, WeakMap, WeakSet, Error, TypeError, RangeError, SyntaxError,
    ReferenceError, EvalError, URIError, ArrayBuffer, DataView, Int8Array,
    Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array,
    Uint32Array, Float32Array, Float64Array, BigInt, BigInt64Array, BigUint64Array,
  ];
  for (const c of ctors) {
    add(c.name, c);
    add(`${c.name}.prototype`, c.prototype);
  }
  add("Math", Math);
  add("JSON", JSON);
  add("Reflect", Reflect);
  add("globalThis", globalThis);
  try {
    const arrIter = Object.getPrototypeOf([][Symbol.iterator]());
    add("%ArrayIteratorPrototype%", arrIter);
    add("%IteratorPrototype%", Object.getPrototypeOf(arrIter));
    add("%StringIteratorPrototype%", Object.getPrototypeOf(""[Symbol.iterator]()));
    add("%MapIteratorPrototype%", Object.getPrototypeOf(new Map()[Symbol.iterator]()));
    add("%SetIteratorPrototype%", Object.getPrototypeOf(new Set()[Symbol.iterator]()));
    const genFn = function* () {};
    add("%GeneratorFunctionPrototype%", Object.getPrototypeOf(genFn));
    add("%GeneratorPrototype%", genFn.prototype ? Object.getPrototypeOf(genFn()) : undefined);
    const asyncGenFn = async function* () {};
    add("%AsyncGeneratorFunctionPrototype%", Object.getPrototypeOf(asyncGenFn));
    add("%TypedArrayPrototype%", Object.getPrototypeOf(Uint8Array.prototype));
  } catch {
    // best-effort — a missing exotic prototype shrinks coverage, never breaks
  }
  return roots;
}

function describeOwnSurface(obj) {
  const out = new Map();
  for (const key of Reflect.ownKeys(obj)) {
    let d;
    try {
      d = Object.getOwnPropertyDescriptor(obj, key);
    } catch {
      continue;
    }
    if (!d) continue;
    out.set(key, { v: d.value, g: d.get, s: d.set, w: d.writable, e: d.enumerable, c: d.configurable });
  }
  return out;
}

function snapshotRealmSurface() {
  const snap = new Map();
  for (const [label, obj] of collectIntrinsicSurface()) {
    try {
      snap.set(label, {
        obj,
        props: describeOwnSurface(obj),
        ext: Object.isExtensible(obj),
        proto: Object.getPrototypeOf(obj),
      });
    } catch {
      // skip unreadable root
    }
  }
  return snap;
}

const REALM_CANARY_MAX_DRIFT = 24;

function diffRealmSurface(snap) {
  const drift = [];
  for (const [label, entry] of snap) {
    if (drift.length >= REALM_CANARY_MAX_DRIFT) break;
    const { obj, props, ext, proto } = entry;
    let curProps;
    try {
      curProps = describeOwnSurface(obj);
      if (Object.isExtensible(obj) !== ext) drift.push(`${label}:[[Extensible]]`);
      if (Object.getPrototypeOf(obj) !== proto) drift.push(`${label}:[[Prototype]]`);
    } catch {
      drift.push(`${label}:unreadable`);
      continue;
    }
    for (const [key, sig] of props) {
      const cur = curProps.get(key);
      if (!cur) {
        drift.push(`${label}.${String(key)}:deleted`);
        continue;
      }
      if (
        !Object.is(cur.v, sig.v) ||
        !Object.is(cur.g, sig.g) ||
        !Object.is(cur.s, sig.s) ||
        cur.w !== sig.w ||
        cur.e !== sig.e ||
        cur.c !== sig.c
      ) {
        drift.push(`${label}.${String(key)}:changed`);
      }
    }
    for (const key of curProps.keys()) {
      if (!props.has(key)) drift.push(`${label}.${String(key)}:added`);
    }
  }
  return drift;
}

let realmCanarySnapshot = REALM_CANARY_MODE ? snapshotRealmSurface() : null;
let realmCanaryChecks = 0;
let realmCanaryCheckMsTotal = 0;

function realmDriftRecycleReason(payload) {
  if (!realmCanarySnapshot) return undefined;
  const t0 = performance.now();
  const drift = diffRealmSurface(realmCanarySnapshot).filter((d) => !realmCanaryIgnored(d));
  realmCanaryCheckMsTotal += performance.now() - t0;
  realmCanaryChecks++;
  if (REALM_CANARY_MODE === "log" && realmCanaryChecks % 200 === 0) {
    console.error(
      `[realm-canary] ${realmCanaryChecks} checks, avg ${(realmCanaryCheckMsTotal / realmCanaryChecks).toFixed(2)}ms`,
    );
  }
  if (drift.length === 0) return undefined;
  const summary = drift.slice(0, 8).join(", ") + (drift.length > 8 ? ` (+${drift.length - 8} more)` : "");
  console.error(`[realm-canary] drift after test#${payload?.id ?? "?"}: ${summary}`);
  // Re-baseline either way: in log mode so each event reports its own delta;
  // in recycle mode as a guard — if the pool ever ignores the recycle flag,
  // a one-time install must not become a recycle-per-test loop.
  realmCanarySnapshot = snapshotRealmSurface();
  if (REALM_CANARY_MODE === "recycle") return `realm drift (#1957): ${drift[0]}`;
  return undefined;
}

function sendResult(payload, forceRecycleReason) {
  const cleanup = postCompileCleanup();
  const driftReason = realmDriftRecycleReason(payload);
  const recycle = Boolean(forceRecycleReason || driftReason || cleanup.recycle);
  process.send(
    recycle
      ? {
          ...payload,
          recycle: true,
          recycleReason: forceRecycleReason || driftReason || cleanup.reason,
        }
      : payload,
  );
}

process.send({ type: "ready", pid: process.pid });
