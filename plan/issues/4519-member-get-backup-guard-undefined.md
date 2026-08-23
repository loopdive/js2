---
id: 4519
title: "standalone: the member-access RECEIVER guard answers a fallback instead of TypeError for an `undefined` receiver — nullness-means-unset consumer #2 from #4489"
status: in-progress
sprint: current
created: 2026-08-16
updated: 2026-08-23
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: member-access
goal: standalone-gap
related: [4489, 4484, 789, 4157]
origin: "2026-08-16 #4489 verification — the second #789 backup-guard site (property-access.ts ~L1500 member-get multi-struct dispatch) was deliberately NOT widened: it has a real fallback (wrong answer, not crash), and widening changes every member access on every undefined value."
loc-budget-allow:
  # `nullishExternTestInstrs` (+66, of which ~40 are the rationale comment) is
  # `emitIsNullishAnyAt`'s externref twin and belongs beside it: this module is
  # where the #2106 S1 singleton vocabulary lives (`emitIsNullishAnyAt`,
  # `emitIsUndefinedSingletonExternAt`, `emitUndefinedSingleton`,
  # `undefinedSingletonActive`), and the new builder must call BOTH the regime
  # gate and the type reservation (`ensureAnyValueType`) that live here. Splitting
  # one 20-instruction builder into a new module would separate it from both. The
  # `ab4519RevertsToBase` A/B switch (+10) is the #4489 sweep instrument's shape
  # and is deliberately in the same module as the thing it reverts.
  - src/codegen/any-helpers.ts
  # +22 at `emitNullGuardedStructGet`'s backup guard, 14 of them the comment
  # recording the MEASUREMENT that keeps the next reader from re-deriving it (this
  # guard is emitted 0 times in 120 test262 modules; the live one is elsewhere).
  # The emitted logic is 6 lines, and it is the direct twin of the #4489 widening
  # already sitting 300 lines above it in the same file.
  - src/codegen/property-access.ts
  # +6: one import and the `carrier-get:recv` guard's nullish thunk. The guard
  # itself lives in `nonnull-proof.ts`; only the caller-side §7.3.2 decision is
  # here, which is where the receiver expression is in scope.
  - src/codegen/property-access-dispatch.ts
---

# #4519 — a member read on an `undefined` receiver does not throw

## Problem

`emitNullCheckThrow`'s sibling — the member-access RECEIVER guard — still tests
`ref.is_null` only. With the #4489 tag-1 undefined singleton active, a member
read whose receiver is `undefined` falls through the guard and answers a
fallback value instead of throwing TypeError (§13.3.2.1 via §7.3.2
RequireObjectCoercible).

## The issue named the wrong line, and the measurement says so

The issue (and the dispatch brief) pointed at `src/codegen/property-access.ts`
~L1500 — the member-get multi-struct dispatch backup guard inside
`emitNullGuardedStructGet`. Measured with the emitter instrumented, over the
first 120 files of this issue's fixed-seed stratified order, standalone lane:

