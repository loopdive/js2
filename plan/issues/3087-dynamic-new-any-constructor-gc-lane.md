---
id: 3087
title: "codegen: dynamic `new TA(...)` on an any-typed constructor value fails on the gc/host lane (No dependency provided for extern class) — dominant honest-fail after #3074"
status: done
completed: 2026-07-09
assignee: ttraenkler/fable-3087
sprint: current
model: opus
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen
language_feature: dynamic-construction, typed-arrays, closures
goal: host-independence
related: [3074, 2939, 2940, 1679, 812, 814, 820, 3097, 1349]
created: 2026-07-07
origin: "2026-07-07 measured under #3074 keystone validation (dev-keystone): after the HOF-callback dispatch fix lands, the harness callback bodies EXECUTE and honest-fail here — the #1 remaining conversion of un-masked bodies to real passes."
---

# #3087 — dynamic `new TA(...)` on an `any`-typed constructor value (gc/host lane)

## Problem

Once #3074 makes the TypedArray harness-wrapper callback dispatch on the gc/host
lane, the callback body runs `new TA(...)` where `TA` is the constructor value
passed positionally into the `any`-typed callback parameter
(`testWith*Constructors(function (TA) { new TA(3); … })`). The compiler treats a
runtime constructor value used in a `NewExpression` callee position as a **host
extern class** needing an import named after the local (`TA`), which does not
exist, so instantiation/execution fails with:

```
No dependency provided for extern class "TA" in __closure_N() at source L..
```

This is the **dominant honest-fail** for the ~1487-file TypedArray harness
cluster after #3074 — i.e. the biggest single remaining blocker to converting
those (now-honestly-failing) bodies into real passes. Measured: every executing
harness file in the #3074 validation samples honest-failed here.

## Why it surfaced now

#3074 (dispatch of an `any`-typed HOF callback on the gc lane) is a prerequisite:
before it, the callback body never ran, so `new TA(...)` was never reached (the
test was vacuous). #3074 makes the body execute; this construction gap is what
it then hits.

## Scope / approach (needs verification-first)

`new (dynamicCtorValue)(args)` where the callee's static type is `any`/externref
must construct via a runtime dispatch, not a static extern-class import:

- Related dynamic-constructor work: #1679 (`compile-acorn-new-this-dynamic-constructor`).
- Related "No dependency provided for extern class" class: #812 (Test262Error),
  #814 (ArrayBuffer).
- On the gc/host lane a host construct-bridge (`Reflect.construct`-style, or a
  `__construct_dynamic(ctorExternref, args)` import) can invoke the real
  constructor value. On standalone the analogous native-construct path is needed
  (the substrate already special-cases some builtin ctors; a general
  any-ctor `new` is the gap).

## Acceptance

- The #3074 keystone-validation harness files whose bodies do `new TA(...)` flip
  from honest-fail ("No dependency provided for extern class TA") to genuine
  pass (or an honest DIFFERENT failure for a truly-unsupported downstream
  semantic), on the gc/host lane.
- No regression in either lane's pass count.

## Notes

Blocks the TypedArray conformance realization gated behind #3074. This is the
recommended highest-value next step after #3074 (#2790) lands.

## Progress — verified partial landing (2026-07-08, dev-ta)

Verify-first traced the actual failure chain on current main (the "No dependency
provided for extern class TA" is one link in a THREE-link chain, not the whole
story). Two of the three links are FIXED in this PR (gc/host lane); the third is
a deeper dispatch-substrate gap documented below.

### Root-cause chain (gc/host lane), each verified with an isolated repro

1. **Dynamic `new <anyCtor>(...)` routing** — `new TA(...)` where `TA` is an
   `any`-typed value reached the unknown-ctor fallthrough and emitted a
   `__new_TA` extern-class import → runtime "No dependency provided for extern
   class TA". **FIXED**: `src/codegen/expressions/new-super.ts` now routes an
   `any`/`unknown`-typed ctor identifier through the existing
   `__construct_closure` host bridge (runtime side already runs the spec
   IsConstructor probe + `Reflect.construct`). Two placements:
   (a) new `resolvesToDynamicAnyCtorValue` predicate + a branch before the
   `__new_${ctorName}` fallthrough (fires when there are no compiled-class
   candidates); (b) the **no-match base** of `emitDynamicNewFallback` (fires when
   compiled-class candidates exist and the runtime tag matches none — the harness
   case, since harness+includes define compiled classes). Verified:
   `function (K) { new K(7) }` with a user ctor value → **PASS**; compiled-class
   dynamic `new` still **PASS** (no regression).
2. **Bare TypedArray ctor as a VALUE on the gc/host lane** — `Int8Array` /
   `constructors[i]` in value position hit `ctx.declaredGlobals` FIRST, which
   maps a bare TA name to a stub host import returning `undefined`, so the ctor
   value was `undefined` (→ "undefined is not a constructor" once link 1 routed
   it to the bridge). **FIXED**: `src/codegen/expressions/identifiers.ts` now
   resolves a bare TA ctor name (incl. `BigInt64Array`/`BigUint64Array`) via
   `__extern_get(__get_globalThis(), name)` — mirroring the #820h ERM pattern —
   placed BEFORE the `declaredGlobals` route. Verified: `var C = Int8Array;
new C(4)` (length 4) → **PASS**. gc/host only; standalone keeps `$__ta_ctor`.
3. **REMAINING GAP (not fixed here)** — a host constructor externref passed as an
   argument through a **dynamic `any`-typed call** to a closure is DROPPED:
   `function run(fn){ fn(Int8Array); } run(function (TA){ … })` leaves `TA`
   `undefined` inside the callback (verified: `typeof TA !== "function"`). This
   is in the #3074 closure-dispatch **argument-marshaling** path — a host
   externref arg does not survive the dynamic-call boxing that a compiled-closure
   arg does. Because the TypedArray harness passes `fn(constructors[i])`, the
   cluster still honest-fails here until this is fixed. This is the true final
   blocker for the ~1487-file harness conversion.

