---
id: 4489
title: "standalone: module-scope `var x;` reads before declaration are `ref.null.extern`, indistinguishable from the closure ABI's absent-arg pad — seed with the undefined singleton (full-corpus A/B required)"
status: done
completed: 2026-08-16
sprint: 78
created: 2026-08-15
updated: 2026-08-18
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: hoisting
goal: standalone-gap
related: [4465, 737]
origin: "2026-08-15 #4465 R1 finding — 5 measured rows in built-ins/String/prototype alone; the root is module-wide."
loc-budget-allow:
  # `emitIsNullishAnyAt` (+51, of which ~30 are the rationale comment) belongs
  # beside its siblings: `emitIsUndefinedSingletonExternAt`,
  # `emitUndefinedSingleton`, `undefinedSingletonActive` — the #2106 S1
  # singleton vocabulary lives in exactly this module, and the new helper is the
  # anyref-shaped twin of the externref one directly below it. Splitting one
  # 20-instruction emitter out to a new module would separate it from the type
  # reservation (`ensureAnyValueType`) and the regime gate it must both call.
  - src/codegen/any-helpers.ts
  # +21 at the single consumer (`emitNullCheckThrow`), 16 of them the comment
  # explaining why the #789 backup guard must test NULLISH rather than null —
  # the trap this prevented is uncatchable and the reasoning is the expensive
  # part to re-derive. The emitted logic itself is 4 lines.
  - src/codegen/property-access.ts
---

# #4489 — module globals seed null, not undefined

## Problem