| guard | emissions in 120 test262 modules |
| --- | --- |
| `emitNullGuardedStructGet`'s backup guard (the named site) | **0** |
| `emitExternrefToStructGet`'s `throwOnNull` | **0** |
| `emitReceiverNullGuard`, site `dispatch:extern-get-recv` (#4157) | **2,598** |

So the named site is effectively dead in this corpus, while the guard the issue
DESCRIBES — "sits on every member access on every undefined-capable value" — is
#4157's `emitReceiverNullGuard` in `src/codegen/nonnull-proof.ts`. The
description was right and the line pointer was not. Both are widened here; only
the second moves rows.

## Root cause

`emitReceiverNullGuard` emits `local.tee; ref.is_null; if → throw TypeError`.
That is a faithful spelling of §7.3.2 exactly as long as `undefined` is
represented by `ref.null.extern`. #4489 made `undefined` a tag-1 `$AnyValue`
SINGLETON in the standalone S1 regime — a genuinely non-null reference — so from
then on the guard read a real `undefined` receiver as "an object", declined to
throw, and let the read answer a fallback. This is the same
nullness-means-UNSET consumer class #4489 repaired at the crash site
(`emitNullCheckThrow`), one level up: there the miss produced an uncatchable
wasm trap, here it produces a wrong ANSWER, which is why it was deferred.

## Fix

Three pieces, all gated so the JS-host and gc lanes stay byte-identical:

1. **`nullishExternTestInstrs`** (`src/codegen/any-helpers.ts`) —
   `emitIsNullishAnyAt`'s EXTERNREF twin, returned as a detached instruction
   array. Scratch-free (two `any.convert_extern`s rather than an anyref local),
   because the consumer emits ~2,600 guards per module and that module's entire
   purpose is code size. Tag-1 `$AnyValue` only — deliberately NOT the #2979
   UNDEF_F64 `$BoxedNumber` arm, per absent-not-wrong.
2. **`emitReceiverNullGuard`** (`src/codegen/nonnull-proof.ts`) takes an optional
   `nullishTest` THUNK, for the same import-cycle reason its `throwInstrs`
   parameter is already a thunk. When the thunk answers `undefined` (regime
   inactive) it emits the exact bytes it emitted before. Its two callers — both
   member-access receiver checks — supply it.
3. **`emitNullGuardedStructGet`**'s backup guard (`property-access.ts`) is
   widened with `emitIsNullishAnyAt`, the issue's literal ask. Recorded in the
   code comment: 0 emissions in the 120-module census, so it is widened because
   the arm is WRONG as written, not because the corpus exercises it.

### The decline the A/B forced

A receiver that is an IDENTIFIER spelled `undefined` is excluded
(`receiverIsUndefinedIdentifier`, `nullish-receiver-coercible.ts`). By the time a
receiver reaches this guard, an *unshadowed* global `undefined` has already
thrown upstream in #4484's syntactic arm — so an identifier named `undefined`
here is necessarily a SHADOWED one, a parameter or local that may hold anything.

Measured: `function read(undefined) { return undefined.foo; }` called with
`{foo: 7}` compiles its receiver to the **tag-1 singleton**, not to the
parameter, and already answered `NaN` instead of `7` on base. That is a
pre-existing identifier-resolution defect, not repaired here. Its consequence
for this guard is that the singleton it would see is SPURIOUS, so throwing on it
converts a wrong value into a wrong THROW — strictly worse, because a throw is
catchable and therefore observable. Without the decline,
`tests/issue-4484.test.ts`'s "does NOT throw when `undefined` is shadowed by a
parameter" regressed; with it, that pin is green and the intended flips remain.

## Test Results

Every number below is from a run I executed in this worktree on this box
(4 cores, 1-min load average 4.5–12.8 with three sibling lanes active; the load
is recorded because timeout-class noise scales with it). Standalone lane
throughout.

### Environment — the #4484 trap was closed BEFORE any sweep

The fresh worktree had no `.test262-cache`, which silently under-measures
eval-dependent rows on BOTH arms. Copied the prebuilt artifacts in, rebuilt the
adapter for this source tree
(`JS2WASM_QUICKJS_ARTIFACT_DIR=…/quickjs-artifact-2e2d7736713beeda npx tsx
scripts/build-quickjs-eval-provider.mjs` → adapter cache HIT, key
`1429ec7ecf2163fd`), and confirmed a known eval-dependent row RUNS:
`language/eval-code/direct/var-env-func-init-global-new.js` → **pass**.
The worktree's `test262/` symlink farm was verified to resolve to the populated
checkout (`readlink -f` on a leaf test file).

### Shape A/B — paired, one process, `JS2WASM_4519_AB=base` reverting the fix

| shape | base | fix |
| --- | --- | --- |
| ABSENT argument receiver `a.foo` | no throw | **TypeError** |
| EXPLICIT `undefined` argument receiver `a.foo` | no throw | **TypeError** |
| `undefined`-typed `any` param, TS lane | no throw | **TypeError** |
| `null` argument receiver (control) | TypeError | TypeError |
| syntactic `undefined.foo` / `undefined.toString()` (#4484's arm) | TypeError | TypeError |
| live object `a.foo` reads 5 | 5 | 5 |
| ABSENT property on a live object | undefined | undefined |
| string `.length`, number/boolean `.toString()` | correct | correct |
| shadowed-`undefined` parameter holding `{foo:7}` | no throw | no throw (after the decline; **threw** without it) |

### Corpus sweep

Instrument: `.tmp/ab-worker.mts` — for each file the standalone lane runs the
PRE-fix emission and then the POST-fix emission back to back **in one process**,
`JS2WASM_4519_AB=base` selecting the pre-fix arm at emit time, so both sides see
the same machine, load and provider cache. File order is a fixed-seed (4519)
**stratified** shuffle: stratum 1 = all 1,375 ES≤5 `language/expressions` files
(the member-access surface, must complete), stratum 2 = the other 6,885 ES≤5
files shuffled. Two interleaved slices run in parallel.

<!-- RESULTS-PLACEHOLDER -->

### Pins

- `tests/issue-4519.test.ts` — 11 tests (8 behavioural + 3 `it.fails`
  residuals). The behavioural half is deliberately half over-throw pins: a
  guard on every member access is only shippable if it stays ABSENT for every
  non-nullish receiver, including a site where a live and a nullish receiver
  flow through the SAME emitted guard.
- `tests/issue-4484.test.ts` — 27 green. One stale `it.fails` flipped to `it`
  (`'valueOf' in {}`): healed by #4506 on this branch's base, verified failing
  identically under `JS2WASM_4519_AB=base`, i.e. not caused here.
- `tests/issue-4489.test.ts`, `tests/issue-789.test.ts` — green.

### Gates

`typecheck` clean · `check:oracle-ratchet` OK (+0 raw checker usage) ·
`check:coercion-sites` OK · `check:func-budget` OK · `prettier` clean ·
`check:loc-budget` requires the frontmatter allowance granted above.

## Residuals

1. **Member reads that never reach a receiver guard at all still do not throw.**
   Two populations, both measured with the emitter instrumented:
   - `tryEmitPinnedStructMemberGet` (`property-access.ts`) — a receiver the
     compiler resolved to a registered fnctor struct. It compiles the receiver
     straight onto the wasm stack and calls `__get_member_<name>` with no guard,
     deliberately holding no scratch local (#2681: an `allocTempLocal` here
     orphaned its slot inside a swapped body, `local index out of range`). A
     guard here needs a call-shaped RequireObjectCoercible helper rather than a
     site-local test.
   - the standalone terminal of `finalizeStructAndDynamicMemberGet`, reached
     when `__extern_get` is not registerable.

   Shapes measured still-not-throwing: a module-scope `var` receiver
   (`x.foo`, `x["foo"]`), a struct-typed slot holding `undefined`, an
   object-literal-typed slot. `it.fails`-pinned in `tests/issue-4519.test.ts`.
2. **A parameter named `undefined` does not shadow the global in the RECEIVER
   position** — `function read(undefined) { return undefined.foo; }` reads the
   singleton, not the parameter, and answers `NaN`. Pre-existing on both arms;
   this issue only declines to throw on it (see "The decline the A/B forced").
3. **`typeof (42).toString === "function"` answers falsy** — a method-value read
   off a boxed primitive. Measured identical on both arms; not this guard's
   surface. Deliberately not pinned here.
