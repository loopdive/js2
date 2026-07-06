---
id: 3076
title: "Host-mode nested-scope closure dispatch drops the call → ~1480 vacuous TypedArray harness fails; correct 1-line fix is gate-blocked by partial-vacuity dishonest passes + unimplemented resizable-ArrayBuffer / dynamic-ctor features"
status: ready
created: 2026-07-06
updated: 2026-07-06
assignee: null
priority: high
feasibility: hard
model: fable
reasoning_effort: max
task_type: bugfix+metric-integrity
area: codegen
language_feature: closures, dynamic-dispatch, typed-arrays, test262-harness, metric-integrity
goal: host-independence
related: [2939, 2940, 2463, 3001, 3004]
umbrella: 2860
---

# #3076 — host-lane nested-scope closure dispatch drops the call (correct fix, blocked on sequencing)

## TL;DR

There is a **general host-mode codegen bug**: a closure literal defined **inside
a function body** and passed to a WASM higher-order function that invokes it
dynamically (`fn(...)`) has its **call silently dropped at compile time**
(`drop; ref.null.extern`), so the closure body never runs. This is the host-lane
twin of the standalone bug #2939/#2940 fixed — but the #2939 pre-registration fix
was **`ctx.standalone`-gated**, so the host (default gc) lane is still broken.

