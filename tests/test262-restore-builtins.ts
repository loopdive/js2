// (#3318) In-process host-realm builtin restore for tests/test262-runner.ts.
//
// The IN-PROCESS runner (`runTest262File`) compiles AND executes tests in the
// caller's own realm: a test's compiled code mutates the REAL builtin
// prototypes (e.g. `Array.prototype[1] = 1` in
// built-ins/Array/prototype/lastIndexOf/15.4.4.15-8-a-14.js), and the poison
// survives into the NEXT call — where the TypeScript checker crashes with
// "Cannot create property 'declaredType' on number '1'" (its `symbolLinks`
// lookup is a plain array read, `symbolLinks[1]` inherits the polluted
// Array.prototype[1]). The SHARDED CI worker (scripts/test262-worker.mjs) has
// long had a comprehensive `restoreBuiltins()` (#1153/#1154/#1160/#1220/#1221)
// — but it is coupled to the fork-pool recycle protocol and executes pool
// logic at module load, so it cannot be imported here. This module is the
// runner-side counterpart covering the compile-killing pollution classes;
// unifying the two is part of the #3182 consolidation epic.
//
// Strategy mirrors the worker: value RE-ASSIGNMENT for changed props (never
// defineProperty first — it disturbs V8 shape/IC caches, #1153), descriptor
// re-application only as the fallback, DELETE for added keys. Non-configurable
// poison is reported (return false) — an in-process caller cannot recycle a
// fork, but it can surface the condition.
//
// (#3470) test262's `verifyProperty` (harness/propertyHelper.js:63-66 asserts
// `__hasOwnProperty(obj, name)`; the destructive probe is `isConfigurable()`
// at line 140, `delete obj[name]`) probes `configurable:true` via
// `delete obj[name]` and does NOT restore when no `restore` option is passed
// — the common case for `built-ins/**/name.js` / `length.js` tests. When
// `obj` is a prototype METHOD (e.g. `Date.prototype.getYear`), the delete
// removes THAT FUNCTION's own `.name`/`.length` sub-property. None of the
// restore logic above catches this: the function's IDENTITY never changes
// (`Date.prototype.getYear` is still the same function reference), so the
// value-restore loop's `cur.value === orig` check is a no-op. The
// auto-generated strict-mode rerun (same process, same realm) then sees the
// missing sub-property and fails "obj should have an own property
// name"/"length". Real Node passes (fresh realm per test); standalone
// passes (fresh per-module builtins). Only this shared-host-builtin lane
// leaks. Fix: snapshot + restore each captured method's own `.name`/
// `.length` descriptors too (see FN_SUBPROP_SNAPSHOTS below), and add the
// Date/TypedArray/DataView entries the original 12-proto list omitted.

import { _resetIteratorRuntimeIntrinsicsForRealmIsolation } from "../src/runtime.js";

