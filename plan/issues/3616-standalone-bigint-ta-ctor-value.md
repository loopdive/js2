---
id: 3616
title: "standalone: BigInt64Array / BigUint64Array are null in VALUE position — 627 type_error rows"
status: done
assignee: ttraenkler/opus-typeerror-lane
created: 2026-07-25
updated: 2026-07-30
completed: 2026-07-25
priority: high
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: multi
language_feature: typedarray
goal: standalone
umbrella: 2860
sprint: 77
horizon: m
related: [2401, 838, 3054, 3087, 3177, 1349]
origin: "opus-typeerror-lane triage of the post-#3592 standalone type_error family (3,038 rows), 2026-07-25"
# loc-budget-allow (#3616): src/codegen/dataview-native.ts +25. This file OWNS
# the runtime-kind TypedArray dispatch (TA_VIEW_DECODE, emitDynDecodeDispatch,
# emitDynEncodeDispatch, emitTaCtorValue). The change is two table rows plus the
# int64 flag threaded through the two dispatch builders — an in-place extension
# of this subsystem's own per-kind tables, exactly the shape #3177 was granted.
# Splitting two Record rows into a new module would leave the dispatch loop
# reading its descriptors from somewhere other than the table it iterates.
loc-budget-allow:
  - src/codegen/dataview-native.ts
standalone-devacuification-allow:
  count: 30
  reason: "#3616: making BigInt64Array/BigUint64Array real VALUES in standalone
    de-vacuifies the test262 `testWithBigIntTypedArrayConstructors` harness. Its
    callbacks previously received a null TA, so `new TA(...)` was null and every
    callback body was dead — the row passed without asserting anything. With a
    real ctor the bodies execute and pre-existing downstream defects surface as
    ordinary honest assertion failures. Measured basis: a 22-row deterministic
    stride sample of the BigInt TypedArray corpus (14 baseline-fail + 8
    baseline-pass) gave 2 fail->pass gains and 1 pass->fail flip, i.e. 1 of 8
    sampled baseline-passes (12.5%); the corpus holds 28 baseline passes, so the
    point estimate is ~4 flips. The sole observed flip
    (TypedArray/prototype/byteLength/BigInt/resizable-array-buffer-fixed.js) was
    verified through the CI-equivalent path (assembleOriginalHarness ->
    CompilerPool('unified') -> test262-worker.mjs) and is category
    `assertion_fail` — NOT a trap category — reading `Test262Error: following
    shrink (out of bounds) Expected SameValue(«16», «0») to be true`, i.e. a
    genuine pre-existing byteLength-after-out-of-bounds-resize defect the vacuous
    pass never reached. No `tests:` list is needed because no pass->trap flip was
    observed; any trap flip remains unexcused and still hard-fails #3189. The
    ceiling of 30 covers the wide binomial interval on n=8 (upper bound ~15 over
    the 28-pass BigInt corpus) plus margin for the two extra
    ensureTypedArrayViewNativeProtoGlue registrations now performed by the
    TA_CTOR_KINDS-driven loops in any module carrying a dynamic TA view."
---

# #3616 — standalone: BigInt TypedArray constructors are `null` in VALUE position

## Problem

Under `--target standalone`, `BigInt64Array` and `BigUint64Array` used in
**value position** (not `new X()`, not type position) evaluate to
`ref.null.extern`. Direct construction already works — #838 landed the native
i64-element vec, so `new BigInt64Array(4).length === 4` — but

```ts
const ctors: any[] = [BigInt64Array, BigUint64Array]; // → [null, null]
const TA = ctors[0];
const s = new TA(4); // → null
s.length; // TypeError: Cannot access property on null or undefined
```

### Root cause

`src/codegen/expressions/identifiers.ts:1220` gates the first-class
`$__ta_ctor` value emission on `taCtorKindOf(name) >= 0`. `taCtorKindOf`
(`src/codegen/registry/types.ts`) indexes `TA_CTOR_KINDS`, which listed only the
**9 non-BigInt** views. Both BigInt names therefore missed the gate and fell
through to the `reportSilentFallback("const-fallback",
"identifiers:unimplemented-global-default")` default at line 1248, which emits
`ref.null.extern`.

