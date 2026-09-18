---
id: 6501
title: "ES2015 standalone: the four TypedArray methods with a dedicated dyn-view helper bypass #5961's ValidateTypedArray guard"
status: done
sprint: current
created: 2026-09-17
updated: 2026-09-17
completed: 2026-09-17
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: conformance
area: codegen
es_edition: ES2015
goal: standalone-mode
requested_by: ttraenkler/fable-es2015
model: opus
related: [1645, 5961, 6500]
# 2026-09-17 (#6501): +5 lines in `call-receiver-method.ts`, which starts this
# change-set exactly AT its 4700-line ceiling, so any fix routed through this
# file needs a grant. The whole mechanism — the guard adapter, why it must sit
# after argument evaluation and before the helper, and the local-naming
# constraint — was put in the subsystem module `src/codegen/ta-dyn-method-call.ts`
# (+77 there, no ceiling). What is left in the god-file is the irreducible
# remainder: one import, one call, one array literal, and a three-line comment
# pointing at the mechanism. This is the ONLY site in the compiler that routes
# `set`/`fill`/`copyWithin`/`reverse` to their `__ta_dyn_<m>` helper, so the
# call cannot be moved anywhere else.
loc-budget-allow:
  - src/codegen/expressions/call-receiver-method.ts
# 2026-09-17 (#6501): +4 in `compileReceiverMethodCall`, the same five lines
# counted against the same function — two statements replacing one, plus the
# three-line comment that says the guard must NOT be moved out of this position
# (before it, argument evaluation has not happened, which violates §13.3.6;
# after it, the helper's ToNumber has already thrown). Splitting the function is
# out of scope for a conformance fix and is tracked as its own consolidation
# work in plan/log/compiler-consolidation-plan.md.
func-budget-allow:
  - src/codegen/expressions/call-receiver-method.ts::compileReceiverMethodCall
---

# Four methods never reach the detached-buffer guard

#5961 gave `$__ta_dyn_view` receivers the §23.2.4.4 ValidateTypedArray
prologue and banked +9 rows. The prologue lives on the **generic
`__call_m_<name>_<arity>` dispatcher** (`closed-method-dispatch.ts`), so it
covers every method that has no dedicated helper.

**Four methods have one, and therefore never reach it.**
`call-receiver-method.ts` (~line 4090) routes them to a native helper at the
call site instead:

```ts
if (methodName === "set")                          taSetIdx  = ensureTaDynSetHelper(ctx);
else if (arity <= 3 && methodName === "fill")      taFillIdx = ensureTaDynFillHelper(ctx);
else if (arity <= 3 && methodName === "copyWithin")taFillIdx = ensureTaDynCopyWithinHelper(ctx);
else if (arity <= 3 && methodName === "reverse")   taFillIdx = ensureTaDynReverseHelper(ctx);
```

`reverse` is even listed in `TA_DYN_VALIDATE_METHOD_NAMES` already — the list
is right, the path simply never consults it.

## Measured — `--isolate`, `--target standalone`, main @ `f5506015f9`