const PROTOS: ReadonlyArray<[string, object]> = [
  ["Object.prototype", Object.prototype],
  ["Array.prototype", Array.prototype],
  ["String.prototype", String.prototype],
  ["Number.prototype", Number.prototype],
  ["Boolean.prototype", Boolean.prototype],
  ["Function.prototype", Function.prototype],
  ["RegExp.prototype", RegExp.prototype],
  ["Map.prototype", Map.prototype],
  ["Set.prototype", Set.prototype],
  ["WeakMap.prototype", WeakMap.prototype],
  ["WeakSet.prototype", WeakSet.prototype],
  ["Promise.prototype", Promise.prototype],
  // (#3470) Date/TypedArray/DataView were entirely absent — their prototype
  // methods (including annexB ones like Date.prototype.getYear, which don't
  // even appear in the sharded worker's curated method lists) never got
  // name/length sub-property restore at all.
  ["Date.prototype", Date.prototype],
  ["%TypedArray%.prototype", Object.getPrototypeOf(Int8Array.prototype)],
  ["Int8Array.prototype", Int8Array.prototype],
  ["Uint8Array.prototype", Uint8Array.prototype],
  ["Uint8ClampedArray.prototype", Uint8ClampedArray.prototype],
  ["Int16Array.prototype", Int16Array.prototype],
  ["Uint16Array.prototype", Uint16Array.prototype],
  ["Int32Array.prototype", Int32Array.prototype],
  ["Uint32Array.prototype", Uint32Array.prototype],
  ["Float32Array.prototype", Float32Array.prototype],
  ["Float64Array.prototype", Float64Array.prototype],
  ["BigInt64Array.prototype", BigInt64Array.prototype],
  ["BigUint64Array.prototype", BigUint64Array.prototype],
  ["DataView.prototype", DataView.prototype],
  // Constructors too — verifyProperty also targets e.g. `Date.name`,
  // `Int8Array.length` directly (own data properties of the constructor
  // function itself, captured for free by the existing key-enumeration
  // logic once the constructor object is a PROTOS entry).
  ["Date", Date],
  ["%TypedArray%", Object.getPrototypeOf(Int8Array)],
  ["Int8Array", Int8Array],
  ["Uint8Array", Uint8Array],
  ["Uint8ClampedArray", Uint8ClampedArray],
  ["Int16Array", Int16Array],
  ["Uint16Array", Uint16Array],
  ["Int32Array", Int32Array],
  ["Uint32Array", Uint32Array],
  ["Float32Array", Float32Array],
  ["Float64Array", Float64Array],
  ["BigInt64Array", BigInt64Array],
  ["BigUint64Array", BigUint64Array],
  ["DataView", DataView],
];

interface ProtoSnapshot {
  name: string;
  proto: object;
  ownKeys: Set<string>;
  ownSymbols: Set<symbol>;
  /** Original VALUES of data properties (functions and primitives alike). */
  values: Map<string | symbol, unknown>;
  /** Original descriptors, for the defineProperty fallback. */
  descs: Map<string | symbol, PropertyDescriptor>;
}

function snapshotProto(name: string, proto: object): ProtoSnapshot {
  const ownKeys = new Set(Object.getOwnPropertyNames(proto));
  const ownSymbols = new Set(Object.getOwnPropertySymbols(proto));
  const values = new Map<string | symbol, unknown>();
  const descs = new Map<string | symbol, PropertyDescriptor>();
  for (const key of [...ownKeys, ...ownSymbols]) {
    const d = Object.getOwnPropertyDescriptor(proto, key);
    if (!d) continue;
    descs.set(key, d);
    if ("value" in d) values.set(key, d.value);
  }
  return { name, proto, ownKeys, ownSymbols, values, descs };
}

// Snapshot at MODULE LOAD — import this module before any test executes.
const SNAPSHOTS: ProtoSnapshot[] = PROTOS.map(([name, proto]) => snapshotProto(name, proto));

// (#3470) Function `.name`/`.length` own-property snapshot, built from every
// function captured as a data-property VALUE above (methods AND, for the
// constructor PROTOS entries, the constructor's own name/length are already
// covered by the `values` restore loop directly — this covers the METHOD
// case: `Date.prototype.getYear.name` is a property of the function object
// nested one level below `Date.prototype`, which the generic key-enumeration
// loop above never reaches).
interface FnSubPropSnapshot {
  fn: (...args: unknown[]) => unknown;
  nameDesc: PropertyDescriptor | undefined;
  lengthDesc: PropertyDescriptor | undefined;
}

function snapshotFnSubProps(fn: (...args: unknown[]) => unknown): FnSubPropSnapshot {
  return {
    fn,
    nameDesc: Object.getOwnPropertyDescriptor(fn, "name"),
    lengthDesc: Object.getOwnPropertyDescriptor(fn, "length"),
  };
}

const FN_SUBPROP_SNAPSHOTS: FnSubPropSnapshot[] = (() => {
  const seen = new Set<unknown>();
  const out: FnSubPropSnapshot[] = [];
  for (const snap of SNAPSHOTS) {
    for (const value of snap.values.values()) {
      if (typeof value === "function" && !seen.has(value)) {
        seen.add(value);
        out.push(snapshotFnSubProps(value as (...args: unknown[]) => unknown));
      }
    }
  }
  return out;
})();

