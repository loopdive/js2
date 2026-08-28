---
id: 5091
title: "ES2015 standalone Set.prototype.forEach rejects Symbol callbacks"
status: done
sprint: current
created: 2026-08-27
updated: 2026-08-28
completed: 2026-08-28
priority: high
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: conformance
area: codegen
language_feature: set-prototype-foreach
es_edition: es2015
goal: standalone-mode
related: [3573, 2162]
assignee: "ttraenkler/codex-es2015-residual-20260827"
files:
  - src/codegen/map-runtime.ts
  - tests/issue-5091-set-foreach-symbol-callback.test.ts
  - plan/issues/5091-es2015-set-foreach-symbol-callback.md
loc-budget-allow:
  - src/codegen/map-runtime.ts
---

# Repository-local markdown issue 5091 — ES2015 standalone `Set.prototype.forEach` rejects Symbol callbacks

This is the repository-local issue record at
`plan/issues/5091-es2015-set-foreach-symbol-callback.md`; it is not a GitHub
issue.

## Problem

The maintained ES2015 Test262 row
`built-ins/Set/prototype/forEach/callback-not-callable-symbol.js` passes in the
host target but fails in standalone. `Set.prototype.forEach(Symbol())` must
throw a `TypeError`; the standalone native collection path does not classify a
Symbol callback as statically non-callable and falls through to the host
`Set_forEach` import instead.

This is the one Symbol-shaped tail left by the repository-local issue record
`plan/issues/3573-standalone-set-foreach-noncallable-symbol-matchall.md`, whose
five literal callback cases (`null`, `undefined`, number, boolean, and string)
are already green.
The change is limited to the native `Set`/`Map` forEach callback guard. Dynamic
callbacks and Wasm closures must retain their existing routing.

## Exact cohort and baseline (2026-08-27)

The focused cohort is exactly one ES2015 row:

- `test/built-ins/Set/prototype/forEach/callback-not-callable-symbol.js`

Fresh authoritative snapshots were fetched with
`node scripts/fetch-baseline-jsonl.mjs --force` and
`node scripts/fetch-baseline-jsonl.mjs --standalone --force` from the pinned
Test262 revision `b363f29d3c43c626dc852744ad64a0b48a003693`. The baseline row
is **host 1/1 pass** and **standalone 0/1 pass, 1/1 compile error**. The
standalone error is a `host_import_leak` for `Set_forEach`; there are no
timeouts or skips in this cohort. The neighboring five #3573 rows remain
standalone pass controls.

## Implementation plan

1. Extend the existing static non-callable check in
   `tryCompileNativeCollectionForEach` to recognize a statically known Symbol
   callback, matching the existing array-HOF `ESSymbolLike` treatment.
2. Reuse `emitThrowTypeError` and the existing receiver side-effect ordering;
   do not alter dynamic callback dispatch, closure lowering, collection
   iteration, or host-target behavior.
3. Add a focused Vitest regression that checks a native standalone module
   throws for `Set.forEach(Symbol())`, emits no `Set_forEach` import, and still
   invokes a closure callback. Run the exact Test262 row in both host and
   standalone targets.
4. Record final authoritative counts, focused regression counts, artifacts,
   commits, and PR handoff here.

## Evidence before implementation

`src/codegen/map-runtime.ts` already emits the required native TypeError for
literal `null`, `undefined`, numeric, boolean, and string callback arguments
from #3573. Its static branch intentionally has no Symbol case, while
`src/codegen/array-methods.ts` already treats a statically typed Symbol as
non-callable. The failing Test262 source uses `features: [Symbol]` and calls
`s.forEach(Symbol())`, so adding the same type classification through
`ctx.oracle.staticJsTypeOf` is narrow and preserves runtime values that cannot
be classified at compile time.

## Implementation

The static non-callable branch in `tryCompileNativeCollectionForEach` now also
checks `ctx.oracle.staticJsTypeOf(cbArg) === "symbol"`. This uses the shared
oracle type-query boundary rather than reaching directly into the TypeScript
checker, while preserving the same compile-time classification used by the
array-HOF guard. It reuses the existing receiver evaluation and
`emitThrowTypeError` path, so no collection iteration or dynamic callback
behavior changes.

## Post-fix evidence (2026-08-27)

The exact one-row cohort was rerun through
`scripts/harness-flip-probe.ts`, including its structural must-pass and
must-fail controls. Both lanes report **1/1 pass, 0 fail, 0 compile errors, 0
compile timeouts, 0 skips**:

- host artifact: `.tmp/issue-4789-final-host.jsonl`
- standalone artifact: `.tmp/issue-4789-final-standalone.jsonl`

The five existing #3573 literal callback controls were rerun with the selected
Symbol row. The six-row cohort reports **host 6/6 pass** and **standalone 6/6
pass**, with no other status. Cohort artifacts are
`.tmp/issue-4789-final-cohort-host.jsonl` and
`.tmp/issue-4789-final-cohort-standalone.jsonl`.

The focused Vitest regression `tests/issue-5091-set-foreach-symbol-callback.test.ts`
reports **4/4 passed** with one worker. TypeScript 7 typecheck, focused Biome
lint, focused Prettier check, and `git diff --check` pass. The fresh baseline
artifacts used for selection were:

- host: `.test262-cache/test262-current.jsonl`
  (`8303f7f87475abbf33a5558727df649bf5268617135c63f992f93df32bebcf22`)
- standalone: `.test262-cache/test262-standalone-current.jsonl`
  (`eb5efa0997b0cb070171e770b723f9035d2aa737ba83f63b0921404c318a967f`)

They recorded host **1/1 pass** and standalone **0/1 pass, 1/1 compile error**
for the selected row before the source change.

## Acceptance

- The exact row passes in host and standalone.
- Standalone emits no `Set_forEach` import for the Symbol callback and reports
  no compile error, timeout, or skip.
- The five existing #3573 literal callback rows remain green.
- Closure callback behavior and the host target remain green.
- Focused regression tests pass with at most two workers.

## Handoff

This repository-local issue record is complete at
`plan/issues/5091-es2015-set-foreach-symbol-callback.md`; no GitHub issue was
created for this work. The completed implementation was delivered by upstream
pull request #5093 and is merged into `loopdive/js2:main` at merge commit
`63e80e392879e286569ba5ebf8de33f546c3632b` (2026-08-28). The frontmatter
therefore records `status: done` and `completed: 2026-08-28`.