| row | result | routes via |
| --- | --- | --- |
| `sort/detached-buffer.js` | **pass** | generic dispatcher (#5961's guard) |
| `slice/detached-buffer.js` | **pass** | generic dispatcher |
| `reverse/detached-buffer.js` | **fail** — no exception | `ensureTaDynReverseHelper` |
| `fill/detached-buffer.js` | **fail** | `ensureTaDynFillHelper` |
| `copyWithin/detached-buffer.js` | **fail** | `ensureTaDynCopyWithinHelper` |

The two that pass are the control: they prove the guard works and that the
difference is purely which path the method takes.

## Why the dynamic shape is the one that matters

test262 does not call these on a statically-typed receiver. Every row goes
through `testWithTypedArrayConstructors(function (TA, makeCtorArg) { … })`, so
`TA` is a **parameter** and `new TA(makeCtorArg(0))` produces a
`$__ta_dyn_view`. A probe written as `new Float64Array(8).fill(…)` takes the
static path and looks fine — that is why this survived #5961. **Probe with a
dynamic constructor or the measurement is meaningless.**

## `reverse` additionally needs #6500

On main, `reverse` on a **packed** receiver (`Uint8Array`, `Int8Array`,
`Uint8ClampedArray`, `Uint16Array`, `Int16Array`) fails binary emit outright —
a compile-time kill, fixed in #6500 and a prerequisite here. This issue's
branch is stacked on #6500 for that reason.

## Implementation Plan

`taDynDetachedGuardInstrs(ctx, method, anyLocalIdx, pushLocal)` in
`ta-dyn-method-call.ts` is **already reusable** — #5961 wrote it as a free
function precisely so a second call site could adopt it. It needs the receiver
in an **anyref** local; the helper call site already materialises `recvLocal`
as an **externref**, so the adaptation is `any.convert_extern` into a fresh
local, then splice the returned `Instr[]` ahead of the helper call.

Preserve the guard's existing self-imposed limits — they are deliberate and
documented in its body:

- it declines unless `ctx.standalone` and `ctx.taDynViewTypeIdx >= 0`;
- it declines when `__new_TypeError` is not already in `funcMap` (no minting,
  no `ensureLateImport`, at a seam where either would shift funcIdxs);
- it fires only on the `-1` detach marker, unreachable for a live buffer.

`set` has a different signature from the other three (`taSetIdx` vs
`taFillIdx`) but shares the `(recv, v1, v2, v3, argc)` shape at the emit block;
check whether one splice covers all four or whether `set` needs its own, and
say which.

## Acceptance

1. `reverse`, `fill`, `copyWithin` detached rows pass; `sort` and `slice` stay
   passing (they must not change at all — they do not go through this path).
2. Measured on **both** a merge-base tree and the branch, same
   `.test262-cache` symlinked into both: the full
   `built-ins/TypedArray/prototype/{reverse,fill,copyWithin,set}` directories,
   plus a `built-ins/TypedArray` control sample. **Zero rows lost** — the
   per-test edition ratchet fails the required check on a single
   pass→not-pass in ES2015, with no waiver.
3. A live (non-detached) `fill`/`copyWithin`/`reverse`/`set` on a dyn view
   still mutates correctly and returns `this` — the guard must be inert on a
   live buffer. Pin this; it is the regression the splice could cause.
4. `result.imports` stays `[]`; the gc/host lane stays byte-identical.
5. All gates exit 0, run bare.

## Implementation notes (2026-09-17)

### What shipped

`taDynDetachedGuardPrologue` in `src/codegen/ta-dyn-method-call.ts` — the #5961
guard adapted for a caller holding the receiver as an **externref** local
(`any.convert_extern` into a fresh `anyref` local, then the existing
`taDynDetachedGuardInstrs`). `call-receiver-method.ts` splices it at the head
of the `ref.test $__ta_dyn_view` arm of the #2872 two-arm. The guard's
self-imposed limits are unchanged; they were only lifted out of
`taDynDetachedGuardInstrs` into a private `taDynDetachedGuardApplies` so the
adapter can decide **before** allocating a local it might not need.

### One splice covers all four — `set` did not need its own

The plan left this open. The emit block already coalesces the two index
variables (`const taDynMethodIdx = taSetIdx ?? taFillIdx`), so `set` shares the
receiver/argument materialisation, the `ref.test` and the `thenArm` with the
other three; the guard is keyed on `methodName`, and `set` is already in
`TA_DYN_VALIDATE_METHOD_NAMES`. Measured: `set`'s 41 non-pass rows are the same
41 before and after — it gains nothing and loses nothing. Its five
detached-named rows (`array-arg-targetbuffer-detached-throws.js` and friends)
**already passed** on base, because they detach *during* argument coercion,
which is a later check inside the helper rather than the §23.2.4.4 prologue.

### The one thing the plan got wrong: "ahead of the helper call" is not enough

The plan says to splice the guard "ahead of the helper call". Ahead of the
*call* is right, but the position also has to be **after argument evaluation**,
and that is not a free choice — it is what makes two of the three rows pass.
`fill` and `copyWithin` failed on base with `Expected a TypeError but got a
Test262Error`, not with "no exception at all": their rows pass an object whose
`valueOf` throws, and that throw comes from the **helper's** ToNumber. Put the
guard before the arguments and the ordering violates §13.3.6; put it inside the
helper and the ToNumber has already run. The head of `thenArm` is the only
position that satisfies both.

### A local NAME is load-bearing here (surprising, documented in the code)

`deduplicateLocals` (`src/codegen/context/locals.ts`) merges `__`-prefixed
temps that share a name **and** a type into one slot, then compacts the locals
vector. The guard's buffer local therefore keeps its bare `__tadyn_det_buf`
spelling rather than the `_${locals.length}` suffix its neighbours at the call
site use: on a four-call probe the bare name is **12 bytes** of code section
smaller (4 sites × 3). It is sound because the local is written immediately
before it is read and is dead between sites. This cost a bisect to find — a
"consistency" rename would silently give it back.

### Measured — `--isolate --standalone`, base = #6500 tip `92a0d414dc`

Base and branch measured in the SAME worktree (file-copy A/B), same symlinked
`test262` corpus and `.test262-cache`, so the trees differ only in the diff.

The five named rows:

| row | base | branch |
| --- | --- | --- |
| `reverse/detached-buffer.js` | fail — *no exception at all* | **pass** |
| `fill/detached-buffer.js` | fail — *TypeError expected, Test262Error* | **pass** |
| `copyWithin/detached-buffer.js` | fail — *TypeError expected, Test262Error* | **pass** |
| `sort/detached-buffer.js` | pass | pass (control, unchanged) |
| `slice/detached-buffer.js` | pass | pass (control, unchanged) |

Full `{reverse,fill,copyWithin,set}` directories, 249 rows, two chunks:

| | base | branch |
| --- | --- | --- |
| pass | 158 | **164** |
| fail | 82 | 76 |
| compile_error | 9 | 9 |

Per-test (not per-count) diff: **6 fixed, 0 lost.** The six are
`{reverse,fill,copyWithin}/detached-buffer.js` and their three `BigInt/`
twins — the BigInt variants were a bonus, they take the same call-site route.

Rows that pointedly did **not** flip, and should not have:
`copyWithin/coerced-values-{start,end}-detached.js` and
`coerced-values-end-detached-prototype.js` detach *inside* an argument's
`valueOf`, i.e. after ValidateTypedArray has legitimately passed. That is a
re-validation gap in the helper, not this guard.

### Byte-identity controls

| probe (sha256 of the whole module) | base | branch |
| --- | --- | --- |
| dyn-TA calling the four mutators, **gc/host** | `0dc5b25c00…` | `0dc5b25c00…` — identical |
| dyn-TA calling only `sort`/`slice`/`subarray`/`at`/`indexOf`/`includes`/`join`, **standalone** | `bcbd52f76a…` | `bcbd52f76a…` — identical |
| dyn-TA calling the four mutators, **standalone** | `86058152ae…` (379,983 B) | `8b5e430ae0…` (380,307 B) |

`result.imports` is `[]` on every standalone probe. The gc lane cannot even
reach this code: `ensureTaDyn*Helper` returns `undefined` unless
`noJsHost(ctx)`, so `taDynMethodIdx` is never defined there — the identical
hash is the proof, not the mechanism. The second row is the stronger control:
a standalone module that uses a dyn view but calls none of the four methods is
byte-identical, which is what makes the `taDynDetachedGuardApplies` extraction
provably a pure refactor of the dispatcher path.

### Live-buffer control (acceptance 3)

A dyn view (`TA` arrives as a parameter) over each of `Uint8Array`,
`Int16Array`, `Float64Array`, `Uint8ClampedArray`, scored 7 ways: `reverse`,
`fill(7,1,3)` and `copyWithin(0,2)` each mutate correctly **and** return the
same object (checked by writing through the returned reference and reading
through the original), and `set([5,6],1)` writes at the offset. **127/127 on
every constructor, on both trees** — the guard is inert on a live buffer.

### Residual

The guard still declines when `__new_TypeError` is not already in `funcMap`
(#5961's deliberate no-mint rule, preserved verbatim). Measured: it does **not**
decline in the test262 shape — `$DETACHBUFFER` + `assert.throws` modules always
have the constructor by then — but a hand-written standalone module with no
other error machinery would silently keep the old behaviour. Same residual
#5961 documented and accepted.