The fix is **one line** (ungate the pre-registration; see Patch) and it is
**validated** to work. BUT it **cannot ship as a bounded PR**: it converts a
large population of *dishonest* host passes (top-level assertion passed while the
harness callback body stayed dead) into *honest* fails, because the now-live
callback bodies hit **unimplemented features** (resizable ArrayBuffers,
`TA.BYTES_PER_ELEMENT` on a dynamically-passed constructor). Measured ~82
`pass→fail` regressions (bucket `RangeError: Invalid array buffer length` alone
>50) — far over the merge-gate thresholds. Landing it requires sequencing with a
**partial-vacuity metric reclassification** (extends #2463) and/or the exposed
feature work.

## Root cause (fully traced, current main @ a8607b4)

Minimal repro (host / default gc lane):

```ts
let count = 0;
function apply(fn: any): void { fn(10); fn(20); }
export function test(): number {
  apply(function (x: any) { count = count + 1; });  // closure defined INSIDE test()
  return count;                                      // returns 0 — should be 2
}
```

- Closure defined at **module top-level** and passed to `apply` → **works** (2).
- Closure defined **inside a function** (inline OR `const cb = …; apply(cb)`) →
  **call dropped** (0).

WAT of `apply` in the broken case: `drop; ref.null.extern; drop` — the `fn(10)` /
`fn(20)` invocations are compiled away entirely.

Mechanism: `fn(...)` on an `any`-typed param routes to
`tryEmitInlineDynamicCall` (`src/codegen/expressions/calls.ts:14048`), which
builds its `ref.test`/`call_ref` arms from `ctx.closureInfoByTypeIdx` — the
wrapper types registered **so far**. A nested-scope callback registers its
funcref-wrapper only **lazily** at its value site, which compiles **after** the
higher-order function `apply`. So `apply`'s dispatch sees **zero candidates** and
falls through to the graceful fallback (`calls.ts:14051-14060`: compile args for
side-effects, `drop`, push `ref.null.extern`) — the call is dropped.

#2939 added an **eager pre-registration** pass (`calls.ts` ~L2875) that visits
every func-expr/arrow used as a call-arg / var-init and pre-registers its
all-externref wrapper type up front — but wrapped it in `if (ctx.standalone)`.
So the host lane never pre-registers → still broken. This is precisely the
**927 built-ins/TypedArray + 553 built-ins/TypedArrayConstructors** host-mode
`vacuous: harness-wrapper callback never executed` fails (baseline 2026-07-05):
the test262 `testWith*TypedArrayConstructors(function (TA) { … })` wrapper is a
WASM higher-order function; its callback is defined inside `export function
test()`; the `fn(ctor)` dispatch drops.

## The fix (validated)

`src/codegen/expressions/calls.ts` — remove the `ctx.standalone` gate around the
nested-scope func-expr/arrow pre-registration block (change `if (ctx.standalone) {`
to run on both lanes; the narrow all-externref shape restriction stays). The
branch `issue-3076-host-nested-closure-vacuous` holds this exact change +
updated comments. **Do NOT merge it alone** (see below).

Verified: the 3 sampled vacuous tests
(`ctors/length-arg/is-negative-integer-throws-rangeerror`,
`ctors/object-arg/length-excessive-throws`, `prototype/length/inherited`) flip
`fail(vacuous) → pass`. `tsc --noEmit` clean.

Pre-registering a wrapper type does **not** redirect any call site: the
inline-dispatch-vs-`__make_callback` choice is made by the CALLEE (wasm fn vs
host builtin), never by whether a wrapper type exists — it only gives the
already-emitted inline dispatch a candidate to match.

## Why it is gate-blocked (measured, isolated-process runs on current main)

The base host "passes" for these harness tests are **DISHONEST**: a top-level
assertion (`assert.sameValue(typeof ArrayBuffer.prototype.resize, "function")`)
bumps `__assert_count` to 2 (so the #2940 vacuity gate — which only fires on
`__assert_count === 1` — does NOT catch them), while the real test body (the
`testWith*` callback) is dead. My fix makes the callback run, and it then hits
unimplemented functionality and **honestly fails**.

- **Win side** — vacuous(`fail`) → `pass`: sampled 90 vacuous tests → **14 flip
  to pass** (~16%). Extrapolated ≈ **230 / 1480** vacuous → pass. (The other ~71
  stay `fail`: body now runs but genuinely fails — no metric change.)
- **Loss side** — dishonest `pass` → honest `fail`: of the **95** baseline-`pass`
  TypedArray tests that use the harness wrapper, a 60-sample showed **52 flip to
  fail** (~87%). Extrapolated ≈ **82 pass→fail regressions**. Dominant buckets:
  `RangeError: Invalid array buffer length` (resizable ArrayBuffers, e.g.
  `new ArrayBuffer(BPE*4, {maxByteLength: BPE*5})`, and/or `TA.BYTES_PER_ELEMENT`
  reading `undefined` off the dynamically-passed constructor → `NaN` length) and
  a few `Object.defineProperty called on non-object`.

Net honest conformance ≈ **+148** (+230 wins − 82 losses), but the merge gate
does not score net honesty — it hard-blocks on the ~82 `pass→fail` (single
bucket >50, total >10). The baseline validator (50 random `pass` spot-checks)
would also fail if it samples any of these.

## What it is blocked on (sequencing — this is an epic, not a slice)

The codegen fix is correct and should land, but only **paired** with:

1. **Partial-vacuity metric reclassification** (extends #2463 / #3001 / #3004).
   #2463 reclassified *fully*-vacuous passes (`__assert_count === 1`) as `fail`.
   The **partial**-vacuity case — a top-level assertion ran but the
   `testWith*`/callback body ran **zero** assertions — is un-addressed. The
   runner would need to track "assertions counted since the last
   `__harness_cb_expected` bump" and mark a callback that ran none as vacuous, so
   these dishonest passes are honestly scored as (excused) vacuous BEFORE the
   codegen fix flips them to real fails. This is a deliberate metric-policy change
   (owner/architect sign-off, like #2463 was) — NOT a unilateral dev edit.
2. **Feature gaps the fix exposes** (independent, pre-existing):
   - Resizable / growable ArrayBuffers (`new ArrayBuffer(len, {maxByteLength})`,
     `ArrayBuffer.prototype.resize`) — a large ES2024 feature.
   - Static-property read off a **dynamically-passed constructor value**
     (`TA.BYTES_PER_ELEMENT`, `TA.BYTES_PER_ELEMENT` where `TA` is an `any`-typed
     param bound to `Int8Array`…). Likely returns `undefined` today → `NaN`
     length.

Recommended order: (1) land the partial-vacuity reclassification (metric turns
these dishonest passes into excused vacuous — a controlled downward metric
correction), THEN (2) land this codegen fix (flips a big slice vacuous→pass with
no gate collateral, since the losses are already reclassified), THEN (3) chip at
the exposed feature gaps to convert the remaining honest fails to passes.

## Repro / evidence

- Minimal codegen repro: `apply(function(x){count++})` inside a function → 0.
- Full harness repro: `wrapTest()` output of
  `built-ins/TypedArrayConstructors/ctors/length-arg/is-negative-integer-throws-rangeerror.js`
  returns `-262` (vacuous) on base; `pass` with the fix.
- Loss repro: `built-ins/TypedArray/prototype/length/resizable-array-buffer-fixed.js`
  — base `pass` (dishonest, dead callback), fix `fail`
  (`RangeError: Invalid array buffer length`).

## Notes

Umbrella #2860 (standalone-vs-host gap) is the sibling axis; this is the same
compile-order/closure-dispatch root as #2939/#2940 but on the **host** lane, with
the added metric-integrity entanglement (#2463 family) that makes it an epic.
