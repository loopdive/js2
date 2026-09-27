---
id: 6465
title: "#6412's declaration/body agreement assertion turns 174 standalone `for-await-of` tests into compile errors"
status: ready
sprint: current
created: 2026-09-13
updated: 2026-09-13
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
goal: correctness
---

## Problem

`1ba798b5cc` ("fix(#6412): bake the Promise carrier into an activated async
declaration's result", PR #5871) added
`reportDeclaredAsyncResultDisagreement` in `src/codegen/async-activation.ts`.
It is a fatal diagnostic that fires when `asyncEngineWouldActivate` claimed the
declaration at body time but the declaration-time registered result is not
`externref`.

On the **standalone** target it now fires for essentially the whole
`for-await-of` population. Measured by diffing the merged standalone JSONL of
merge_group run `34734641960` (`6aac84c0b6`, before) against run
`34742396970` (`a7265340b1`, after) — 48735 rows each, completeness-validated:

| status | before | after | Δ |
| --- | --- | --- | --- |
| pass | 35742 | 35567 | **−175** |
| compile_error | 3176 | 3350 | **+174** |
| fail | 9694 | 9696 | +2 |

181 pass→other, 6 other→pass. The regressed set by directory:

```
174  test/language/statements/for-await-of
  4  test/language/expressions/super
  1  test/language/arguments-object/gen-func-decl-args-trailing-comma-spread-operator.js
  1  test/language/arguments-object/func-decl-args-trailing-comma-spread-operator.js
  1  test/harness/compare-array-arguments.js
```

Every one of the 174 carries the same message:

```
internal: async function `fn` activates a state machine (result: Promise/externref)
but its declaration-time signature registered <...>. Call sites compiled before
this body coerced against the stale result, which emits invalid Wasm. The
declaration pre-pass and the body-time activation decision must agree (#6412)
```

The js-host lane over the same window moved **+19**, so the disagreement is
specific to the standalone/host-free lowering — `bakeActivatedAsyncPromiseResult`
(`src/codegen/async-thenable-return.ts:157`) declines at declaration time for a
shape the engine then claims at body time.

This is what breached the #2097 standalone floor and parked every PR reaching
the merge queue on 2026-09-13 — see
[#6461](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6461-standalone-floor-below-mark-parks-queue)
for that analysis.

## Not yet reproduced in a unit fixture

A plain `async function fn() { for await (const {x:y} of asyncIter) {...} }`
compiled through `compile(src, { target: "standalone" })` at `69ccb3494f` does
**not** trip it, and neither does the literal test262 file assembled with
`assert.js` + `sta.js` + `doneprintHandle.js`. The trigger needs the runner's
exact variant assembly (`includes:`, the strict rerun, `deferTopLevelInit`,
`hostBridge: "always"`, `semanticProviders`) or the declaration ORDER that #6412
was itself about. First step is to reproduce one row through
`tests/test262-runner.ts`'s own standalone path rather than a hand-assembled
source.

## Acceptance criteria

- `asyncEngineWouldActivate` agrees between declaration registration and body
  time for the `for-await-of`-in-async-declaration shape on the standalone
  target, or the bake declines symmetrically so the assertion cannot fire.
- The 174 `test/language/statements/for-await-of/*` rows return to `pass` on
  `--target standalone`.
- A regression test that fails on the parent and passes with the fix, plus an
  anti-vacuity control (the shape #6412 originally repaired must stay fixed).
