---
id: 3731
title: "generateMultiModule is missing ~19 fill*() driver calls that generateModule has (unreachable-trap risk)"
status: ready
sprint: Backlog
created: 2026-07-28
updated: 2026-07-28
priority: high
horizon: l
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: compiler-internals
goal: crash-free
depends_on: []
related: [3707]
loc-budget-allow:
  - src/codegen/index.ts
func-budget-allow:
  - src/codegen/index.ts::generateMultiModule
---
# #3731 — `generateMultiModule` is missing ~19 `fill*()` driver calls that `generateModule` has

## Context

Follow-up to #3707. That PR fixed a test262 pass-rate freeze caused by
`TypedArray.prototype.set(arr, offset)` crashing with an uncatchable
`unreachable` trap in standalone multi-file compiles, whenever `offset` needed
`ToNumber` via `valueOf`/`toString`/array-`join(",")` on a plain object or
array.

Root cause: the compiler has two module-generation entry points in
`src/codegen/index.ts`:

- `generateModule` — the single-source-string path (`compile()`).
- `generateMultiModule` — the multi-file path (`compileMulti()`,
  `compileFiles()` — used whenever real files are compiled from disk, e.g.
  test262's harness-include files bundled with a test, or any project with
  imports).

Both use the same "reserve a placeholder function now (body: `unreachable`),
patch its real body in post-processing once its dependencies are registered"
pattern for a large family of standalone-only runtime features. `generateModule`
calls the corresponding `fill*(ctx)` post-processing step for every one of
these reserved drivers. `generateMultiModule` was built later and only ever
picked up a subset — so for the missing ones, the driver's `unreachable` stub
body is **never patched**, and any compile that actually reaches it crashes the
whole module instead of running.

#3707 fixed the two drivers that were actually blocking test262
(`fillArrayToPrimitive` / `fillClassToPrimitive`, backing `__to_primitive`'s
array/class-instance arms). This issue tracks the **rest** of the gap, found by
diffing every `fill*(ctx)` call between the two functions in
`src/codegen/index.ts`.

## Confirmed missing from `generateMultiModule` (present in `generateModule`)

```
fillNativeIteratorLateArms
fillIterHofSteppers
fillLazyIterLadderArms
fillCombinatorToVec
fillHostFnctorMethodDrivers
fillProtoIteratorDriver
fillAccessorDrivers
fillDisposableStackDisposeDriver
fillBindDynHelper
fillProxyDispatch
fillPromiseThenableHelpers
fillSetRecFieldGetters
fillExternIsArray
fillExternSetVecArms
fillExternArrayLikeStructArms
fillDynamicForinVecArms
fillBuiltinFnMeta
fillExternGetErrorProps
fillDynamicProtoHelpers
```

(`fillArrayToPrimitive` and `fillClassToPrimitive` are no longer on this list —
landed in #3707.)

Reproduce the diff yourself against current `main`:

```bash
awk 'NR>=2918 && NR<=4072 && /fill[A-Za-z]+\(ctx/' src/codegen/index.ts | sed 's/^ *//' | sort -u > /tmp/single.txt
awk '/^export function generateMultiModule/{p=NR} p && NR<=p+560 && /fill[A-Za-z]+\(ctx/' src/codegen/index.ts | sed 's/^ *//' | sort -u > /tmp/multi.txt
comm -23 /tmp/single.txt /tmp/multi.txt   # in generateModule, missing from generateMultiModule
```

(Line ranges are approximate — re-locate `generateModule`/`generateMultiModule`
function bounds on the current tree; both functions have grown since.)

## Why this matters

Each of these backs a standalone-only feature (native iterators, `Array`
higher-order-function steppers, lazy iterator combinators, promise
combinators/thenables, host-fnctor method drivers, prototype iterator
override, live accessor get/set, `Symbol.dispose`, `Function.prototype.bind`,
`Proxy` trap dispatch, ES2025 collection field getters, `Array.isArray`,
vec `Array.prototype.set`, array-like closed-struct arms, for-in over a
runtime array, builtin-fn reflective metadata, `Error` property reads,
dynamic-prototype reads). Any of these reached through a **multi-file**
standalone compile (test262 harness-bundled test, any real multi-file
project) risks the exact same failure mode as #3707: a silent `unreachable`
crash instead of correct behavior, invisible until something happens to
exercise that exact path — which is exactly how #3707's bug went unnoticed
until now.

## Suggested approach

Rather than porting each `fill*` call individually (drift-prone — the two
functions will diverge again the next time someone adds a new driver to only
one of them), consider extracting the shared finalize sequence (roughly
`src/codegen/index.ts` lines ~3700–4072 in `generateModule`, everything after
body-compilation and before `eliminateDeadImportsAndPlanAbiCallables`) into a
single `runStandaloneFinalizePasses(ctx)` helper called by **both**
`generateModule` and `generateMultiModule` at the analogous point in each
pipeline. That closes this entire bug class at once instead of one driver at
a time, and prevents recurrence.

If a shared-helper refactor is judged too risky for one PR, the incremental
fallback is: for each missing `fill*`, write a `compileMulti` + `target:
standalone` regression test that exercises it (mirroring
`tests/standalone-multimodule-to-primitive-fills.test.ts` from #3707), add the
missing call at the matching relative position in `generateMultiModule`,
verify the test traps before / passes after, ship in small batches.

## Acceptance criteria

- [ ] Every `fill*(ctx)` call present in `generateModule` has a corresponding
      call in `generateMultiModule` (or a documented reason it's single-file-only).
- [ ] A regression test per newly-wired driver (or one comprehensive test suite
      covering the feature set), each proven to trap without the fix.
- [ ] No regressions in the existing `compileMulti`/standalone test slice
      (see #3707 for a starting list of relevant files).
- [ ] Ideally: the shared-finalize-helper refactor above, so this can't silently
      drift again.

## Out of scope

- Any bug found where `generateModule` itself (single-file path) is missing
  something `generateMultiModule` has — not observed, but not audited for
  either; file separately if found.
- The pre-existing, unrelated `Int16Array`/`Uint16Array` standalone
  multi-file "invalid module" bug noted in #3707 (a `array.set[2] expected
  type i32, found array.get of type f64` WebAssembly validation failure) —
  reproduces identically with and without #3707's fix; needs its own issue.