The host/gc lane was already fixed by **#3087** — `identifiers.ts:834-862`
routes the same two names through `__extern_get(globalThis, name)`, and its
comment says outright _"Covers the BigInt views too (not in the standalone
`taCtorKindOf` list). Standalone/WASI keeps the native `$__ta_ctor` value
below"_. The native path never grew the BigInt kinds, so only the host-free lane
was left behind.

This is a **third residual of #2401**, distinct from the two already recorded
there (its (a) `BUILTIN_TYPES` method routing and (b) unsigned i64 semantics).

### Why it costs 627 tests

The test262 runner's BigInt harness shim (`tests/test262-runner.ts:2157`) is

```ts
function testWithBigIntTypedArrayConstructors(fn: any): void {
  const constructors = [BigInt64Array, BigUint64Array];
  for (let i = 0; i < constructors.length; i++) fn(constructors[i], __ta_makeCtorArgBigIntCompat);
}
```

so `TA` is `null` in every callback, `new TA(...)` yields null, and the reported
failure is whatever member the test touches next. 627 of the 1,128 standalone
`TypeError: Cannot access property on null or undefined at N:N` rows sit under
BigInt TypedArray paths. Corpus size in the post-#3592 merged standalone
artifact: **pass 28 · fail 685 · compile_error 64**.

## Scope

Structure only. Element **values** in a dynamically-constructed BigInt view stay
on the f64 carrier the rest of the dyn-view substrate uses, NOT i64-branded
BigInts — that representation split is #1349 / #2401(b) and is deliberately out
of scope. This issue buys the non-null identity-stable constructor, the correct
8-byte element width, and working `length` / `byteLength` / MOP, which is what
the harness rows actually gate on. Content assertions keep failing honestly.

## Fix

1. `src/codegen/registry/types.ts` — **append** (never insert) `BigInt64Array`,
   `BigUint64Array` to `TA_CTOR_KINDS` as kinds 9/10, and `8, 8` to
   `TA_CTOR_BYTES`. Appending is load-bearing: the `kind` index is baked into
   the `$__ta_ctor` singleton globals and into every `if`-chain arm of the
   decode / encode / `BYTES_PER_ELEMENT` dispatches, so an insertion would
   silently repoint every existing kind.
2. `src/codegen/dataview-native.ts` — two `TA_VIEW_DECODE` rows with
   `bytes: 8, float: false, int64: true` (signed / unsigned). The `int64` flag
   is required: without it an 8-byte non-float read takes the
   `f64.reinterpret_i64` path, which is correct for `Float64Array` and garbage
   for an integer view. The rows are **inert for the static lane** —
   `taViewDecode` resolves names via `getTaViewName` over `ctx.taViewTypeMap`,
   and #838 gave the BigInt views a native i64 vec rather than a
   `$__ta_view_<name>`, so no static BigInt view type is ever registered.
3. Same file — `emitDynDecodeDispatch` / `emitDynEncodeDispatch` thread
   `int64: desc.int64` into `emitReadBytes` / `emitWriteBytes`; the decode arm
   appends `f64.convert_i64_s` / `_u` after the read. Necessary because
   `emitReadBytes` deliberately LEAVES the i64 on the stack for an `int64`
   accessor (that is the DataView `getBigInt64` BigInt carrier), while every arm
   of this dispatch's `if` is typed `f64` — the BigInt arms must converge to the
   same carrier. Convert, not reinterpret.

`f64.convert_i64_s` / `_u` are already in the `Instr` union
(`src/ir/types.ts:258-259`); no union extension needed.

## Acceptance criteria

