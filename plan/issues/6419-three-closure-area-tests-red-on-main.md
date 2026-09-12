---
id: 6419
title: "Eleven closure-area tests across ten files are red on current main — found by an A/B sweep, every one identical on both arms"
status: ready
sprint: current
created: 2026-09-12
updated: 2026-09-12
priority: high
horizon: l
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
---

## Problem

Found while refreshing [#5356](https://js2wasm.loopdive.com/dashboard/issue.html?slug=5356-eager-capture-box-skips-let-const)
onto main (PR #5683). A sweep of the 100 test files under `tests/` whose names
match closure / capture / TDZ / hoist / destructuring / switch / let-const /
block-scope turned up 11 failing tests in 10 files.

**Every one of them is on main, not in that PR.** Each was re-run twice at one
head — once with the PR's seven touched `src/` files reverted to their
`upstream/main` content, once with the fix — and the failing-test lists came
back **byte-identical**, only the timings differing. That control matters most
for `#2623`, which is literally a capture-box-depth test and the first thing a
reader would suspect.

CI is green on main, so none of these are in a required lane today. They are
real defects that the gates do not currently see.

## The failures

| file | failing test | symptom |
| ---- | ------------ | ------- |
| `tests/illegal-cast-closures-585.test.ts` | assert_throws pattern with capturing closure | `Codegen error: prepared class … descriptor is stale` |
| `tests/issue-1058-function-hoist-facts.test.ts` | (whole file, at collection) | `TypeError: Cannot read properties of undefined (reading 'MAP')` |
| `tests/issue-1128-dstr-tdz.test.ts` | self-reference in array destructuring default throws | assertion |
| `tests/issue-1528-closure-construct.test.ts` | does NOT route a generator-method value through the construct bridge | expected `false`, got `true` |
| `tests/issue-1712-capture-closure-dispatch.test.ts` | prototype method returns a fnctor-instance node graph (acorn shape) | assertion |
| `tests/issue-2623-capture-box-depth.test.ts` | Constructor and its nested resolve capture callCount at the SAME depth | assertion |
| `tests/issue-2623-capture-box-depth.test.ts` | the capability fixture's nested capture is single-boxed (no cell-of-cell) | assertion |
| `tests/issue-2637-b2-ctor-closure-registration.test.ts` | `Promise.try.call(SubPromise, …)` runs the user body on the capability promise | assertion |
| `tests/issue-3036-late-microtask-closure.test.ts` | single instance: the late callback fires cleanly and sets the module global | assertion |
| `tests/issue-3036-late-microtask-closure.test.ts` | back-to-back instances: an earlier instance's late microtask survives a later `setExports` swap | assertion |
| `tests/issue-3520-closure-host-bridge-abi.test.ts` | does not discover closure helpers from a forged closure-free name family | assertion |

Three deserve calling out because their shape, not just their count, is
informative.

### `prepared class … descriptor is stale` — a compile error, not a wrong answer

```
Compile failed:
  L0: Codegen error: prepared class ir-class:v1:ir-source%3Av1%3A0000000000000000%3Aentry%3Ainput.ts:root:declaration:0000000000000000 descriptor is stale
```

The other 6 tests in that file pass. A stale-descriptor rejection means the
prepared-class cache key and the descriptor it resolves to have diverged, so
this is a caching/invalidation defect in the prepared-class path rather than
anything about closures — the `assert_throws` shape just happens to reach it.
Note the all-zero hash segments in the key.

### `collections-brand.ts` circular-import TDZ — the file cannot load first

`tests/issue-1058-function-hoist-facts.test.ts` fails at **collection** time,
standalone, with no test having run:

```
TypeError: Cannot read properties of undefined (reading 'MAP')
 ❯ src/codegen/collections-brand.ts:100:24
     99| const KIND_OF: Record<CollectionClass, number> = {
    100|   Map: COLLECTION_KIND.MAP,
 ❯ src/codegen/expressions/calls.ts:36:1
```

`COLLECTION_KIND` is `undefined` at module-evaluation time — a cycle between
`src/codegen/collections-brand.ts` and `src/codegen/expressions/calls.ts` where
`KIND_OF`'s top-level initializer runs before the other module's binding is
populated.

**This one is latent rather than permanently red, which is exactly why CI stays
green.** It throws only when this module is the *first* thing to pull the cycle
in. Run the file alone (or first in a fork) and it reproduces; run it after
almost anything else and it does not. So it is an ordering hazard that will
surface as a mystifying, unrelated-looking failure the next time vitest's
sharding shuffles — and the error will point at `collections-brand.ts`, which
will be innocent.

### A generator method IS routed through the construct bridge

`tests/issue-1528-closure-construct.test.ts`: expected `false`, got `true`. The
three sibling assertions — generator **function**, async function, plain
function — all pass, so the classifier handles every case except a generator
declared as an object/class **method**.

## Reproduction

```bash
node node_modules/vitest/vitest.mjs run \
  tests/illegal-cast-closures-585.test.ts \
  tests/issue-1528-closure-construct.test.ts \
  tests/issue-1058-function-hoist-facts.test.ts \
  --pool=forks --poolOptions.forks.maxForks=1
# → Test Files 3 failed (3); Tests 2 failed | 15 passed | 1 skipped (18)
```

The other seven files reproduce the same way, one file per vitest invocation.
Run them one at a time: the whole 100-file set, and even 12-file batches at
`maxForks=3`, OOM on a 16 GB box.

## Acceptance criteria

1. All eleven tests pass, standalone and in a batch.
2. The `collections-brand.ts` cycle gets a test that loads that module **first**,
   so the cycle cannot silently come back.
3. The generator-**method** case is added next to its three passing siblings.
4. Whatever lane should have caught these gets them: today CI is green while
   eleven tests in the repo are red, which is the finding behind the finding.
5. A/B at one head over the dogfood suites: nothing regresses.
