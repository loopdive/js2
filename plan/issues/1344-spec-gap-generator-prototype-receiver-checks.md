---
id: 1344
title: "spec gap: Generator/AsyncIterator prototype receiver TypeErrors + return/throw (52 + 12 test262 fails)"
status: suspended
assignee: ttraenkler/sen-1
created: 2026-05-08
updated: 2026-06-19
priority: medium
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: generators
goal: spec-completeness
sprint: 65
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

---

## Slice 1 (2026-06-19, sd3) — `next`/`return` borrowed-receiver TypeError — LANDED

Landed the dominant `this-val-not-generator` bucket: calling a borrowed
generator method with a `this` that lacks `[[GeneratorState]]`
(`GeneratorPrototype.next.call({})`) now throws a **catchable TypeError**
(§27.5.3.2 GeneratorValidate step 2), instead of the prior **silent
`{value: 0, done: true}` sentinel**.

**Root cause / fix** (`src/codegen/generators-native.ts`
`buildNativeGeneratorDispatch`): the dispatch tests the receiver against each
known native-generator state type (`ref.test $stateType`) and, on no match, fell
through to a hard-coded `{value:0, done:1}` result. That terminal `fallback`
is exactly the "not a generator" case, so it now emits a real catchable
TypeError via the shared `emitBrandCheckTypeError(ctx, body, msg)` helper (a
`__new_TypeError` instance + `throw $exc`, never a `ref.cast` trap). `throw` is
stack-polymorphic so it satisfies the enclosing block's result type without
leaving a value. One disjoint change; the per-generator `next`/`return` branches
are untouched.

**Verified** (`tests/issue-1344.test.ts`, 5 cases): borrowed `.next.call({})`
and `.return.call({}, v)` throw a `TypeError` *instance* (catchable in-module,
not a host RuntimeError); real generator `.next()` sequence + `.return(v)`
unchanged. `tsc --noEmit` clean; loadable generator suites
(`generators`/`generator-methods*`-loadable/`gen-call-579`) green. (Several
`generator-*.test.ts` files fail to even *load* on `origin/main` because they
import a never-committed `tests/helpers.js` — pre-existing infra gap, not a
regression from this change.)

**Still open for #1344 (issue stays `in-progress`):**
- **`.throw()`** is not routed through the native dispatch at all
  (`tryCompileNativeGeneratorMethodCall` early-returns for `throw`, and
  `compileDirectNativeGeneratorMethod` returns `undefined` for it) — the
  `throw/from-state-completed` bucket is untouched.
- **AsyncGenerator / AsyncIterator prototype** receiver checks + the
  prototype-of-prototypes existence (the 12-fail async bucket).
- **Reifying `GeneratorPrototype` as a first-class object** so the test262
  `Object.getPrototypeOf(g).prototype.next` access path is exercised directly
  (the current slice triggers via a borrowed method reference, which covers the
  semantic but the test262 harness uses the prototype-object access).

These remaining parts are the genuinely architectural half the 2026-05-28
triage flagged ("NOT a localized fix") — route to senior-dev/architect.

## Suspended Work (sd3 → sen-1, 2026-06-19)

**Branch:** `issue-1344-generator-receiver-checks` (PR #1732, BLOCKED — net-53)
**Worktree:** `/workspace/.claude/worktrees/issue-1344-generator-receiver-checks`
**PR #1732:** parked — fails the standalone regression gate; NOT in the merge
queue; do NOT enqueue.

### What the branch does (and why it regressed)
Slice 1 makes `buildNativeGeneratorDispatch`'s terminal `fallback`
(`src/codegen/generators-native.ts`) throw a catchable TypeError via
`emitBrandCheckTypeError` (native-proto.ts) instead of the silent
`{value:0,done:true}` sentinel. **Semantically correct** — borrowed
`Generator.prototype.{next,return}.call({})` now throws TypeError per §27.5.3.2;
5 unit tests pass (`tests/issue-1344.test.ts`); tsc clean.

**But CI standalone regression gate = net -53** (single bucket
`37cbcb78aea838e8`, all "wasm-hash change"). Confirmed root cause:
`emitBrandCheckTypeError` runs error-machinery side effects
(`emitWasiErrorConstructor` pushes `__new_TypeError`, `addStringConstantGlobal`,
`ensureExnTag`) **per generator dispatch site, inline in the fallback build**,
which happens MID generator-body compilation. This perturbs **every** generator
binary (+346 bytes for a one-generator program, verified) even when the throw is
never reached, and for 53 standalone tests that perturbation flips pass→fail.
Basic generator runtime behaviour (next/for-of/return/done/yield*) is
byte-stable and value-identical to baseline; the 53 are a subtler
harness/index-timing interaction.

### Approved fix direction (tech-lead option A) — needs senior-dev
Pre-register the TypeError-throw machinery **once** as a shared helper (mirror
#2025's proven `ensureNullThisTypeError` + `buildNullThisTypeErrorThrow`):
- a `ctx.generatorBrandTypeErrorReady` flag + idempotent
  `ensureGeneratorBrandTypeError(ctx, fctx)` that registers
  `__new_TypeError` / the message string / exn-tag ONCE with a correct
  late-import flush (`ensureLateImport` + `flushLateImportShifts`);
- a pure-lookup `buildGeneratorBrandTypeErrorThrow(ctx)` for the fallback arm;
- a single SHARED message (not the per-`methodName` string the WIP uses).
Then re-validate the standalone gate — **net ≥ 0 required before enqueue.**

**Why senior-dev / the tripwire:** getting `ensure`'s late-import flush to land
on the in-progress generator `fctx` at the right moment during the mid-body
`buildNativeGeneratorDispatch` build is exactly the error-machinery **timing**
protocol that #1726 / #2079 own. Done wrong it re-introduces the same index
desync → another net-53 class. This is NOT just hoisting a throw to a stub.

### Resume steps for sen-1
1. `cd /workspace/.claude/worktrees/issue-1344-generator-receiver-checks`
   (re-claim with `--force` if needed). PR #1732 is the existing impl PR.
2. Replace the inline `emitBrandCheckTypeError(ctx, fallback, …)` call in
   `buildNativeGeneratorDispatch` with `ensure…` (once, up front, before the
   `branch(0)` build) + `build…` (pure) for the fallback instrs.
3. Verify a single-generator program is byte-identical to baseline when the
   throw is unreachable (the WIP is +346 b; the fix should be ~0).
4. Re-run the standalone regression gate; only enqueue at net ≥ 0.
5. Then (separate follow-on slices, still #1344): `.throw()` routing,
   AsyncGenerator/AsyncIterator prototype checks, GeneratorPrototype-as-object
   reification — see the remaining-parts list above.
