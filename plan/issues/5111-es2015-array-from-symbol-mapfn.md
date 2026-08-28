---
id: 5111
title: "ES2015 standalone Array.from rejects a Symbol mapper"
status: in-progress
created: 2026-08-28
updated: 2026-08-28
priority: medium
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: array-from-mapfn-callability
es_edition: ES2015
goal: standalone-mode
files:
  - src/codegen/expressions/call-builtin-static.ts
  - tests/issue-5111-array-from-symbol-mapfn.test.ts
  - plan/issues/5111-es2015-array-from-symbol-mapfn.md
loc-budget-allow:
  - src/codegen/expressions/call-builtin-static.ts
func-budget-allow:
  - src/codegen/expressions/call-builtin-static.ts::compileBuiltinStaticCall
---

# #5111 — ES2015 standalone `Array.from` rejects a Symbol mapper

## Problem and exact cohort

The maintained ES2015 Test262 row
`test/built-ins/Array/from/mapfn-is-symbol-throws.js` passes in the host
target but fails in standalone. `Array.from([], Symbol("1"))` must throw a
`TypeError` because a Symbol is not callable. The standalone native
`Array.from(items, mapFn[, thisArg])` path currently forwards every mapper to
the native closure HOF; a statically known Symbol is therefore not rejected
and the test's `assert.throws` reports that no exception was thrown.

This issue owns exactly that one row. Other `Array.from` mapper values,
iterables, array-like sources, and callback dispatch remain out of scope
unless a regression control demonstrates that the narrow callability guard
cannot be isolated.

## Baseline evidence

The authoritative snapshots supplied for this run are:

- standalone: `/private/tmp/js2-baseline-standalone-current-20260828.jsonl`,
  SHA-256
  `260a57b7fb4d53516fa81e1c949d81337968e30ce790d457bcc2d3945c2e9e1e`;
- host: `/private/tmp/js2-baseline-host-current-20260828.jsonl`, SHA-256
  `a395f2a88d289a8e0fd78ccd76e090215ef3a85f1960aa8fe96f7d3a0445bd49`;
- edition map: `website/public/benchmarks/results/test262-file-editions.json`
  from `upstream/main`, SHA-256
  `4e1b3409bb509052128fca642e1b982a0f27c4c9224a596753b498be5b421db1`.

The edition map classifies the path as ES2015. The source base for this
worktree is `upstream/main` at `63e80e392879e286569ba5ebf8de33f546c3632b`.
The exact snapshot rows use oracle version 13 and the official standard
population:

| lane | status | error | reached test |
| --- | --- | --- | --- |
| host | pass | — | true |
| standalone | fail | `Test262Error: Array.from([], Symbol("1")) throws a TypeError exception Expected a TypeError to be thrown but no exception was thrown at all` | true |

The standalone snapshot row is timestamped `28.8.2026, 01:53:33`; the host
row is timestamped `28.8.2026, 02:06:21`. The baseline standalone row has no
compile error, timeout, or skip: it reaches the assertion after the native
mapper path returns normally.

## Root cause and implementation plan

`src/codegen/expressions/call-builtin-static.ts` lowers a two-argument
`Array.from` call to `__array_from_mapped` in standalone. The mapper is
compiled as an externref and passed to `__hof_map`, whose closure bridge is
correct for callable closures but has no `IsCallable` rejection for a
statically known Symbol. The generic host fallback is intentionally not used
for this standalone arm.

1. At the narrow standalone `Array.from` mapper boundary, recognize only a
   statically known Symbol mapper through `ctx.oracle.staticJsTypeOf`.
2. Evaluate the source and mapper using the existing expression machinery and
   emit the existing native `TypeError` path before entering the native map
   helper. Preserve callable closures, dynamic mapper values, source
   evaluation, optional `thisArg`, host mode, and all other static methods.
3. Add one focused Vitest regression covering the exact Test262 row in host and
   standalone, a callable mapper positive control, and a standalone import
   assertion. Corpus-backed assertions must be guarded so the mandatory
   compiler controls still run in a no-corpus checkout.
4. Run exact host/standalone A/B probes and one standalone repeat with the
   supplied QuickJS artifact, then focused regression and normal scoped gates
   with no more than two workers. Record final counts, hashes, and handoff
   details here.

The source change is limited to one codegen module and must not alter
`src/codegen/hof-native.ts`, collection callbacks, or the excluded active
cohorts (4786, 4779, 5091, 5099, 5100, 5102, 5104, 5107, 5108, and the
parallel for-in closure lane).

## Acceptance criteria

- The exact Test262 row is pass in both host and standalone.
- The standalone result has no `env::*` imports, compile errors, timeouts,
  skips, or nondeterminism; host behavior remains passing.
- A callable mapper still receives the expected value/index and a dynamic
  mapper remains on its existing path.
- The focused regression and mandatory no-corpus controls pass; no unrelated
  source files or excluded cohorts are changed.
- This record contains final validation, the branch/head, and the single PR
  handoff. No GitHub issue is created or referenced.

## Handoff

Worktree: `/private/tmp/js2-es2015-next-lane-f-20260828`

Branch: `codex/es2015-next-lane-f`

Plan checkpoint: created before implementation; source and regression edits
are pending.