- Standalone: `[BigInt64Array, BigUint64Array]` contains two distinct non-null
  values; `BigInt64Array === BigInt64Array` (singleton identity holds via the
  `$__ta_ctor` per-kind global, as #3177 established for the other 9).
- Standalone: `const TA = ctors[i]; new TA(4)` is non-null with `.length === 4`
  and `TA.BYTES_PER_ELEMENT === 8` for both BigInt views.
- Measured before/after count on a stride sample of the BigInt TypedArray
  corpus, net positive, recorded below.
- JS-host lane byte-neutral (the change is gated behind the standalone-only
  `emitTaCtorValue` path; the host lane keeps #3087's `__extern_get` route).

## Verification probes

Standalone lane, via `.tmp/p1.mts` (note `compile()` is async):

- `.tmp/t5.ts` — six ctor names in an array. **Before: returns 104**
  (`names[4]`, i.e. `BigInt64Array`, is `null`). **After: returns 1** — all six
  non-null and dynamic `new TA(4)` gives `.length === 4` for each.
- `.tmp/t2.ts` / `.tmp/t3.ts` — reproduce the exact harness shape; returned 21
  ("sample is null") before the fix.
- `.tmp/t1.ts` — direct `new BigInt64Array(4)` already worked before the fix,
  isolating the defect to the VALUE-position path.

## Adjacent finding (NOT this issue)

`new names[i](4)` — `new` applied directly to an element-access callee —
returns null even for the **non-BigInt** views, while
`const TA = names[i]; new TA(4)` works (`.tmp/t6.ts`). Separate, narrower gap;
the test262 harness uses the working shape, so the yield is low. File separately
if anyone wants it.

## Test Results — measured, and WEAKER than the root cause implied

22-test deterministic stride sample of the BigInt TypedArray corpus (14 drawn
from the `fail` population, 8 from `pass`), standalone lane, single-threaded.
BEFORE reproduced the CI artifact exactly (14 fail / 8 pass), so the local
harness is faithful **for this cluster**.

|      | before | after |
| ---- | ------ | ----- |
| fail | 14     | 13    |
| pass | 8      | 9     |

**Gross +2 fixed, −1 regressed, net +1. 19 of 22 unchanged.**

Fixed (both were `fail` → `pass`):

- `TypedArrayConstructors/internals/GetOwnProperty/BigInt/key-is-not-canonical-index.js`
- `TypedArrayConstructors/ctors-bigint/object-arg/undefined-newtarget-throws.js`

Regressed (`pass` → `fail`):

- `TypedArray/prototype/byteLength/BigInt/resizable-array-buffer-fixed.js`

### The honest reading

The hit rate is **2 of 14 failing rows (14 %)**, not the near-total conversion
the 627-row root cause suggested. The null constructor was **necessary but not
sufficient**: most BigInt rows fail for further downstream reasons that surface
only once the ctor is real. Naive extrapolation over the 685-row failing corpus
gives roughly +98 gains and, at 1-in-8 of the 28 passes, roughly −3 to −4
regressions — net positive but modest, and the confidence interval on 2/14 is
very wide (~2 %–43 %).

### Do NOT read 627 as a forecast

The 627-row cluster identified in "Why it costs 627 tests" is the population
that _shares this root cause_, **not** the number of rows this fix converts.
At a 14 % sampled hit rate the expected conversion is on the order of ~100.
The null constructor is the FIRST rung of a ladder: removing it lets each row
proceed to whatever defect sits behind it, and for ~6 of 7 rows that next defect
is still fatal. Anyone planning follow-up work should treat the remaining BigInt
corpus as a stack of distinct downstream defects needing their own triage, not
as residue of this one.

### The regression, resolved: an honest de-vacuification (CONFIRMED)

Initially unclassifiable locally, and recorded here as an open question rather
than a guess. It is now settled by re-running the row through the
**CI-equivalent path** (`assembleOriginalHarness` → `CompilerPool(1, "unified")`
→ `scripts/test262-worker.mjs`, harness `.tmp/run-pool.mts`):

```
status   : fail
error    : Test262Error: following shrink (out of bounds) Expected SameValue(«16», «0») to be true
category : assertion_fail
frame    : null
dispIntro: false
```

Three conclusions:

1. **The earlier "frameless / `other`" reading was a `runTest262File` artifact,
   not a property of the row.** That runner does not use `tryNativeExnRender`,
   so the payload rendered as `uncaught Wasm-GC exception (non-stringifiable
payload)` and mis-classified as `other`. The CI path renders the real
   `Test262Error`.
2. **The `at L16` attribution was also an artifact.** The real failure is deep
   in the harness callback (`assert.sameValue(array.byteLength, expected,
"following shrink (out of bounds)")`), not at the top-level
   `typeof ArrayBuffer.prototype.resize` assertion. This **confirms** the
   previously-hypothesised second-order mechanism: with a real ctor the callback
   goes live and a pre-existing `byteLength`-after-out-of-bounds-resize defect
   surfaces. The row was a **vacuous pass** — TA was null, so the entire callback
   body was dead and nothing was asserted.
3. **`assertion_fail` is not in `TRAP_ERROR_CATEGORIES`**
   (`["null_deref", "illegal_cast", "oob", "unreachable"]`, `scripts/diff-test262.ts:246`),
   so `isDevacuificationExcusableFlip` returns true under the declared ceiling
   alone — the frame check applies only to trap-tier rows and is irrelevant
   here. The #3189 trap ratchet never engages.

The `standalone-devacuification-allow` ceiling declared in this file's
frontmatter covers it. No `tests:` list is required (that is the trap tier); a
pass→trap flip would still be unexcused and would still hard-fail #3189.

### Superseded: why this was briefly blocked

`resizable-array-buffer-fixed.js` now throws at L16,
`assert.sameValue(typeof ArrayBuffer.prototype.resize, "function")` — a
**top-level** assertion that has nothing to do with BigInt constructors.
Investigated rather than assumed:

- A standalone probe of `typeof ArrayBuffer.prototype.resize` **throws on the
  PRE-change compiler too** (`.tmp/t8.ts`, verified by reverting both source
  files to `HEAD~2` and re-running). So the throwing read is **pre-existing**,
  not introduced here.
- The probes therefore do NOT reproduce the row's flip — the test module's
  composition differs. The plausible mechanism is second-order: with a real
  ctor the harness callback goes live, `ab.resize(...)` becomes reachable, and
  the ArrayBuffer proto glue is registered differently, so the pre-existing
  `resize` value-read gap becomes reachable. That would make the flip a
  **consequence of de-vacuification** over a pre-existing defect — but this is
  a hypothesis, not a verified finding, and it is not being recorded as one.
- The payload is opaque locally: `tryNativeExnRender` returns null, so the row
  reads as `uncaught Wasm-GC exception (non-stringifiable payload)` →
  `classifyError` = `other`, `trapInnermostFrame` = **null (frameless)**.

That last point is the blocker. Per `DEVACUIFICATION_ALLOW_KEY` in
`scripts/diff-test262.ts`, a non-trap `pass → fail` flip is excusable under a
declared ceiling alone — but **"a frameless trap message cannot be verified and
is NOT excused."** The local renderer is the known-weak one (it is why the
message is opaque at all); CI's `describeWasmError` may well classify this row
into a trap category. If it does, and the frame is still unextractable, the row
hard-fails the #3189 ratchet and **no declaration can excuse it**. I cannot
settle that locally.

### Consequence

Resolved — landing with the declared ceiling. The `merge_group` standalone floor
gate is the authoritative measurement of the real gain/regression counts; the
local sample's job was only to establish direction and to classify the flip
tier, and it has done both.

**Lesson worth keeping:** `runTest262File` is not the CI path and must not be
used to classify a standalone failure's _category_ or _location_ — only its
pass/fail status is trustworthy. Classification questions go through
`assembleOriginalHarness` → `CompilerPool(n, "unified")` →
`scripts/test262-worker.mjs` (see `.tmp/run-pool.mts`; it needs
`scripts/compiler-bundle.mjs` + `scripts/runtime-bundle.mjs`, both gitignored,
built with the two `esbuild` commands recorded in the assertion_fail lane's
context dump).

## Source

`opus-typeerror-lane` triage of the post-#3592 standalone `type_error` family
(3,038 rows), 2026-07-25.
