---
id: 4519
title: "standalone: the member-access RECEIVER guard answers a fallback instead of TypeError for an `undefined` receiver — nullness-means-unset consumer #2 from #4489"
status: done
completed: 2026-08-23
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

**Flips (all five spec-correct):**

| shape | base | fix |
| --- | --- | --- |
| ABSENT argument receiver `a.foo` | no throw | **catchable TypeError** |
| EXPLICIT `undefined` argument receiver `a.foo` | no throw | **catchable TypeError** |
| an ABSENT property as the next receiver, `o.missing.foo` | no throw | **catchable TypeError** |
| an OUT-OF-RANGE element as a receiver, `arr[3].foo` | no throw | **catchable TypeError** |
| STRICT-mode detached `this.foo` (§10.2.1.2) | no throw | **catchable TypeError** |

**Unmoved — the half that decides whether a guard on every member access is
shippable at all.** Each of these routes a NON-nullish receiver through the
widened guard:

| shape | both arms |
| --- | --- |
| live object `a.foo` | reads 5 |
| ABSENT property read `a.nope` (result, not receiver) | `undefined`, no throw |
| string `.length`, number/boolean `.toString()` | correct |
| 3-deep live chain, `for-in` count, `arguments.length`, string method chain, `Error.message` | correct |
| `null` argument receiver (control — already threw) | TypeError |
| syntactic `undefined.foo` / `undefined.toString()` (#4484's arm) | TypeError |
| `for-in` over `undefined`, `delete undefined.foo`, `typeof`, `x && x.foo`, `undefined.foo()` | unchanged |
| `JSON.stringify`, `Object.keys`, array index loop, prototype method through an instance | correct |
| shadowed-`undefined` parameter holding `{foo:7}` | no throw — **threw without the decline** |

**Per-lane byte identity** (same source, sha256 of the emitted binary, absent-arg
shape which is measured to REACH the guard):

| lane | base | fix | |
| --- | --- | --- | --- |
| host/gc | `26b7803db56e48a2` | `26b7803db56e48a2` | **identical** |
| standalone | `bcaa0c26bd2add72` | `357642971e0e7e7b` | differs, valid |
| wasi | `9e03c06f04c40a21` | `7681b6458dea5a8a` | differs, valid |

### Corpus sweep

Instrument: `.tmp/ab-worker.mts` — for each file the standalone lane runs the
PRE-fix emission and then the POST-fix emission back to back **in one process**,
`JS2WASM_4519_AB=base` selecting the pre-fix arm at emit time, so both sides see
the same machine, load and provider cache. File order is a fixed-seed (4519)
**stratified** shuffle: stratum 1 = all 1,375 ES≤5 `language/expressions` files
(the member-access surface, must complete), stratum 2 = the other 6,885 ES≤5
files shuffled. Two interleaved slices run in parallel.

**Coverage: 5,242 paired rows = 63.5 % of the 8,260-file ES≤5 corpus — stratum 1
COMPLETE (1,375/1,375) and stratum 2 at 3,867/6,885 (56.2 %), i.e. 1.3x the
agreed ≥3,000 floor.**

| transition | rows |
| --- | --- |
| pass → pass | 5,010 |
| fail → fail | 222 |
| compile_error → compile_error | 4 |
| **fail → pass (fixes)** | **4** |
| **pass → fail (regressions)** | **2** |
| any other transition | **0** |

**Net +2.** Six flips, each re-confirmed in a FRESH process:

```
+ built-ins/Function/15.3.5.4_2-10gs.js            fail -> pass
+ built-ins/Function/15.3.5.4_2-96gs.js            fail -> pass
+ built-ins/Function/15.3.5.4_2-97gs.js            fail -> pass
+ language/statements/with/S12.10_A5_T4.js         fail -> pass
- built-ins/Function/prototype/S15.3.3.1_A3.js     pass -> fail
- built-ins/Function/prototype/S15.3.3.1_A1.js     pass -> fail
```

**Three of the four fixes are exactly this issue's semantics** — the §15.3.5.4
strict-`.caller` family. Each ends with
`return g.caller || g.caller.throwTypeError;`: `.caller` of a strict-called
function is `undefined`, and reading `.throwTypeError` off that `undefined` must
throw a TypeError, which is what `assert.throws(TypeError, …)` is waiting for.
Before this change the read answered a fallback and nothing threw. The fourth,
`with/S12.10_A5_T4`, is a `with`-scope member read on a deleted binding.

**There is no zero-flip run to fall back on: the same instrument shows a flip in
BOTH directions**, which is the check that the A/B is sensitive rather than
inert. Zero transitions of any other kind (no `pass → compile_error`, no
timeout-class churn) across 5,242 pairs.

**The two regressed rows were VACUOUS passes, and the vacuity is a pre-existing
capability gap, not something this change introduces.** Bisected to a single
harness call (`.tmp/p1.js`: `verifyNotConfigurable(Function, "prototype")`
alone reproduces `_A3`; `_A1` is the `verifyNotWritable` twin; the `_A3` test's
own `delete` half passes on both arms). The
runner inlines the REAL upstream `propertyHelper.js`, whose line 457 is

```js
assert(!__getOwnPropertyDescriptor(obj, name).configurable, …)
```

and `Object.getOwnPropertyDescriptor(obj, name)` through a **dynamic receiver
parameter** answers `undefined` for a builtin constructor on this compiler.
Measured directly, and identical on BOTH arms (`.tmp/p4.js`):

| shape | result |
| --- | --- |
| `Object.getOwnPropertyDescriptor(Function, "prototype")`, LITERAL receiver | object ✓ |
| `Object.getOwnPropertyDescriptor(o, "a")` via a dynamic parameter | object ✓ |
| `Object.getOwnPropertyDescriptor(obj, name)` via a dynamic parameter, `obj = Function` | **`undefined`** |

So before this change the harness read `.configurable` (resp. `.writable`) off
`undefined`, got `undefined`, and `!undefined` satisfied the assert — the rows
passed **because** the descriptor was missing. §7.3.2 requires that read to
throw; it now does, and the harness surfaces the throw as a failure. Both rows
are true statements about a gap that was previously invisible.

**The class is bounded and measured, not assumed.** Every ES≤5 test that calls
ANY of the six deprecated descriptor verifiers — `verify{Not,}Configurable`,
`verify{Not,}Writable`, `verify{Not,}Enumerable`, **248 files, the complete
set** — was A/B'd to completion. **Exactly two flip**, both in the same
directory and both the same vacuity:

```
- built-ins/Function/prototype/S15.3.3.1_A1.js   pass -> fail   verifyNotWritable(Function, "prototype", …)
- built-ins/Function/prototype/S15.3.3.1_A3.js   pass -> fail   verifyNotConfigurable(Function, "prototype")
```

The other 246 are unmoved. `verifyProperty` — the non-deprecated helper the rest
of the suite uses — is rewritten to `assert_sameValue` at source level by the
runner and never executes the descriptor read, which is why the exposure stops
here. (The scoring path is `assembleOriginalHarness`, i.e. the REAL upstream
`sta.js`/`assert.js`/`propertyHelper.js`, not the runner's stub preamble — so
these are genuine conformance rows, not a harness artifact.)

Two further complete A/B runs, both **0 flips**:

- the acceptance directory `language/expressions/property-accessors` (21/21) —
  which is also the direct evidence that the issue's stated acceptance rows
  (`S11.2.1_A3_T4`/`_T5`) were already flipped by #4484 and cannot flip again;
- `language/function-code` + `language/statements/function` (425/425), targeted
  at the strict-`this` family the probe A/B showed flipping — so that
  improvement is real per-shape but does not move rows there.

### Pins

- `tests/issue-4519.test.ts` — **16 tests** (13 behavioural + 3 `it.fails`
  residuals), green in three configurations: plain, `--sequence.shuffle`
  (order-dependence / #3673 pollution check), and
  `JS2WASM_EVAL_ENGINE=interpreter` (the CI `quality` tier).
  **The pins are shown to bite, not assumed to:** re-run under
  `JS2WASM_4519_AB=base` (every widening reverted) **7 of the 16 FAIL** — the
  six flip pins plus the mixed live/nullish-through-one-guard pin — and the
  other 9 pass on both arms, which is exactly the job of an over-throw control.
- `tests/issue-4484.test.ts` — 27 green. One stale `it.fails` flipped to `it`
  (`'valueOf' in {}`): healed by #4506 on this branch's base, verified failing
  identically under `JS2WASM_4519_AB=base`, i.e. not caused here.
- `tests/issue-4489.test.ts` (15), `tests/issue-789.test.ts`,
  `tests/issue-4465.test.ts` (20), `tests/issue-737.test.ts` (13),
  `tests/issue-2931.test.ts` (4), `tests/issue-4506.test.ts` (22),
  `tests/issue-4479.test.ts` (16) — green.
  `tests/issue-4157.test.ts` does not exist on this base (skipped, said so).
- Standalone suites, per-file: `es5-standalone-this-and-construct` (22),
  `-function-semantics` (14), `-descriptors` (2), `-instanceof` (20), `-with`
  (24), `-with-carrier` (8), `-replace-fn` (23) — green.
- Scoped `tests/equivalence/`, per-file (the suite OOMs in one invocation):
  `binding-null-guard` (9), `null-narrowing` (5), `null-destructuring` (6),
  `struct-null-comparison` (7), `optional-element-access` (4),
  `optional-chaining-call` (5), `hasownproperty-call` (5),
  `element-access-externref` (4), `element-access-class` (5),
  `super-property-access` (7), `issue-4123-param-receiver-proto-method` (10),
  `issue-799-prototype-chain` (5), `issue-3205-property-call-wrapper-root` (5),
  `compound-assignment-property` (5), `prefix-postfix-increment-property` (8) —
  all green.

All of the above were re-run a second time after the final commit; the results
are identical.

**Two pre-existing failures, each verified on BOTH arms by my own runs** (not
inherited from another issue's record):

- `tests/equivalence/null-dereference-guards.test.ts` — the same 5 tests fail
  with `JS2WASM_4519_AB=base`. Their receivers are null-typed STRUCTS, a path
  this guard does not sit on.
- `tests/es5-standalone-array-semantics.test.ts` — 1 test ("array HOFs skip a
  deleted index … through an `any`-typed alias") fails identically on base.

### Gates

`typecheck` clean · `lint` clean · `prettier` clean ·
`check:oracle-ratchet` OK (+0 raw checker usage) · `check:coercion-sites` OK ·
`check:func-budget` OK · `check:stack-balance` OK (no fixup-bucket increases) ·
`check:loc-budget` OK with the frontmatter allowance granted above.

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
4. **The WRITE side does not throw either.** `x.foo = 1` on an `undefined` `x`
   silently succeeds, measured identical on both arms. This issue is read-side
   only (`emitReceiverNullGuard` has no write-side counterpart); §7.3.2 applies
   to the assignment target's base the same way, so this is a real follow-up.
   `delete x.foo` on an `undefined` `x` already throws, on both arms.
5. **A sloppy-mode detached call leaves `this === undefined`** rather than the
   global object (§10.2.1.2's non-strict branch). Unchanged by this issue and
   visible in its probe table because the strict twin is what flipped.
6. **`Object.getOwnPropertyDescriptor(obj, name)` answers `undefined` for a
   builtin constructor when `obj` arrives through a DYNAMIC parameter** — the
   literal-receiver form and a plain own property both work. `object-runtime.ts`
   states the rule at `__getOwnPropertyDescriptor`'s registration: "missing own
   prop / **non-`$Object` receiver → undefined", and a builtin carrier is not a
   `$Object`. This is what makes `S15.3.3.1_A1`/`_A3` vacuous passes, and it is
   the two rows this change costs. Descriptor-attribute / `$Object`-substrate
   surface (#4479 / #4506-adjacent), not this guard's. **Needs a lead routing
   decision**: the honest repair is to give the dynamic-receiver descriptor
   lookup the builtin's own property, after which both rows pass for a real
   reason. Deliberately NOT attempted here — it is another lane's file set and
   would make the A/B unable to attribute either result.

## Decision log — two things a reviewer will ask about

- **`nullishExternTestInstrs` calls `ensureAnyValueType(ctx)`**, which can mint
  the `$AnyValue` type and the `__undefined` global at GUARD-emission time rather
  than at first-use-of-`any`. Kept deliberately, for consistency with
  `emitIsNullishAnyAt`, which #4489 shipped doing exactly this from the same
  emission phase. Both additions are appends (no index shifts), and the corpus
  A/B shows no `pass → compile_error` transition. The considered alternative —
  gating on `ctx.undefinedGlobalIdx !== undefined` so nothing is minted — was
  rejected because it makes the widening depend on whether the module's first
  `undefined` producer has run yet, i.e. order-dependent and unreproducible.
- **Why the guard, not the read paths.** The two populations in residual 1 are
  fixed by giving a lowering path a receiver check it never had; this issue is
  about a guard that HAS the check and spells it wrong. Mixing them would make
  the A/B unable to attribute a regression to either.
- **`git diff` reports `src/codegen/nonnull-proof.ts` as `Bin 11219 → 12794
  bytes`, and that is NOT a corruption.** The file has contained a literal NUL
  byte at offset 7,861 since before this change — `` `${q.fnKey}\0${simple}` ``
  in `priceDominance`, a census map key using NUL as a separator that cannot
  occur in an identifier. Git's binary heuristic scans the first 8,000 bytes, so
  it classifies the file as binary and prints a byte-size line instead of a
  textual diff. Verified present at the identical offset in the pre-change blob.
  Read the file to review the change; `git diff` will not show it.