`registerModuleGlobal` seeds externref module globals with `ref.null.extern`.
A hoisted-but-unassigned `var x;` read therefore yields the same value the
closure ABI uses as its "absent argument" pad, so downstream arms
(String.prototype methods among them, #4465 G1b/G3, 5 measured rows) cannot
distinguish `undefined` from "no argument", and `String(x)`-class coercions
answer wrong. The function-local hoister already seeds `undefined` (#737) —
module scope diverges.

## Why this is NOT a one-line ship despite a one-line fix

The candidate fix is one line (seed with the undefined singleton), but its
blast radius is EVERY module global in the corpus: any arm that currently
`ref.is_null`-tests a module global to mean "unset" changes behavior. #4465's
agent measured only a 630-file String-scoped sweep and correctly declined to
ship blind.

## Implementation Plan

1. Brief: `plan/method/es5-standalone-agent-brief.md`.
2. Find every consumer that null-tests module globals (grep the emission
   sites reading `moduleGlobal`/`registerModuleGlobal` slots; catalogue
   `ref.is_null` uses on those values).
3. Apply the seed change; fix consumers that meant "unset" rather than
   "undefined" (they must test against the undefined singleton or a
   separate flag).
4. **Full-corpus A/B is the acceptance instrument**: a broad standalone
   sweep (at minimum: `built-ins/String`, `language/statements`,
   `language/expressions`, `built-ins/Object`, ~2k files) before/after from
   your own runs, zero regressions; plus the 5 #4465 R1 rows flipping.
5. Pins: extend tests/issue-4465.test.ts's residual pins (R1 has no pin —
   the harness's exported-function shape masks it; write a
   module-init-shape pin that actually exercises the module-global path,
   documented in #4465's report).

## Acceptance criteria

- The 5 R1 rows flip; broad-sweep zero regressions; consumers catalogued in
  the issue file.

### Amended by the session lead, 2026-08-16, against measurement

Both amendments were made after the numbers came in, not to make the numbers
pass:

1. **Sweep size.** "~2k files" understates the four named directories by ~12x
   (they are 25,148). At the measured ~5–7 s/file/worker for a PAIRED run, one
   full pass is ~13 h wall on this shared box. Instrument accepted instead:
   the same file list in a fixed-seed **stratified** order — stratum 1 = all
   1,223 `built-ins/String` (must COMPLETE), stratum 2 = the other three dirs
   shuffled (floor **≥3,000**) — with exact "N of 25,148" coverage reported.
   Truncating an unbiased order is not the same as choosing a subset.
2. **"The 5 R1 rows flip" → 2 flip, 3 carry a provenance proof.** Measured:
   `concat/S15.5.4.6_A4_T1` and `replace/S15.5.4.11_A1_T2` flip to pass. The
   other three stay red on a SEPARATE pre-existing defect — the reflective
   String-method arm renders the undefined singleton as `"[object Object]"` —
   and in all three the seed's own contribution is visibly fixed (their actual
   strings now carry `undefined` where they carried `null` or nothing). The
   proof that it is not this issue's defect: an ABSENT ARGUMENT's `undefined`,
   which the seed cannot reach, renders `"[object Object]"` there on BOTH
   sides. Filed as the new-issue stub below.

## Consumer catalogue (step 2 — done BEFORE the seed changed)

The plan's framing ("every consumer that null-tests module globals") has two
populations, and separating them is what makes the blast radius bounded rather
than corpus-wide.

**A. Slots that are NOT user `var`s.** `ctx.moduleGlobals` is not only user
variables — the compiler parks internal state in the same map, and those
entries genuinely mean "unset" by nullness:

| Slot | Site | `ref.is_null` means | Disposition |
| --- | --- | --- | --- |
| `"\0runtime-eval-carrier-memo"` | `runtime-eval-callable.ts:377` (`memoHit`) | memo empty | **Excluded by construction** — the seed loop iterates `recordScriptVarBindingNames`, and a NUL-prefixed name is not a JS identifier, so it can never appear there. |
| `__captured_<name>` | `closures.ts:788` | never read — the promotion `global.set`s the local's current value on the next instruction | Not in `moduleGlobals` at all (`capturedGlobals`); untouched. |
| `__tdz_<name>` | `module-global-registration.ts:119` | binding not yet initialised | `i32` flag, not externref; untouched. |

**B. User `var` slots — consumers of the pre-assignment value.** Every one was
read at the emission site and, where behaviour could differ, probed on the
compiled module (`.tmp/p2`–`p6`, standalone lane, this box):

| Consumer | Site | Before (null) | After (singleton) |
| --- | --- | --- | --- |
| Annex B block-fn `typeof` | `typeof-delete.ts:1440` | null arm → `"undefined"` | already singleton-seeded by the #4182 loop; its own comment states the null arm is dead standalone. **No change.** |
| ~~closure call `f()` on a `var f` slot~~ — **WRONG, this row was the regression**; see `## Fix` | `calls-closures.ts:590-604` | `emitGuardedRefCast` → null → `emitNullCheckThrow` TypeError | claimed "the singleton fails the same `ref.test`, yields null, throws the same TypeError. No change." Measured: it does NOT throw — `emitNullCheckThrow`'s #789 backup guard only throws when the PRE-cast value was `ref.is_null`, and the singleton is non-null, so the caller's `struct.get` TRAPS. Fixed by widening that guard. |
| slot-type queries (`inferExpressionWasmType`, `compoundSlotValType`, the `subarray`/HOF receiver probes) | `array-methods.ts:955/1473/1578`, `string-compound-lane.ts:36`, `index.ts:10788` | read `global.type`, never the value | **No change.** |
| sloppy `this` substitution | `helpers/sloppy-this-global.ts:159` warns the singleton IS non-null and defeats a callee's `ref.is_null` §10.4.3 fallback | probed: `f.call(x)`, `f.call(undefined)` and `f()` already agree (all three leave `this === undefined` true), so the fallback is not live in this shape | **No change** — and the singleton arm is the one that matches `f.call(undefined)`. |
| `x === undefined` / `x === null` | strict-eq dispatch | `false` / `true` — **both wrong** | `true` / `false` — **both fixed.** |
| `x == null`, `String(x)`, `x + ""`, `` `${x}` ``, `typeof x`, `"s".concat(x)` | nullish-widened S1 consumers | already answered as if `undefined` | **No change** (the #2106 widening already covers null). |
| ~~`x()`~~ — see the correction below | call dispatch | — | — |
| trailing call argument | user closures and the reflective String ABI (`string-proto-concat.ts` §22.1.3.5 step 3 pad) | indistinguishable from "argument not passed" — argument dropped | passed as a real `undefined`. **The #4465 R1 fix.** |
| `x.foo` | member dispatch | does not throw — but neither does `undefined.foo` today | **No change**; pre-existing gap on BOTH values, recorded as a residual. |

### Catalogue corrections and additions (second pass — every row below is a run I executed)

The table above was written from the emission sites; three of its rows were not
confirmed against a compiled module, and the two families with the largest
blast radius were missing entirely. The A/B instrument for all of the following
is the same one the sweep uses: one process, `JS2WASM_4489_AB=base` selecting
the pre-fix emission, both variants compiled and instantiated back to back
(`.tmp/probe-semantics.mts`, `.tmp/probe-shadow-builtin.mts`,
`.tmp/probe-call-and-assign.mts`, `.tmp/probe-reflective-tostring.mts`).

**Correction — `x()` does NOT start throwing.** Measured, module-init shape:
`x()` on a pre-declaration `var x;` throws nothing on EITHER side, while a
literal `undefined()` and `null()` both throw a real TypeError on both sides.
So the missing throw is a defect in the CALL dispatch of a global slot, not a
property of the value it holds, and this issue neither fixes nor worsens it.
(`var f; f(); f = function(){}` throws a non-TypeError on both sides —
separately pre-existing.)

**Addition — truthiness. The family that had to NOT move, and didn't.** `null`
and the singleton are both falsy, so every one of `if (x)`, `!x`, `x ? :`,
`Boolean(x)`, `while (x)`, `x || 7`, `x && 7` was already right before the seed
and stays right after it. This is the row that would have made the change
un-shippable had it moved, because it is the only one where the pre-state was
CORRECT; it is now pinned in `tests/issue-4489.test.ts`.

**Addition — numeric coercion. The family where the two values genuinely
disagree.** `Number(null)` is 0 but `Number(undefined)` is NaN, and test262
scores the difference:

| Expression | Before (null) | After (singleton) | Spec |
| --- | --- | --- | --- |
| `Number(x)` | `0` | `NaN` | `NaN` |
| `x + 1` | `1` | `NaN` | `NaN` |
| `+x` | `0` | `NaN` | `NaN` |
| `x < 1` | `true` | `false` | `false` |
| `[undefined].indexOf(x)` | `-1` | `0` | `0` |

**Addition — §9.1.1.4.18 non-clobber (`var Math;`).** CreateGlobalVarBinding
must not overwrite a name that is already a global property, so a seed that
reached those slots would be a regression. Measured unchanged on both sides for
`var Math;`, `var Array;`, `var JSON;`, `var Object;`, `var String;`
(`Math.max`, `Array.isArray`, `JSON.stringify`, `Object.keys`, `String(42)` all
keep working); `var NaN;` incidentally IMPROVES (`isNaN(NaN)` false → true,
because the shadow slot now reads `undefined` rather than `null`). Pinned.

**Addition — reflective String-method ToString renders the singleton as
`"[object Object]"`.** Not caused here and not fixed here, but it is what keeps
3 of the 5 R1 rows red, so it belongs in the catalogue: with an OBJECT
`searchValue` (or a detached `String.prototype.replace.call`) the replacement
value's ToString takes a generic-object arm. Provenance is irrelevant to it,
which is the proof it is not this issue's: an ABSENT ARGUMENT's `undefined` — a
value this seed cannot reach — already renders `"[object Object]"` there on
BOTH sides. Effect of this change on those rows is `"null…"` → `"[object
Object]…"`: a wrong answer replaced by a different wrong answer, no status
movement. The direct arm (string `searchValue`) is correct.

**Addition — an assignment that PRECEDES the `var` statement is lost, on both
sides.** `x = 5; … var x;` reads back neither `5` nor its seed: base gives the
null extern (`typeof` "object"), after the change it gives `undefined`. Both
are wrong (spec: `5`), the loss predates this issue, and the seed only changes
which wrong value is observed. Recorded as a residual, not a regression.

The load-bearing conclusion: the #2106 S1 sweep already flipped every
*nullish-intent* consumer to `is_null ∨ is-singleton`, so the change moves a
value from a widened-accepted representation to the canonical one. The
consumers that behave differently are exactly the ones that were **wrong**
before (`===`, numeric coercion, argument passing), which is why a one-line
seed is nevertheless a real change and needed the corpus A/B.

## Root cause

`registerModuleGlobal` can only give a module global a CONSTANT initializer,
and the only constant externref is `ref.null.extern`. Under the #2106 S1 value
model that is `null` — a genuinely different value from the tag-1 `$undefined`
singleton, not another spelling of it. §9.1.1.4.18 CreateGlobalVarBinding
requires every module-scope `var` to hold `undefined` before the first
top-level statement runs, so the constant init is a value the spec never
permits to be observable there. The function-local hoister has seeded a real
`undefined` since #737; module scope simply never got the same treatment, and
the #2106 nullish-widening (`is_null ∨ is-singleton` in every nullish-intent
consumer) hid the divergence everywhere except where the two values are
genuinely distinguishable: `===`, numeric coercion, and argument passing.

## Fix

`src/codegen/declarations/module-var-undefined-seed.ts` —
`emitModuleVarUndefinedSeeds` writes the singleton into every externref module
global backed by a module-scope `var`, in the `__module_init` PROLOGUE, and is
called from `compileDeclarations` where the #4264 `with`-body-only seed used to
sit (it subsumes that seed: `scriptVarBindingNames` walks the same region over
a superset of declarations). `scriptVarBindingNames` in
`source-scan-predicates.ts` is the memoized set form of the existing
`recordScriptVarBindingNames` walk.

Three scope decisions, each load-bearing:

- **Prologue, ahead of the function-binding seeds** (#2931 live bindings, #4394
  script globals, #4182 Annex B). §9.1.1.4.18 creates a `var` binding with
  `undefined` only when the name is absent, and GlobalDeclarationInstantiation
  initialises function bindings afterwards, so a name that is both must end up
  holding the FUNCTION. Pinned.
- **`var` only.** `let`/`const` must be in TDZ before init, which the separate
  `__tdz_<name>` flag enforces; seeding them `undefined` would be wrong.
- **externref slots only.** A slot narrowed to a primitive (`var n = 42` ⇒
  `(mut f64)`) cannot hold the singleton and keeps its wasm zero-init — the
  module-scope twin of #684, left as a residual because the remedy is a
  slot-type change with its own blast radius.

Standalone/WASI only: in host mode `undefined` IS the null extern, and the
singleton would surface to host helpers as an object (#4264's grounds).

### The consumer fix the corpus A/B forced (second half of the shipped delta)

The seed ALONE regressed one corpus row, and the sweep is the only instrument
that could have found it — the emission-site reading had this exact consumer
catalogued as "No change".

**`language/statements/function/S13_A17_T1.js`, pass → fail.** Calling
`__func()` before `var __func = function(){…}` must throw a CATCHABLE TypeError.
Before the seed the slot held null and the compiler threw one; with the
singleton it emitted an uncatchable wasm TRAP — `dereferencing a null pointer in
__module_init` — so the test's own `catch` never ran and the module died.

Root cause: `emitNullCheckThrow` (`src/codegen/property-access.ts`) carries the
#789 *guarded-cast backup* guard — when a `ref.cast` to the closure struct
fails, throw TypeError only if the ORIGINAL pre-cast value was `ref.is_null`,
otherwise assume "wrong struct type" and fall through. That is precisely a
nullness-means-UNSET consumer, and the singleton is a NON-null reference: the
guard read a genuine `undefined` as "some other struct", declined to throw, and
the caller's `struct.get` on the null cast result trapped.

Fix: `emitIsNullishAnyAt` (`src/codegen/any-helpers.ts`) — the
`is_null ∨ tag-1-singleton` widening the #2106 S1 sweep applied to every other
nullish-intent consumer, in the anyref shape this guard needs (the guarded-cast
backup is saved as anyref) — consumed by `emitNullCheckThrow`. Gated on
`undefinedSingletonActive`, so host/gc-lane modules keep the plain
`ref.is_null` and stay byte-identical.

**The same trap was already reachable at FUNCTION scope and this repairs it
too**: `function g(){ … f2(); var f2 = function(){}; }` traps identically on
BOTH sides of the seed-only A/B, because the #737 local hoister has seeded
`undefined` there for years. So the defect is a latent pre-existing one that
the module-scope seed merely routed into code test262 exercises — which is the
evidence that the fix belongs in the consumer, not in the seed.

Deliberately NOT widened: the second backup-guard site in the same file (the
member-get multi-struct dispatch, ~L1500). It has a real fallback rather than a
trap, so it is a wrong-ANSWER residual (`undefined.foo` does not throw) and not
a crash; widening it changes every member access on every undefined value in
the corpus. Residual #5, its own issue.

## Residuals

1. **Reflective String-method ToString renders the undefined singleton as
   `"[object Object]"`** — the blocker for 3 of the 5 R1 rows. Filed as the
   stub below; needs its own id.
2. **A primitive-narrowed module `var` still reads its wasm zero-init**
   (`var n = 42` before the declaration reads `0`, not `undefined`). Module
   scope twin of #684; `it.fails`-pinned in `tests/issue-4489.test.ts`.
3. **An assignment that precedes the `var` statement is lost** (`x = 5; … var
   x;` reads back the seed, not `5`) — pre-existing on both sides; the seed
   only changes which wrong value is observed (`null` → `undefined`).
4. **`x()` on a pre-declaration `var x;` throws nothing**, while a literal
   `undefined()` throws TypeError — a call-dispatch gap on global slots,
   unchanged by this issue and unrelated to the value held.
5. **`x.foo` does not throw**, and neither does `undefined.foo` — pre-existing
   on both values.

## New-issue stub — reflective String-method ToString of `undefined`

*(needs an id from `claim-issue.mjs --allocate`; the session lead allocates at
merge time.)*

- **title**: `standalone: the reflective String.prototype.{replace,concat} arm
  renders the undefined singleton as "[object Object]"`
- **goal**: `standalone-gap` · **area**: codegen · **es_edition**: 5
- **Problem.** With an OBJECT `searchValue` — or a detached
  `String.prototype.replace.call` receiver — the replacement value's ToString
  takes a generic-object arm that does not recognise the tag-1 `$undefined`
  singleton, so a genuine `undefined` renders `"[object Object]"` instead of
  `"undefined"`. The direct arm (string `searchValue`) is correct.
- **Provenance-independent, therefore not #4489's.** Measured on this box, both
  before AND after #4489's seed, with the undefined sourced from an ABSENT
  ARGUMENT — a value the seed cannot reach:

  | shape | before #4489 | after #4489 | spec |
  | --- | --- | --- | --- |
  | direct arm, module `var` | `"null…"` | `"undefined…"` | `"undefined…"` |
  | direct arm, absent arg | `"undefined…"` | `"undefined…"` | `"undefined…"` |
  | reflective arm, absent arg | `"[object Object]…"` | `"[object Object]…"` | `"undefined…"` |
  | reflective arm, module `var` | `"null…"` | `"[object Object]…"` | `"undefined…"` |
  | detached `.call`, module `var` | `"[object Object]…"` | `"[object Object]…"` | `"undefined…"` |

- **Blocks**: `built-ins/String/prototype/replace/S15.5.4.11_A1_T10.js`,
  `.../S15.5.4.11_A1_T9.js`, `built-ins/String/prototype/concat/S15.5.4.6_A1_T10.js`
  (the last also needs ToString of an object whose `toString` returns a
  non-string primitive — `{toString:function(){return true;}}` renders
  `"[object Object]"` instead of `"true"`, same arm).
- **Pin already in tree**: the `it.fails` case
  `residual: reflective String.replace renders undefined as "[object Object]"`
  in `tests/issue-4489.test.ts`, which carries the absent-arg control.
- **Repro**: `.tmp/probe-reflective-tostring.mts` (see #4489's record).

## Test Results

Every number below is from a run I executed on this box. Sizing note first,
because it changes how the acceptance instrument had to be built: the four
named directories are **25,148 files**, not the "~2k" the plan estimated
(`built-ins/String` 1,223 · `built-ins/Object` 3,411 · `language/statements`
9,350 · `language/expressions` 11,164). Measured paired cost is ~5–7 s/file/
worker (compile dominates; the assembled test262 module carries the ~1,200-line
harness prefix, and a passing test compiles twice for the strict rerun), i.e.
~13 h wall for one full pass at the parallelism this shared box allows. The
session lead approved the instrument below in place of a full pass.

**Instrument.** `.tmp/ab-worker.mts`: for each file the standalone lane runs the
PRE-fix emission and then the POST-fix emission **back to back in one process**,
with `JS2WASM_4489_AB=base` selecting the pre-fix arm at emit time. Both sides
therefore see the same machine, the same load, and the same provider-cache key —
a missing artifact can make a row insensitive but can never manufacture a flip.
File order is a **fixed-seed (4489) stratified shuffle**: stratum 1 = all of
`built-ins/String`, stratum 2 = the other three dirs, so any prefix is an
unbiased sample of its stratum and coverage is reported as an exact fraction.
Every flip was re-confirmed in a **fresh process** (`.tmp/run-one-isolated.mts`).

### Phase 1 — seed only. This is the run that found the regression.

4,310 paired rows (stratum 1 **1,223/1,223 complete**, stratum 2 3,087/23,925):

| transition | rows |
| --- | --- |
| pass → pass | 3,428 |
| fail → fail | 715 |
| compile_error → compile_error | 129 |
| skip → skip | 31 |
| **fail → pass (fixes)** | **3** |
| **pass → fail (regression)** | **1** |
| compile_error → fail (flake) | 3 |

- Fixes: `built-ins/String/prototype/concat/S15.5.4.6_A4_T1.js`,
  `built-ins/String/prototype/replace/S15.5.4.11_A1_T2.js` (the two R1 rows) and
  `language/statements/variable/S14_A1.js`.
- Regression: `language/statements/function/S13_A17_T1.js` — the uncatchable
  trap described under `## Fix`. **This is why the corpus A/B is the acceptance
  instrument**: the consumer it broke was catalogued "No change" from reading
  the emission site.
- The 3 `compile_error → fail` rows are base-side 15 s compile TIMEOUTS under
  load, not differences: each re-run in isolation with a 45–60 s ceiling gives
  the SAME status on both sides.
- Environment correction mid-phase: my worktree's quickjs adapter cache key is
  derived from the compiler source, so the A/B edit invalidated it and
  eval-linked rows failed identically on both sides for an environment reason.
  Rebuilt (`npx tsx scripts/build-quickjs-eval-provider.mjs` — plain `node`
  refuses with "no usable compiler … run under tsx") and **re-ran all 91
  already-swept eval-linked rows: 0 differences**, 55 of them passing on both
  sides once the provider was present.

### Phase 2 — the shipped delta (seed + nullish guard), re-run from scratch

Same order, same instrument, `JS2WASM_4489_AB=base` now reverting BOTH changes
together so the A/B unit is what actually ships. **6,310 paired rows — 25.1 % of
the 25,148-file corpus** (stratum 1 **1,223/1,223 complete**, stratum 2
5,087/23,925 = 21 %, i.e. 1.7x the agreed floor):

| transition | rows |
| --- | --- |
| pass → pass | 5,036 |
| fail → fail | 1,012 |
| compile_error → compile_error | 204 |
| skip → skip | 55 |
| **fail → pass (fixes)** | **3** |
| **pass → fail (regressions)** | **0** |
| any other flip | 0 |

The same 3 fixes, **zero regressions**, and — unlike phase 1 — zero timeout
flakes (the quickjs adapter was cached by then and the box was quieter). The
dispositive row: `language/statements/function/S13_A17_T1.js`, which read
`pass → fail` in phase 1, reads **`pass → pass`** in phase 2.

### Pins

- `tests/issue-4489.test.ts` — **15 pass** (13 behavioural + 2 `it.fails`
  residual pins). Includes the module-init-shape pins the plan asked for (the
  exported-function shape cannot fail — the #737 local hoister already seeds
  those), the truthiness / numeric-coercion matrices, the §9.1.1.4.18
  non-clobber pin, and the regression pin (`call before initializer throws a
  CATCHABLE TypeError`) plus its function-scope twin.
- Re-run green on this tree: `tests/issue-4465.test.ts` (20),
  `tests/issue-789.test.ts` (the guard's own issue), `tests/issue-2931.test.ts`
  + `tests/issue-737.test.ts` (17), `tests/es5-standalone-with-carrier.test.ts`
  (8, the #4264 seed this subsumes), `tests/es5-standalone-with.test.ts` (24),
  `tests/es5-standalone-this-and-construct.test.ts` (22),
  `tests/es5-standalone-replace-fn.test.ts` (23).
- `pnpm run check:stack-balance` — OK, no fixup-bucket increases.
- **Not mine, but observed here**: `tests/es5-standalone-harness-selftests.test.ts`
  fails 3 ratchet assertions ("FIXED: … now PASSES. Flip its EXPECTED entry") for
  `sta.js`, `assert-throws-custom-typeerror.js`, `compare-array-samevalue.js`.
  All three pass under the PRE-#4489 emission too — the improvement came in from
  `main` and an earlier PR landed without flipping the entries. Left untouched
  deliberately; the session lead owns the flip.

### What this sweep can and cannot say

It says: across 6,310 paired rows including the complete `built-ins/String`
directory and an unbiased 21 % prefix of the other three, the shipped delta
regresses nothing and fixes three rows. It does NOT say the remaining 79 % of
stratum 2 is clean — that would need the full 13 h pass. The strongest
mitigation is not the sample size but the shape of the one regression found:
it was a *nullness-means-unset consumer*, the exact class the issue predicted,
and the fix repairs that class at the consumer rather than per call site.
