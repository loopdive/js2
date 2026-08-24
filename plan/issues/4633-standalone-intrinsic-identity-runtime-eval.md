---
id: 4633
title: "Standalone: %Array% intrinsic identity across the runtime-eval boundary (wellKnownIntrinsicObjects)"
status: done
sprint: Backlog
created: 2026-08-23
updated: 2026-08-23
completed: 2026-08-23
priority: low
horizon: l
feasibility: hard
task_type: bug
area: codegen
goal: test262-conformance
lane: B
files:
  - src/codegen/expressions/runtime-eval-provider.ts
  - scripts/quickjs-eval-provider.mjs
---

# #4633 — Intrinsic identity across the runtime-eval boundary

## Problem

`test/harness/wellKnownIntrinsicObjects.js` fails standalone at
`assert(Object.is(Array, intrinsicArray))`. The harness populates each
intrinsic with `new Function("return " + source)()` — i.e. the value comes
back from the RUNTIME-EVAL engine (quickjs tier, #4242) — and compares it
with `Object.is` against the compiled module's own `Array` value read.

Two representations meet: the compiled lane's native builtin-ctor value
(a `$NativeProto`/singleton carrier from builtin-value-read.ts) and
whatever the eval boundary returns for `Array`. They are not the same
reference, so `Object.is` answers false.

## Implementation Plan

1. **Measure first**: instrument what `new Function("return Array")()`
   returns standalone (carrier kind, null?) and what the bare `Array`
   value read returns in the same module. Record both here before design.
   Probe files go in your worktree's `.tmp/`; run via
   `npx tsx` + `runTest262File(path, "harness", 30000, "standalone")`
   (see tests/test262-runner.ts). The quickjs runtime-eval tier is the
   default engine (#4242).
2. **Design decision** (pick after step 1):
   - (a) **Boundary canonicalization**: when the runtime-eval boundary
     hands back a value that names a global builtin (the eval engine can
     tag "this is the global `Array`"), substitute the compiled lane's own
     singleton for it, so identity holds by construction; or
   - (b) **Identity map in Object.is/===**: teach the sameValue native an
     arm equating the eval-side proxy for a builtin with the native
     singleton — narrower but leaks into every comparison site.
   Prefer (a): single chokepoint, no comparison-site sprawl.
3. **Scope guard**: only globals reachable by bare name need this
   (`Array`, `Object`, …); accessor-path intrinsics
   (`Object.getPrototypeOf([][Symbol.iterator]())`) are follow-ups — the
   harness self-test only asserts `%Array%` plus two throwing cases, which
   already throw correctly.
4. **Acceptance**: `harness/wellKnownIntrinsicObjects.js` passes
   standalone; runtime-eval canary suite unchanged; no js-host byte change.

## Step 1 — measurements (2026-08-23, quickjs tier, adapter 691fcec1a0569afb)

Probes in `.tmp/a4633-probe{1,2,3}.js`, run through
`runTest262File(path, "harness", 60000, "standalone")`.

**Finding 0 — the literal-source path was never broken.** A probe written as
`new Function("return Array")()` with a LITERAL argument answers
`a === Array: true`. That path is const-folded and compiled in-lane
(`eval-inline.ts`), so it never reaches the provider. The harness builds its
source dynamically (`new Function("return " + wkio.source)`), which is why only
the harness sees the bug. **Any probe of this issue must use a computed source
string** or it measures the wrong path and reports "no bug".

**Finding 1 — what the eval boundary returned for `Array`** (dynamic source):

| query | before | after |
| --- | --- | --- |
| `typeof` | `function` | `function` |
| `.name` | `"Array"` | `"Array"` |
| `.length` | `0` | `1` |
| `.prototype === Array.prototype` | **false** (`prototype` was `undefined`) | **true** |
| `.isArray` | `undefined` | `function` |
| `Object.is(a, Array)` | **false** | **true** |
| inward: `f(Array)` sees `g === Array` in body | **false** | **true** |
| two dynamic evals of the same name | identical to each other | identical |

So it was not only an `Object.is` mismatch: the value was an opaque provider
callback carrier with no constructor surface at all. Fixing identity fixes
behaviour with it.

**Finding 2 — the same seam is already correct for the error constructors.**
`TypeError` answered `true` in BOTH directions before any change, via the
existing #4308 slice-A seeding. That made this a *widening* of a working
mechanism rather than new machinery — which is what design (a) below rests on.

**Finding 3 — the compiled side's canonical `Array`** is the `__builtin_Array`
module global minted by `emitBuiltinNamespaceObject` (builtin-static-globals.ts).
The bare-identifier read (identifiers.ts ~L1057), the `[].constructor` arm
(vec-constructor-carrier.ts) and the seeding path all go through that one
emitter, so they cannot disagree.

## Design decision — (a) boundary canonicalization

Chosen: **(a)**, and specifically as an extension of the identity seeding that
#4308 slice A already built, not as new code.

- Caller side, `src/codegen/expressions/runtime-eval-provider.ts`: a new
  `RUNTIME_EVAL_INTRINSIC_VALUE_GLOBALS = ["Array"]` publishes the compiled
  `__builtin_Array` singleton on the shared realm carrier, with intrinsic
  descriptor attributes (writable, non-enumerable, configurable). Kept separate
  from `RUNTIME_EVAL_INTRINSIC_GLOBALS` because the error list also drives
  `isWasiErrorName`/`$Error_struct` family registration, which must not apply.
- Provider side, `scripts/quickjs-eval-provider.mjs`: `"Array"` added to the
  name list in `qjsSeedIntrinsicErrorIdentities`, so the realm's `Array` handle
  is registered against the caller's singleton. That fixes both crossings at
  once — `qjsPublish`'s registry hit returns the compiled value outward, and
  `qjsHandleOf` returns the realm's own object inward.

(b) was rejected as the plan anticipated: it would put an arm in every
comparison site and would still leave the returned value behaviourally broken
(no `prototype`, no `isArray`).

**Why publishing `Array` on the realm carrier does not leak it into QuickJS's
realm**: `qjsPushGlobals` mirrors an object-valued global only when it is
ENUMERABLE (`!primitive && !qjsAnyListHas(keys, key) → continue`), and intrinsic
carriers are defined non-enumerable. `qjsPullGlobals`'s write-back set is
derived from the push set, and the compiled pull additionally filters to
`ctx.moduleGlobals.has(name)`, which `Array` is not. So the realm's own `Array`
is untouched in both directions.

## Results

- `harness/wellKnownIntrinsicObjects.js` standalone: **fail → pass**.
- Full `test/harness/` category, standalone: **112 pass / 4 → 113 pass / 3**.
  The remaining three are unchanged and unrelated
  (`asyncHelpers-asyncTest-return-not-thenable`,
  `asyncHelpers-throwsAsync-same-realm`, `deepEqual-primitives-bigint`).
- Samples: standalone 60/60, regression list 90/90, js-host 59/60 (the
  `AsyncDisposableStack` failure is pre-existing), and a purpose-built 24-file
  eval-boundary sample (baseline-`pass` files under `eval-code/`, `createdynfn`,
  `built-ins/eval`, `built-ins/Function/*`) 24/24.
- **No js-host byte change**: a module with both `eval(s)` and
  `new Function(...)` compiles to a byte-identical 2,074-byte host binary
  (sha256 `f49bcbb7fd30973d` before and after). Standalone grows
  365,109 → 365,513 bytes (+404, +0.11 %) for a module that uses runtime eval;
  zero change for one that does not, since the carrier is demand-minted.
- Interpreter tier (`JS2WASM_EVAL_ENGINE=interpreter`): A/B measured
  byte-for-byte identical results on both the 16-file harness list and the
  24-file eval sample. **Residual**: that lane is only partly exercisable in
  this container — several files fail to link the `js2wasm:runtime-eval` import
  identically on base and on the change, so the comparison establishes
  neutrality, not coverage.

## Follow-ups (deliberately not taken)

- **Widening beyond `%Array%`.** The same defect applies to every bare-name
  intrinsic (`Object`, `String`, `Math`, …); the mechanism is a one-line list
  edit per name, on both sides. Not taken here because each added name changes
  inward crossing semantics for that intrinsic and drags its namespace carrier
  into every eval-using module, and the plan's scope guard limits this issue to
  `%Array%`. A widening should be measured name-by-name against the same
  samples.
- **Accessor-path intrinsics** (`Object.getPrototypeOf([][Symbol.iterator]())`)
  are untouched, per the plan's scope guard.
- **The compiled `Array` carrier is not constructible**: `new Array(3)` through
  the carrier yields a zero-length non-array, and `Array(1,2)` answers `null`.
  That is a pre-existing property of `__builtin_Array` (not of the seam — it
  reproduces on the compiled side without any eval), now newly VISIBLE to
  evaluated code that reads `Array`. Worth its own issue.
- Unrelated observation: `var b = Array; b.name` reads `"ArrayConstructor"`
  while `Array.name` reads `"Array"`.
