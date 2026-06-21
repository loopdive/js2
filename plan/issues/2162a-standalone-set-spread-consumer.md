---
id: 2162a
title: "Standalone array-spread consumer of a native Set ([...set] / Set.values()/keys())"
status: done
sprint: 64
created: 2026-06-18
updated: 2026-06-18
completed: 2026-06-18
assignee: ttraenkler/sdev-iter
priority: medium
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: iterators-collections
goal: standalone-mode
parent: 2162
---

# Standalone array-spread consumer of a native Set

## Problem

Re-validating the standalone (`--target wasi`) iteration-protocol *consumer*
surface (TaskList #42, "synergy #18/#35") against current `upstream/main`: most
forms already pass (for-of over string/array/Set/Map, array spread, array
destructure, `[...m.keys()]`, `[...m.values()]`, arguments for-of). The
genuinely-broken, unclaimed subset was **array-spread of a native Set**:

```ts
const s = new Set([1, 2, 3]);
[...s];            // standalone: VALIDATE-FAIL — i32.add expected i32, found struct.get
[...s.values()];   // standalone: VALIDATE-FAIL — array.set expected f64, found externref
[...s.keys()];     // standalone: VALIDATE-FAIL — same
```

## Root cause

A standalone `Set` lowers to the WasmGC `$Map` struct (a Set is a Map under the
hood), with no leading `$length` field. Two distinct consumer bugs in
`src/codegen/literals.ts` `compileArrayLiteral`:

1. **Bare `[...set]`** fell into the generic vec-spread fallthrough, which reads
   `struct.get $Map 0` as a `$length` → `i32.add expected i32, found struct.get`
   (invalid Wasm).

2. **`[...set.values()]` / `[...set.keys()]`** route the receiver through
   `compileNativeCollectionIterator`, which materializes a canonical **externref**
   `$Vec`. But the array-literal element-type heuristic resolves the iterator's
   number type-argument to **f64**, and the Step-3 fill loop copied each element
   raw (`array.get → array.set`, no coercion) → `array.set expected f64, found
   externref` (invalid Wasm).

## Fix

`src/codegen/literals.ts`, both in `compileArrayLiteral`:

- **Part A (bare `[...set]`)** — before the generic vec fallthrough in the spread
  loop, detect a `Set` subject by its static type symbol and route it through the
  same `emitCollectionIteratorVec` driver `for-of`/`.values()` use (a Set spreads
  its values, §24.2.3.*). It produces the canonical externref `$Vec`, consumed by
  the materialized-vec spread tail.

- **Part B (element-type mismatch, the general fix)** — the Step-3 fill loop now
  captures a per-element coercion template (`coerceType(srcElem, dstElem)`) when
  the source vec's element type differs from the result vec's, and splices it
  between the `array.get` and `array.set`. For a Set→f64 result this is
  `__unbox_number`, which has a **pure-Wasm body in `nativeStrings` mode (no host
  import)**. When src/dst element types already match (the common array / generator
  / typed cases), the template is empty and the copy stays byte-identical.

Bare `[...map]` / `[...map.entries()]` spread `[k, v]` entry *pairs* (a separate
`$ObjVec` externref-pair shape) — deferred to the entries-pair slice (#2162 /
TaskList #9), left exactly at baseline (still VALIDATE-FAIL, no regression).
Array-destructuring of a spread-built vec (`const [a,b]=[...set]`) is a separate,
pre-existing issue (`const [a,b]=[...anyArr]` returns NaN identically on
baseline) and is out of scope.

## Acceptance criteria

- [x] `[...set]`, `[...set.values()]`, `[...set.keys()]` compile standalone (zero
  host imports) and produce the correct length + values.
- [x] `Set<string>` spread, mixed `[head, ...set]` (source order), and Set dedupe
  semantics work.
- [x] Existing array / string / native-generator / typed spread + Set/Map for-of
  stay green (regression guards in the test file).
- [x] IR fallback gate unchanged (the diff is gated on standalone WasmGC codegen).

## Test Results

- `tests/issue-42-standalone-set-spread.test.ts` — 16/16 green
  (`target: "standalone"`, zero host imports asserted): bare/values/keys spread
  length + values, `Set<string>`, mixed head+spread source-order, dedupe, plus a
  regression-guard block (array/string/generator/typed spread, Set for-of).
- `tests/issue-2169-spread-native-generator`, `issue-2151-spread-literal`,
  `issue-2162-collection-from-array`, `issue-2169-{destructure,arrayfrom}-native-generator`
  — unchanged (23 collection/generator/spread tests pass). (Pre-existing
  `./helpers.js`-import suite-load failures are unrelated and identical on
  `upstream/main`.)
- `pnpm run check:ir-fallbacks` — OK, no unintended/post-claim increases.
- `npx tsc --noEmit` clean on the changed file.

## Source

Triage of TaskList #42 (2026-06-18, sdev-iter) on `upstream/main` HEAD c2ad67851.