### What lands vs. what remains

- **Lands (this PR):** dynamic `new K()` on user-function / class ctor values,
  and bare-TA-ctor-as-value materialization on the gc/host lane. Real, additive
  conformance surface; gc/host-gated (standalone floor untouched); the
  `check for test262 regressions` required check is the arbiter.
- **Remains (follow-up, keep #3087 in-progress):** the dynamic-`any`-call
  argument-marshaling drop of a host externref (link 3). Entry point: the
  `fn(arg)` dynamic-call arg compilation / boxing in the #3074 closure-dispatch
  machinery (`calls-closures.ts` / arg coercion). NOTE: verify whether this
  touches Fable-reserved dispatch substrate before implementing; if so, defer to
  the Fable window. Minimal repro to reopen from: `.tmp` style —
  `function run(fn){ fn(Int8Array); } var got="none";
run(function(TA){ got = typeof TA; }); assert got === "function"`.

## Resolution — link 3 re-diagnosed and fixed (2026-07-09, fable-3087)

Verify-first on current main DISPROVED the link-3 hypothesis as documented: the
minimal repro above **passes** on main (`typeof TA === "function"`, and
`new TA(4)` through the dispatch builds a real length-4 host view). The
closure-dispatch arg marshaling (`tryEmitInlineDynamicCall`) passes host
externref args intact — exact-arity, over-arity, and array-element shapes all
verified green with `.tmp` probes. Link 3's `TA === undefined` observation was
an artifact of measuring through the in-process `runTest262File` path, whose
**sandbox global** (`SANDBOX_GLOBAL_NAMES`, `tests/test262-runner.ts`) exposes
no TypedArray constructors, so PR #2800's `__extern_get(__get_globalThis(),
"Int8Array")` read `undefined` **under the sandbox only**. The production CI
lane (`scripts/wasm-exec-worker.mjs` → `buildImports` with NO sandbox) resolves
the real ctor — the cluster's callbacks dispatch and construct fine on CI.

The ACTUAL dominant blocker, pinned by staging the real failing chain
(`new TA(makeCtorArg([0,0,0]))` → first assert fails):

1. **`__`-prefixed USER function referenced as a VALUE compiled to
   `ref.null.extern`** — `compileIdentifier`'s function-as-value closure wrap
   was gated on `!name.startsWith("__")` (an internal-helper name filter), so
   `fn(constructors[i], __ta_makeCtorArgPassthrough)` passed NULL for the
   factory, `makeCtorArg(...)` hit the dynamic-dispatch null-drop → null, and
   `new TA(null)` built a length-0 view → every harness assert failed.
   **FIXED** (`src/codegen/expressions/identifiers.ts`): discriminate by the
   checker — only skip a `__` name that does NOT resolve to a source-level
   `FunctionDeclaration`. Compiler-internal helpers (`__module_init`,
   `__closure_N`, `__call_fn_N`, trampolines) never resolve to a source
   declaration, so they keep the old exclusion. Both lanes.
2. **BigInt-lane shim compat** (`tests/test262-runner.ts`): with (1) fixed, the
   now-running identity factory fed f64-lowered BigInt literals (`40n` → `40`,
   #1349-gated rep) into host `new BigInt64Array(...)` → "Cannot convert 40 to
   a BigInt" — measured 3/60 pass→RTE in the pass-sample A/B (projected ~50
   pass→fail). The BigInt wrapper now passes `__ta_makeCtorArgBigIntCompat`
   (arrays → null = the pre-fix null-drop behavior bit-for-bit; primitives →
   identity, an honest small win). Revisit when #1349 lands.

### Measured validation (CI-equivalent harness: wrapTest + compile + buildImports, no sandbox)

- Conversion: 21/80 (26%) random baseline-failing non-BigInt TypedArray-cluster
  files flip to PASS (projected ≈170 of 657); 9/20 of the harness non-buffer
  sample. Zero regressions:
  - 60 baseline-passing TA files: identical statuses vs main (56 PASS / 4
    pre-existing CE), zero flips.
  - 65 baseline-passing HOF/iterator/call files (Array.prototype.map/filter/…,
    for-of, Function.call/apply/bind): identical vs main, zero flips.
  - 15 equivalence suites with failures: all 36 failing test NAMES identical on
    pristine main — pre-existing, none mine.
  - `tests/issue-3087.test.ts` (4 new tests, both lanes), issue-3074 (4),
    issue-2939 (7, incl. un-staling the pre-#3074 "gc drop-gap persists"
    negative test) — 15/15 green. tsc + prettier + check:ir-fallbacks clean.

### Remaining TypedArray-cluster gaps (separate issues)

- **#3097** (new, verified root cause): compiled-ArrayBuffer vec struct does
  not marshal to a host ArrayBuffer at the construct bridge → `new TA(buffer,
0, 4)` builds a length-0 view; static host-lane `new Int8Array(buf)` treats
  the buffer as a numeric length (`taViewOk` is standalone-gated). ~144 files.
- **#3089**: BigInt-TA i64 "Binary emit error: offset is out of bounds" CE
  (48/60 of the random failing sample — the bulk of the remaining fails).
- **#1349**: BigInt value rep (unblocks the faithful BigInt makeCtorArg).
- Long tail (7/80 `resize is not a function` → #3054-C host lane; sort
  comparator; descriptor semantics; detached-buffer protocol).
