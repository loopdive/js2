---
id: 3495
title: "compileMulti must finalize standalone vec indexed reads"
status: done
sprint: 73
created: 2026-07-20
updated: 2026-07-21
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: test262-conformance
lane: A
related: [2166, 2784, 3007, 3492, 3493]
files:
  - src/codegen/index.ts
  - tests/issue-3495-compile-multi-globalthis-array-index-reads.test.ts
loc-budget-allow:
  - src/codegen/index.ts
---

# #3495 — `compileMulti` must finalize standalone vec indexed reads

## Problem

After #3493 preserves the setup assignment in the official Test262 graph,
`globalThis.logs` is initialized and all five expected strings are pushed. Its
length is `5`, but every numeric indexed read silently produces `undefined`.

The cross-module property read has the honest runtime type `externref`. Under
standalone, a numeric `receiver[index]` therefore routes through
`__extern_get_idx`. Its eager body recognizes native `$Object` and `$ObjVec`
carriers. Ordinary array literals use compiler vecs such as
`$__vec_externref`, whose element-specific read arms are added later by
`fillExternGetIdxVecArms` after all carrier types are known.

The single-source compiler runs that finalizer. `generateMultiModule` does not,
so its helper permanently keeps the incomplete eager body and returns the
undefined sentinel for compiler vecs. This makes `assert.compareArray` report a
false value mismatch even though the stored values and module evaluation order
are correct.

The failure is not top-level-await scheduling and is not empty-array element
inference. Emitted WAT proves that `globalThis.logs = []` creates an
externref-element vec and that each native string is stored into its backing
array before the indexed read loses it.

## Evidence (2026-07-20)

- Reduced synchronous graph: setup assigns `globalThis.logs = []`; a second
  module pushes `"alpha"` and `"beta"`; the entry observes length `2` but both
  equality checks fail.
- The setup initializer emits `struct.new $__vec_externref`.
- Push emits both native string values followed by `array.set` on the
  externref backing array.
- Each `globalThis.logs[0]` read calls `__extern_get_idx`; the multi-source WAT
  only tests `$Object` and `$ObjVec`, then returns undefined for the compiler
  vec.
- `generateModule` calls `fillExternGetIdxVecArms`; `generateMultiModule`
  omitted the corresponding finalizer call.
- The exact official graph already has the expected five-entry evaluation
  order when observed by length. Only value reads are missing.

## Acceptance criteria

- Add a minimal cross-module standalone regression that checks exact string
  values, not only array length.
- Add a regression preserving the exact five-string order of
  `pending-async-dep-from-cycle.js`.
- `generateMultiModule` must run the established `fillExternGetIdxVecArms`
  finalizer after every source has registered its array carriers.
- Numeric indexed reads from an externref whose runtime value is any supported
  compiler vec must use the existing element-specific dispatcher arms.
- Non-vec standalone receivers keep the existing `$Object`/`$ObjVec` behavior;
  string and symbol keys remain on the ordinary property path.
- Do not special-case `globalThis`, `logs`, Test262 filenames, or string arrays.
- Preserve host/GC vec indexing, standalone `$Object`/`$ObjVec` indexing,
  out-of-bounds behavior, and host-import-free standalone output.

## Validation

- `tests/issue-3495-compile-multi-globalthis-array-index-reads.test.ts`: 2/2
  pass. Before the fix, the same assertions scored `1/7` and `1/63`; after the
  fix they score `7/7` and `63/63`.
- The #3493 regression and the relevant existing externref/native-vec indexed
  read regressions pass. Existing #2166 out-of-bounds and #2190 heterogeneous
  tuple failures reproduce on the parent commit and are not regressions from
  this finalizer call.
- `pnpm run typecheck`, `check:issue-ids`, `check:issue-spec-coverage`,
  `check:loc-budget`, and `check:test262-hard-errors` pass.
- The project runner passes the exact official standalone path: 1/1 for
  `language/module-code/top-level-await/pending-async-dep-from-cycle.js`.

## Residual FYI harness failure

The authoritative Node 25 FYI standalone lane still fails the exact path with
`wasm exception during module init`. A diagnostic-only binary rewrite that
exports the start function renders its payload as
`TypeError: Cannot access property on null or undefined at 4:1`.

This is distinct from the indexed-read bug fixed here: a reduced multi-source
`compareArray` over the same cross-module string values passes, while adding
the FYI harness setup to the otherwise passing official fixture graph triggers
the initialization exception before the final assertion. The residual must be
tracked as a separate harness/compiler initialization issue; it is not hidden
by or special-cased in this patch.
