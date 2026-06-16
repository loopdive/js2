---
id: 2170
title: "standalone: `yield*` delegation unsupported in native generator lowering (clean #680 bail)"
status: done
completed: 2026-06-15
sprint: 62
created: 2026-06-15
priority: medium
feasibility: hard
reasoning_effort: high
task_type: feature
area: codegen
language_feature: iterators-generators
goal: standalone-mode
parent: 2157
depends_on: [2079]
---

# #2170 — yield* delegation (SF-3 of #2157)

## Problem

```ts
function* inner(){ yield 1; yield 2; }
function* g(){ yield* inner(); yield 3; }   // standalone: #680 CE
```

`buildNativeGeneratorPlan` returns null on `yield*`, so standalone hits the
scoped #680 compile diagnostic. #2079 explicitly deferred this.

## Fix direction

Add a `yield-star(innerSubject)` state-graph terminator: on resume, drive the
inner generator's `next()` and re-yield each `{value}` until the inner is
`done`, then transition to the next outer state. Reuse the native
`tryCompileNativeGenerator*` driver for the inner. Spec: §27.5.3.7 (the `yield*`
iterator-delegation algorithm — `next`/`return`/`throw` forwarding).

## Acceptance criteria

- `tests/issue-2157-*.test.ts` SF-3 `it.todo` passes, zero host imports.

## Source

Triage of #2157 (2026-06-15, sdev5), SF-3. Fetch §27.5.3.7 before implementing.

## Implementation Plan (2026-06-15, sdev3 — machinery study)

Studied `src/codegen/generators-native.ts` (1794 lines). The native generator is
a state struct + a `__gen_resume_<g>(self) -> ref $result` trampoline
(`loop`/`block` dispatching on the `state` i32 field; terminators
`yield`/`return`/`jump`/`branch`/`done` at lines 1046-1102). The `yield*` bail is
`emitYield` line 350 (`if (yieldExpr.asteriskToken …) return fail()`).

### The load-bearing constraint: spills are f64-only
`buildResumeInfo` (≈727-751) builds the state struct as
`state:i32, sent:f64, mode:i32, abrupt:f64, param_*…, spill_*:f64` — **every body
spill is `f64`** (line 748). A `yield*` must persist the INNER iterator's **ref**
state across the outer generator's re-entries (the outer resume returns to the
host between each inner yield), so delegation cannot reuse an f64 spill. This is
why SF-3 is `hard`, not a one-terminator add.

