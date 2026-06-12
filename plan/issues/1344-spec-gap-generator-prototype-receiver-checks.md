---
id: 1344
title: "spec gap: Generator/AsyncIterator prototype receiver TypeErrors + return/throw (52 + 12 test262 fails)"
status: ready
created: 2026-05-08
updated: 2026-06-12
priority: medium
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: generators
goal: spec-completeness
sprint: 63
parent: 1328
depends_on: [1665]
---
## Triage 2026-05-28 — NOT a localized receiver-check fix

**Brand-check half is already done.** Issue #820j (TaskList #111, completed)
installed `_GeneratorState.get(this)` guards on `%GeneratorPrototype%.next`
/ `.return` / `.throw` and the `%AsyncGeneratorPrototype%` mirror. See
`src/runtime.ts:182-225` for the implementations.

**Current baseline (`.test262-cache/test262-current.jsonl`, 2026-05-28):**

| Suite | total | pass | fail breakdown |
|---|---|---|---|
| `built-ins/GeneratorPrototype` | ~70 | ~35 | 14 unreachable, 10 assertion_fail, 8 other, 3 runtime_error |
| `built-ins/AsyncGeneratorPrototype` | ~48 | ~46 | 2 assertion_fail |
| `built-ins/AsyncIteratorPrototype` | 13 | 6 | 6 assertion_fail (`Symbol.asyncDispose` family), 1 promise_error |

Zero remaining `type_error` failures on the cluster — exactly the
acceptance-criterion family this issue was opened to address. Original
"52 + 12 fails" tally is stale.

**What the residual ~37 failures actually need (NOT brand checks):**

1. **Generator state machine rewrite** (covers ~24 of the 35 GeneratorPrototype
   fails — `unreachable`, `try-catch-*`, `try-finally-*`, `lone-return`,
   `from-state-executing`, etc.). Today the generator desugaring buffers all
   values eagerly into `state.buf`; it does not pause at `yield`, can't run
   `finally` blocks on `.return()`, and can't observe the `executing` state
   for re-entrant `.next()` calls. This is the **#1665 native-generators**
   architect-blocked gap (task #93 senior-dev escalation, blocked on
   #1666/#1664).
2. **`AsyncIteratorPrototype[Symbol.asyncDispose]`** (~6 fails) — ES2026
   stage-3 feature; not in `_getAsyncIteratorPrototype()` and not in
   #1665's scope. Carve as a separate small issue once the spec lands.
3. **`GeneratorPrototype/return/not-a-constructor.js` (1 fail)** — covered
   by #930 (not-a-constructor detection); generator method case missing.

**Why this is not a developer-localized fix:** the state-machine rewrite
touches `src/codegen/expressions.ts` yield/yield* lowering AND the
generator runtime closure shape. There is no ~20 LOC version; the
architect spec #1665 (gated on #1666/#1664) is the path forward.

## Recommendation

Mark `status: blocked` with `depends_on: [1665]`. The ~6 asyncDispose
residuals and the 1 not-a-constructor residual can be carved as separate
small issues; the remaining ~30 are the same generator state-machine gap.

---

# #1344 — Generator / AsyncIterator prototype: receiver checks, .return/.throw

## Problem

`built-ins/GeneratorPrototype`: **9 / 61 pass (14.8%) — 52 fails (20 type_error, 14 unreachable,
10 assertion_fail, 8 other)**.
`built-ins/AsyncIteratorPrototype`: **1 / 13 pass (7.7%) — 12 fails (7 type_error, 4 assertion_fail,
1 promise_error)**.
`built-ins/AsyncGeneratorPrototype`: **26 / 48 (54.2%) — 22 fails (17 type_error)**.

Spec §27.5.1 (GeneratorPrototype) and §27.6.1 (AsyncGeneratorPrototype) require:
1. **Brand check**: `next/return/throw` must validate `this` carries the [[GeneratorState]] internal slot;
   otherwise TypeError.
2. **State machine**: states are "suspendedStart", "suspendedYield", "executing", "completed".
3. **`.return(value)`**: from suspendedYield, run finally blocks; from completed, immediately return.
4. **`.throw(error)`**: from suspendedYield, throw inside the generator (caught by try/catch); from
   suspendedStart or completed, immediately rethrow.
5. **`%IteratorPrototype%`** is the [[Prototype]] of GeneratorPrototype.

The 14 `unreachable` failures are particularly bad — they indicate Wasm `unreachable` traps,
meaning we crash hard rather than throwing TypeError.

## Acceptance criteria

1. `built-ins/GeneratorPrototype/next/this-val-not-generator.js` passes (TypeError, no trap).
2. `built-ins/GeneratorPrototype/return/from-state-suspended-start.js` passes.
3. `built-ins/GeneratorPrototype/throw/from-state-completed.js` passes.
4. `built-ins/AsyncIteratorPrototype/Symbol.asyncIterator.js` passes.
5. Pass-rate for `built-ins/GeneratorPrototype` rises from 15% to ≥65%.
6. No `unreachable` traps in Generator tests (must be replaced by TypeError).

## Files to modify

- `src/codegen/expressions.ts` — yield/yield* lowering, generator state machine
- `src/codegen/registry/generator.ts` — generator prototype method emission

## Implementation Plan

### Root cause

The generator state machine is implemented but its prototype methods don't validate the
receiver. When called on a non-generator (e.g. `Generator.prototype.next.call({})`), we
attempt to read the state field via `struct.get` on a non-Generator struct — `ref.cast` traps
with `unreachable`.

### Approach

Insert a `ref.test $GeneratorBrand` guard at the top of each prototype method:
```
local.get $this
ref.test $GeneratorBrand
i32.eqz
if
  ;; throw TypeError("not a generator")
end
local.get $this
ref.cast $GeneratorBrand
;; ... existing impl
```

Same for AsyncGenerator and AsyncIterator (which is the prototype-of-prototypes — must exist
even though tests check just for its existence).

### Edge cases

- `.return(value)` while in `executing` state → throw TypeError (re-entrant call).
- `.throw(err)` from `suspendedStart` → just close the generator and throw (no try/catch around
  the prologue).
- Async generator: `.return()` resolves to `{value, done:true}`; `.throw()` rejects with the error.

### Test262 sample

- `test262/test/built-ins/GeneratorPrototype/next/this-val-not-generator.js`
- `test262/test/built-ins/GeneratorPrototype/throw/from-state-completed.js`
- `test262/test/built-ins/AsyncGeneratorPrototype/throw/throw-promise-rejected.js`

## Unblocked (2026-06-12)

Blocker #1665 is done — flipped to `ready`, queued sprint 63. Re-validate the repro first (#2148).
