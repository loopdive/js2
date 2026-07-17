---
id: 3184
title: "default lane: for-await-of / async-dstr vacuous cluster — 489 fails (383 'callback never executed'), async paths silently no-op"
status: ready
created: 2026-07-12
priority: high
feasibility: hard
model: fable
task_type: bug
area: codegen
es_edition: ES2018
language_feature: for-await-of
goal: core-semantics
sprint: current
horizon: l
related: [2940, 3086, 2613, 2614, 2669, 3021]
origin: "2026-07-12 Fable codebase audit (plan/log/2026-07-12-fable-codebase-audit.md, §F1)"
---

# #3184 — default lane: for-await-of / async-dstr vacuous cluster

## Child slices (filed 2026-07-12)

Decomposed into two M-sized claimable slices; this issue is the tracking
umbrella for the async-vacuous cluster:

- **#3197** — for-await-of / async-dstr drive (383 vacuous), P1.
- **#3198** — Promise-combinator vacuous callbacks (218), medium (overlaps
  blocked #2614 + active Promise work; likely shares the #3197 async-drive
  root cause).

## Problem

On the **default (JS-host) lane**, `language/statements/for-await-of` has
**489 non-pass** tests (baseline fetched 2026-07-12), of which **383** carry
the `vacuous: harness-wrapper callback never executed (#2940)` tag: the
compiled test returns "success" while the async callback chain — and therefore
every assertion — **never runs**. This is the biggest slice of the 1,544-record
vacuous family, itself the single biggest error bucket on the default lane
(~3.6 pts of conformance).

Sampled vacuous files are dominated by destructuring-in-async patterns:

```
language/statements/for-await-of/async-func-decl-dstr-array-elem-nested-array-null.js
language/statements/for-await-of/async-func-dstr-var-ary-ptrn-elem-id-iter-val-err.js
language/statements/for-await-of/async-func-dstr-var-obj-ptrn-prop-id-init-unresolvable.js
language/statements/for-await-of/async-gen-decl-dstr-obj-id-put-unresolvable-no-strict.js
```

Non-vacuous residual shapes in the same directory: `assert.sameValue(second/x/z/nextCount, N)`
(55), null-deref `[in fn() ← test]` (5), invalid Wasm (3).

The test262 runner is NOT the gap: it implements the async protocol —
`$DONE` (`tests/test262-runner.ts:1890`), `asyncTest` (`:1899`), detection
`needsDone`/`needsAsyncTest` (`:2568-2569`). The failure is compiler-side: the
host-lane async machinery never drives the `asyncTest(fn)` body to completion
when the body contains for-await-of / async destructuring shapes.

## Why this is not already covered

- #2940 / #3086 / #3001 — made the vacuity *visible* (honest
  reclassification); no fix scope.
- #2613 (await-thenable) and #2614 (Promise combinator resolve) — host-lane
  but **blocked**, and cover ~60 tests of the 1,544 family, none of the 383.
- #2865 / #2867 / #2895 / #2906 / #3132 / #3178 — all `--target standalone`
  carriers; this issue is the **JS-host lane**, which uses the host Promise /
  `__create_async_generator` imports and still never executes the callbacks.
- #2669 (destructuring umbrella) — notes 15 `for-await` dstr regressions from
  a merge-group floor; does not own the 383-record vacuous class.

## Reproduction path (verified anchors)

For-of/for-await statement dispatch enters at
`src/codegen/statements.ts:180-181` (`ts.isForOfStatement` →
`compileForOfStatement`, imported at `:39`); the await-modifier lowering and
its host-Promise drive are inside that path. First diagnostic step: take one
sampled vacuous test, compile on the default lane, and trace whether (a) the
wrapped `asyncTest` callback is ever invoked, (b) the for-await loop's first
`IteratorNext` promise is ever awaited, or (c) an early silent rejection is
swallowed by the host bridge (`Promise_then` / `__make_callback` family in
`src/runtime.ts`).

## Acceptance criteria

1. Root-cause note in this file: which link of the chain drops the callback
   (asyncTest wrapper → async fn body → for-await drive → $DONE).
2. The 383 vacuous for-await-of records: ≥ 250 flip to genuine pass OR to
   honest assertion failures (no longer vacuous) on the default lane.
3. `language/statements/for-await-of` non-pass drops below 250 (from 489).
4. No standalone-lane regressions (the standalone carriers #2865/#3132 own
   that lane; this issue must not touch their emit paths).
5. If the same root cause explains the async-function/async-generator vacuous
   slices (~91) and/or Promise-combinator slice (218 — coordinate with #2614),
   note the measured overlap; do NOT scope-creep the fix into combinators.

## Audit cross-link

`plan/log/2026-07-12-fable-codebase-audit.md` §F1 — full decomposition of the
1,544-record vacuous family.
