---
id: 4740
title: "standalone: native WeakSet instances report WeakSet.prototype"
status: done
sprint: current
created: 2026-08-25
updated: 2026-08-25
completed: 2026-08-25
priority: high
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: conformance
area: codegen
language_feature: builtins, reflection
goal: standalone-mode
---

## Problem

In `--target standalone`, `Object.getPrototypeOf(new WeakSet(...))` returns
`null`, although the collection's language-level prototype is
`WeakSet.prototype`. The same failure affects the sibling native collection
backing type (`Map`, `Set`, and `WeakMap`) because all four lower to `$Map`.

## Evidence

On upstream/main `3809cc76e3ece099b77ec67ea5927c6950c09033`, this direct probe
returns `1` in the host lane and `0` in standalone:

```js
export function test() {
  return Object.getPrototypeOf(new WeakSet([])) === WeakSet.prototype ? 1 : 0;
}
```

The exact Test262 files
`built-ins/WeakSet/empty-iterable.js` and `built-ins/WeakSet/no-iterable.js`
also fail standalone with `Expected SameValue(«null», «[object Object]»)`.
The host runner's upstream harness assembly currently reports a separate
`sameValue is not a function` harness error for these files, so the direct
host/standalone probe is the host comparison. The corresponding standalone
failures are compiler behavior, not a harness-only result.

Nearby open work is non-overlapping: Map/Set `forEach` thisArg handling is
tracked separately (#4725), and WeakSet `undefined-newtarget` is a different
constructor error path (#4732).

## Root cause

Standalone construction creates a `$Map`-backed WasmGC struct. The generic
`__getPrototypeOf` fallback can only inspect `$Object`/fnctor links and thus
sees the opaque struct's host prototype as `null`. The compiler already emits
an identity-stable `$NativeProto` object for each collection's direct
`<Builtin>.prototype` value read, so the missing step is the statically typed
native-collection receiver arm in `Object.getPrototypeOf`.

## Implementation plan

1. In the standalone `Object.getPrototypeOf` dispatch, recognize checker types
   whose symbols are `Map`, `Set`, `WeakMap`, or `WeakSet`.
2. Evaluate and drop the receiver (preserving side effects), then reuse the
   existing native-prototype glue and lazy singleton for that collection.
3. Keep dynamic/`any` receivers and host mode on their existing fallback path.
4. Add focused controls for all four collections and ordinary object behavior;
   run the two exact WeakSet Test262 files in host and standalone where the
   harness permits, plus TypeScript/lint/format/budget checks.

## Test Results

- Focused Vitest controls: 3 passed (standalone and host all-four collection
  prototype mask `15`, plus ordinary object identity).
- Direct host/standalone probe after the fix: both return `1`; standalone emits
  no imports.
- Exact standalone Test262: `WeakSet/empty-iterable.js` pass;
  `WeakSet/no-iterable.js` pass. The legacy synthetic host runner also passes
  both exact files. `WeakSet/properties-of-the-weakset-prototype-object.js`
  remains a separate prototype-of-prototype residual and is intentionally not
  included in this fix.
- TS5 and TS7 typechecks pass; targeted Biome lint and Prettier checks pass;
  LOC/function budgets pass with 24 net production LOC and no allowance.