/**
 * Restore one `.name`/`.length` own-property descriptor on a function to its
 * module-load snapshot. Unconditional `defineProperty` (not `=`) — both
 * sub-properties are `writable:false` on every spec-conformant builtin
 * function, so plain assignment silently no-ops; they are always
 * `configurable:true`, so `defineProperty` should never fail in practice.
 */
function restoreFnSubProp(
  fn: (...args: unknown[]) => unknown,
  key: "name" | "length",
  orig: PropertyDescriptor | undefined,
): boolean {
  if (!orig) return true;
  const cur = Object.getOwnPropertyDescriptor(fn, key);
  if (
    cur &&
    cur.value === orig.value &&
    cur.writable === orig.writable &&
    cur.enumerable === orig.enumerable &&
    cur.configurable === orig.configurable
  ) {
    return true;
  }
  try {
    Object.defineProperty(fn, key, orig);
  } catch {
    /* residual check below */
  }
  const after = Object.getOwnPropertyDescriptor(fn, key);
  return !!after && after.value === orig.value;
}

/**
 * Restore the host realm's builtin prototypes to their module-load state.
 * Returns `false` when some poison could not be removed (non-configurable,
 * non-writable descriptor added by a test) — the caller should treat further
 * in-process compiles as unreliable.
 */
export function restoreHostBuiltins(): boolean {
  // Compiler-owned generator/iterator intrinsics are module-level caches, not
  // host built-ins listed below. A configurable descriptor probe can delete a
  // property from the sloppy variant and otherwise leak it into the strict
  // rerun. Drop that synthetic realm before restoring the host realm.
  _resetIteratorRuntimeIntrinsicsForRealmIsolation();

  let clean = true;
  for (const snap of SNAPSHOTS) {
    const { proto, ownKeys, ownSymbols, values, descs } = snap;
    // Delete ADDED keys (numeric-index pollution on Array.prototype is the
    // compile-killing case — the TS checker's array-indexed symbolLinks).
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (!ownKeys.has(key)) {
        try {
          delete (proto as Record<string, unknown>)[key];
        } catch {
          /* fall through to the residual check */
        }
        if (Object.getOwnPropertyDescriptor(proto, key)) clean = false;
      }
    }
    for (const sym of Object.getOwnPropertySymbols(proto)) {
      if (!ownSymbols.has(sym)) {
        try {
          delete (proto as Record<symbol, unknown>)[sym];
        } catch {
          /* fall through */
        }
        if (Object.getOwnPropertyDescriptor(proto, sym)) clean = false;
      }
    }
    // Restore CHANGED data values (deleted or replaced methods): plain `=`
    // first (writable descriptors — the common case), descriptor
    // re-application as the fallback (#1160 defineProperty-poisoned shapes).
    for (const [key, orig] of values) {
      const cur = Object.getOwnPropertyDescriptor(proto, key);
      if (cur && "value" in cur && cur.value === orig) continue;
      try {
        (proto as Record<string | symbol, unknown>)[key] = orig;
      } catch {
        /* fall through */
      }
      const after = Object.getOwnPropertyDescriptor(proto, key);
      if (!after || !("value" in after) || after.value !== orig) {
        const d = descs.get(key);
        if (d) {
          try {
            Object.defineProperty(proto, key, d);
          } catch {
            /* residual check below */
          }
        }
        const final = Object.getOwnPropertyDescriptor(proto, key);
        if (!final || ("value" in final && final.value !== orig)) clean = false;
      }
    }
  }
  // (#3470) Restore function .name/.length sub-properties poisoned by
  // verifyProperty()'s unrestored configurability probe. Best-effort and
  // intentionally NOT wired into `clean` — a missing name/length sub-prop
  // doesn't break compilation the way the poison classes above do (that's
  // what `clean` gates), and built-in function name/length descriptors are
  // always configurable:true per spec, so failure here would indicate a
  // test made a genuinely non-configurable change we can't recover from
  // anyway.
  for (const { fn, nameDesc, lengthDesc } of FN_SUBPROP_SNAPSHOTS) {
    restoreFnSubProp(fn, "name", nameDesc);
    restoreFnSubProp(fn, "length", lengthDesc);
  }
  return clean;
}