### Design (tractable slice: `yield* <native-generator-call>`)
The repro (`function* g(){ yield* inner(); yield 3; }`) delegates to a call whose
callee is itself a native generator — resolve via
`ctx.nativeGenerators.get(<callee fn name>)` at plan-build time; if absent
(arbitrary iterable), keep `fail()` (general-iterable case = follow-up using the
#1320 standalone `__iterator`/`__iterator_next` bridge).

1. **State struct — typed delegation slot.** Extend `stateFields` with one
   `ref null $InnerState`-typed mutable field per `yield*` site (`deleg_<n>`),
   tracked in `NativeGeneratorInfo`. Append AFTER the f64 spills so existing
   `spillFieldOffset + i` indexing is unaffected.
2. **Plan builder.** New terminator
   `{ kind: "yield-star"; subject; innerKey; next }`. `emitYield` emits it
   (instead of `fail`) when `asteriskToken` and the callee resolves to a native
   generator. It is a SELF-suspending state: on resume it re-enters the SAME
   state until the inner is done; `next` is the post-delegation successor.
3. **Runtime (`yield-star` case).** On entry: if `deleg_<n>` null, materialize
   the inner (`compileExpression(subject)` → inner `_new`) and `struct.set` it.
   `call __gen_resume_<inner>(deleg_<n>)` → `res`. If `res.done==0`: store outer
   spills + slot, state = THIS id, build `{res.value, done:0}`, `br exit`
   (suspend). Else: clear `deleg_<n>`, `setState(next)`, `br loop` (the `yield*`
   expression value is the inner's return value — bind if `bindSentTo`).
4. **§27.5.3.7 forwarding.** Slice-1: thread outer `sent` → inner `sent` before
   the inner resume call (`.next(v)` forwarding). `.return()`/`.throw()`
   delegation is a SEPARATE slice; until then an outer `.return()` mid-delegation
   runs only the outer finalizers (document the gap).

### Test gates
New `tests/issue-2170-*.test.ts` + flip the SF-3 `it.todo`:
`function* inner(){yield 1;yield 2;} function* g(){yield* inner();yield 3;}` →
standalone `[...g()] === [1,2,3]`, ZERO host imports (assert on
`result.imports`).

### Why staged
The f64→typed-spill struct extension is the regression-prone part (the entire
f64 spill path assumes homogeneous f64 fields). Land struct-layout + single
`yield* <native-gen-call>` terminator first with the repro as a gate; add
general-iterable delegation (#1320 bridge) and `.return()/.throw()` forwarding as
follow-up slices. Do NOT widen all spills to a tagged union in one pass (the #618
big-bang-shift lesson). Released back to `ready` with this plan so a focused
effort can execute it cleanly.

## PR-1 landed (2026-06-15, sdev3) — slice-1: yield* <native-generator-call>

Implemented the plan above (`src/codegen/generators-native.ts` + the
`NativeGeneratorInfo.delegationSlots` field in `context/types.ts`):

- **Terminator** `{ kind: "yield-star"; subject; innerName; siteIndex; next }`
  added to `StateTerminator`. `emitYield` emits it when `yieldExpr.asteriskToken`
  and the subject is a no-arg call to a native-generator declaration
  (`nativeGeneratorDelegationName` resolves the callee symbol → its
  `FunctionDeclaration` → `isNativeGeneratorCandidate`). Anything else
  (arbitrary iterable, `x = yield* …` binding form, args) still `fail()`s to the
  host path. `suspendCount`/candidate checks now count yield-star states.
- **State struct** gains one `ref null $InnerState` mutable `deleg_<n>` field per
  delegation site, appended AFTER the f64 spills so `spillFieldOffset+i`
  indexing is untouched (the f64-only spill path is the regression-prone part —
  left alone). `compileNativeGeneratorFunction` pushes `ref.null` for each
  delegation slot at construction.
- **Runtime** (`compileState` `yield-star` arm): on entry, lazily materialize the
  inner (`compileNativeGeneratorFunction(inner)`) into the slot if null; drive
  `__gen_resume_<inner>(slot)`; if `innerRes.done==0` re-yield `innerRes.value`
  staying in THIS state (self-suspend → next `.next()` re-drives the inner);
  else null the slot, advance to `next`, re-enter the dispatch loop. §27.5.3.7
  iteration semantics for the common path.

**Verified standalone, ZERO host imports:** delegate-then-yield (→6),
yield-before-delegation (→10), delegation-only (→11), two sequential
delegations (→6), element-count across the boundary (→4), manual `next()`
ordering (inner values first). Tests: `tests/issue-2170-yield-star-delegation.test.ts`
(6 cases) + the #2157 SF-3 `it.todo` flipped to a passing `it`. `generators.test`
+ #2157 regression guards unchanged; tsc/lint/format clean; zero host-mode
regressions (the new terminator is reachable only on `yield*`).

**Deferred (follow-up slices, NOT this PR):**
- General-iterable delegation (`yield* [1,2,3]` / `yield* customIterable`) —
  needs the #1320 standalone `__iterator`/`__iterator_next` bridge instead of a
  direct native-generator resume call.
- `x = yield* inner()` binding the inner's return value (§27.5.3.7's
  return-value step) — currently bails.
- `.return()`/`.throw()` delegation into the inner during iteration — an outer
  `.return()` mid-delegation currently runs only the outer finalizers.
- Empty inner generator (no yields) isn't a native-generator candidate, so
  `yield* emptyGen()` bails to the host path (pre-existing native-generator
  limitation, not specific to yield*).
