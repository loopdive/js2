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

/**
 * Restore the host realm's builtin prototypes to their module-load state.
 * Returns `false` when some poison could not be removed (non-configurable,
 * non-writable descriptor added by a test) — the caller should treat further
 * in-process compiles as unreliable.
 */
export function restoreHostBuiltins(): boolean {
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
  return clean;
}
