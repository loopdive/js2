---
id: 1917
title: "One coercion engine — four divergent coercion matrices disagree about lossiness"
status: done
completed: 2026-07-24
assignee: ttraenkler/sdev-1917
sprint: 78
model: opus
created: 2026-06-10
updated: 2026-08-18
priority: high
feasibility: medium
reasoning_effort: high
task_type: refactor
area: codegen
language_feature: compiler-internals
goal: correctness
---
# #1917 — One coercion engine

## Current state (2026-07-24, sdev-1917) — LANDED vs REMAINING

**The bulk of this issue has already landed.** The stale narrative below (Problem,
the original "Proposed approach", and the per-step Implementation sections) predates
those merges — read this section first for the accurate status.

### LANDED (on `origin/main`)

- **Step 0 — single ValType `coercionPlan` table.** `src/codegen/coercion-plan.ts`
  exists (pure `coercionPlan(from, to, {boxNumberIdx, unboxNumberIdx})`). All four
  headline sites delegate to it: `callArgCoercionInstrs` (stack-balance.ts:1480),
  `fixBranchType` (stack-balance.ts:903), `coercionInstrs` (type-coercion.ts:3529),
  and `coerceType`'s scalar rows.
- **The headline `externref→f64` divergence is GONE.** `fixBranchType` no longer
  emits lossy `drop; f64.const 0`; it routes box/unbox through `coercionPlan` and
  unboxes identically to the call-arg path (the acceptance-criterion-1 fix).
- **Steps 1/2(partial)/3/4 — the JS-semantic engine.**
  `src/codegen/coercion-engine.ts` exports `emitToString`/`compileAndEmitToString`,
  `emitToNumber`, `emitToBoolean`, `emitStrictEq`/`emitLooseEq`/
  `emitAnyEqFromExternTemps`, and `coercionMode`. The ToString, ToNumber, ToBoolean,
  and equality dispatch sites migrated into it (see the per-step sections below for
  the migration detail; those are accurate history now that they merged).
- **Step 5 drift gate (#2108) is BUILT, WIRED, and GREEN.**
  `scripts/check-coercion-sites.mjs` + `scripts/coercion-sites-baseline.json`,
  run as `check:coercion-sites` in the `quality` CI job. It sanctions
  `coercion-engine.ts`/`any-helpers.ts`/`native-strings.ts` and fails on per-file
  vocabulary growth. It is NOT yet flipped to the hard per-token seal.

### Acceptance criterion #2 — SUPERSEDED (not unfixed)

The original spec asked that the `ref→f64` divergence (`coercionInstrs` →
`f64.const NaN` vs the call-arg/branch unbox) also be forced to ValType identity.
That is now understood to be a **deliberate provenance-dependent policy**, not an
accidental divergence: a *bare* GC object-ref has ToNumber `NaN` (§7.1.4 — object
with no numeric `valueOf`), whereas a ref *carrying a boxed number* must unbox.
Forcing a single ValType-keyed answer would REGRESS one of the two. The
`staticJsType`-hinted engine owns this split by provenance; ValType alone cannot.
So criterion #2 is retired as originally worded — the `externref→f64` half (the
real accidental bug) is fixed; the `ref→f64` half is correct-by-policy.

### REMAINING (this branch, `issue-1917-stage-b-coercion`)

- **(a) `guardedRefCast` dedup** — extract one helper for the `local.tee → ref.test
  → if (cast_null / null)` idiom copy-pasted 4× in `coercionInstrs`
  (type-coercion.ts) + ~6× in `coerceType`. Pure byte-neutral code-motion.
- **(b) Stage B `emitToPrimitive` façade** over `coerceType`'s inline ref→f64
  ToPrimitive dispatch — the actual remaining semantic close (Step 2 tail).
  High-risk; gated on both-lane byte-SHA + full equivalence + a host test262 slice;
  measured delta reported to the coordinator before landing.
- **(c) Seal the #2108 gate** (per-token hard fail) after (b) lands.

---

## Problem

Four independently-maintained type-coercion matrices coexist in the WasmGC
backend, and they **disagree semantically**:

- `coerceType` (`src/codegen/type-coercion.ts:980`, ~1,100 lines for one function)
- `coercionInstrs` (`type-coercion.ts:2695-2903`)
- `callArgCoercionInstrs` (`src/codegen/stack-balance.ts:1179-1310`)
- `fixBranchType` (`stack-balance.ts:678-764`), plus `fixLocalSetCoercion`

Observed divergence:
- externref→f64: `callArgCoercionInstrs` calls `__unbox_number` (correct);
  `fixBranchType` emits lossy `drop; f64.const 0` (`stack-balance.ts:724-728`).
- ref→f64: `coercionInstrs` pushes `f64.const NaN` (line 2786);
  `fixBranchType` pushes `0` (lines 737-742).

So the runtime value a coercion produces depends on *which syntactic context
triggered it* — call argument vs branch result vs local.set. Additionally,
the guarded-ref-cast idiom (tee tmp → ref.test → if/then cast / else null) is
copy-pasted ≥6 times within type-coercion.ts alone (1026-1048, 1067-1089,
2820-2834, 2843-2857, 2865-2878, 2885-2898).

## Proposed approach

1. Extract a single `coercionPlan(from: ValType, to: ValType, ctx) →
   { instrs: Instr[] } | { needsTemp: ... } | { lossy: true, instrs }` table
   in `type-coercion.ts`.
2. Consume it from all four call sites; delete the local matrices.
3. `lossy` arms emit a located diagnostic (ties into #1918's strict mode) —
   a lossy coercion in a branch fixup is an emitter bug being masked, and
   should be visible.
4. Extract one `guardedRefCast(toTypeIdx)` helper for the 6+ copies.
5. Add table-driven unit tests: for every (from, to) pair, all consumers
   produce identical instruction sequences.

## Acceptance criteria

- One coercion table; `callArgCoercionInstrs`/`fixBranchType` delegate to it.
- The externref→f64 and ref→f64 divergences are gone (branch context unboxes
  / NaNs identically to call-arg context), with a regression test for each.
- Equivalence + test262 CI green.

## Source

Compiler quality review 2026-06. Related: #1918 (fixup ratchet), #1858
(fail-loud umbrella).

## Amendment (2026-06-11, analysis program)

Two corpus-driven changes to this spec (full detail:
plan/log/analysis-2026-06/03-coercion-engine-spec.md and
05-structure-review.md §2a):

1. **The engine API must carry a `staticJsType?` hint.** The June corpus
   proved that dispatching on Wasm ValType alone mis-classifies values —
   the #2072 investigation showed booleans (i32) boxing as numbers,
   undefined/null (externref) as strings, native strings (eqref) as
   objects. A ValType-only engine reproduces that disease. Every entry
   point (`emitToString`, `emitToPrimitive`, `emitLooseEq`, …) takes the
   source expression's static TS classification when resolvable.
2. **The site inventory is larger than this issue assumed.** Report 03
   catalogued 37 sites: 13 ToString (the §7.1.17 matrix hand-rolled 7× —
   incl. template spans string-ops.ts:272-285, join elemToStr
   array-methods.ts:4543, standalone emitArrayJoin :4487+,
   $__any_to_string native-strings.ts:5417), 11 ToNumber/ToPrimitive,
   8 equality, 5 ToBoolean (incl. buildTruthyCheck, #2085). Migration
   order and the per-site bug map live in report 03 §3.

Sequencing: Step 0 (ValType table) is dependency-safe now; Steps 1+ land
AFTER the type-aware boxing P0 (#2072/#2080) so the engine consumes
correct tags. Drift gate: #2108.

## #1960 (Step 1) merge_group park — RESOLVED (sendev-coercion, 2026-06-23)

**Outcome: GENUINE Step-1 regression (NOT drift), now FIXED by reverting the
standalone native `+`-concat ToString migration. All 23 spec tests restored.**

Resolution: commit `7de728208` on `issue-1917-emit-tostring` reverts
`compileNativeConcatOperand` to its original hand-rolled cascade — the sole
standalone-reachable Step-1 change. The host concat/template ToString migrations
STAY (js-host-only, can't affect standalone). The engine number arm gained a
defensive guard (return the scalar unchanged when `number_toString` is
unavailable in native mode). Verified via faithful `runTest262File(…,
"standalone")` reading `.status`: `S9.8.1_A2`, `concat/S15.5.4.6_A3`, `S9.8.1_A6`,
`Number/S9.3.1_A3_T2` all flip compile_error → **pass**; trim/startsWith/replace
controls stay pass. `#2108` string-ops 24 (pre-Step-1) → 19 (still net dedup).
Fix propagated up the stack (tostring → tonumber → toboolean). The `hold` label
removed once the fix is pushed.

**Process lesson (worth remembering):** my first "baseline drift" verdict was
WRONG — caused by a probe bug (read `r.outcome`, always `undefined`, instead of
`r.status`). That made known-pass controls look like failures and fooled me into
"the local harness is broken / it's drift." The correct discriminator was a
genuinely-`pass` control run with the right field on clean-main vs branch. Lesson:
when a local repro disagrees with a CI signal, FIRST verify the repro against a
KNOWN-GOOD control reading the SAME field the source of truth uses — don't trust
a tool that fails its own control. The lead's CI evidence was right all along.

(Original park detail, for the record:)
Step 1 PR #1960 was auto-parked by the bot (`hold` label) on a GENUINE
`merge shard reports` failure: standalone gate net **−23** (`wasm_compile: 21`,
`illegal_cast: 2`), bucket signature **`a4736523aee2aba2`**, cluster =
`built-ins/String/S9.8.1_A*` (ToString spec tests) + `Number/S9.3.1_A*` +
`concat`/`localeCompare`. The standalone-floor gate only runs on `merge_group`,
not PR (memory `project_standalone_floor_only_on_merge_group`), so PR-level
checks were green.

**RETRACTED earlier "baseline drift" verdict — it was built on a BROKEN local
repro and is INVALID.** My local `runTest262File(…, "standalone")` fails a
KNOWN-PASS control (`built-ins/String/prototype/charAt/S15.5.4.4_A1_T1`, one of
12,507 standalone passes) on CLEAN origin/main — so it fails everything
uniformly and CANNOT distinguish #1960's effect from main. The "byte-identical
fails on the pre-Step-1 base" observation just reflects that uniform local
breakage, NOT behaviour-neutrality. The local standalone harness is not
CI-faithful (likely a `buildImports`/`getTestSandbox`/`setExports` /
harness-include gap when calling `runTest262File` directly vs the CI sharded
runner).

**Status: whether #1960 (emitToString) is standalone-neutral is OPEN.** The
lead's CI evidence (merge_group `a8f01c9c` FAILED with #1960 in it, SUCCEEDED
after #1960 was parked out) indicates #1960-correlated and must be trusted over
the broken local repro. The hidden-divergence case stands as a real possibility.
A CI-faithful repro (or an artifact diff: #1960's standalone merged JSONL vs a
clean main-only merge_group's, for the 23 tests) is needed to adjudicate. #1960
stays HELD until resolved.

<!-- SUPERSEDED below: the original "proof" is retained for the record but is
     INVALID per the retraction above. -->

**[SUPERSEDED — INVALID] Earlier (retracted) reasoning that claimed BASELINE
DRIFT. Proof (now known to be from a broken local harness):**

1. Pulled the 23 regressed files from the standalone merged-report artifact + the
   standalone baseline JSONL; ran `diff-test262`. Cluster = `built-ins/String/
   S9.8.1_A*` (the §9.8.1 **ToString** spec tests), `Number/S9.3.1_A*`,
   `String/prototype/concat` + `localeCompare`.
2. Ran the EXACT failing files (`S9.8.1_A2`, `concat/S15.5.4.6_A3`,
   `Number/S9.3.1_A3_T2`, `localeCompare/S15.5.4.9_A1_T1`) through the real
   `runTest262File(…, "standalone")` runner on BOTH the Step-1 branch AND the
   pre-Step-1 merge-base `c4ef3fac2`.
3. They fail **byte-identically** on both (same `any.convert_extern expected
   externref, found f64.const` at the SAME offsets `@+29167`/`@+27034`/`@+34424`).
   Step 1's `emitToString` migration does not touch this path.

So these 23 tests already fail on current `main` independent of #1960; the
standalone baseline JSONL is stale (baseline age was 2h29m at the run). This is
exactly the gate's own warning: "signature `a4736523aee2aba2` … likely baseline
drift — see `feedback_baseline_drift_cross_check`". Distinct from #1958's park
(that one is a REAL `-24` eval-code `assertion_fail` regression in the #1927
pipeline driver — different signature, different category).

**Resolution path (CI-infra, not a code fix):** refresh the standalone baseline
(or revert the `main` commit that regressed these 23 ToString tests), then
re-enqueue #1960. The pre-existing `String(x)`-returns-bare-f64 →
`any.convert_extern` bug in the `String()` / native-concat path is a SEPARATE
real issue (reproduces on `c4ef3fac2`) worth its own ticket — but it is NOT
introduced by #1917 Step 1.

## Implementation — Equality finale, slice E6 (standalone externref loose-eq tail) (sendev-eq, 2026-06-24)

Branch `issue-1917-emit-eq-e5e6`, branched from `upstream/main` (which carries the
merged E3, #1989). The follow-up slice to E3 — the tag-5-sensitive externref
dispatch we deferred — scoped to **pure code-motion** (the behaviour fixes
#1986/#1987/#2081 remain separate).

**What E5/E6 actually is, on current main.** After E3 migrated the four any/any
arms of `compileAnyBinaryDispatch`, there was exactly **ONE** remaining direct
call to a keystone equality helper (`__any_eq`/`__any_strict_eq`) left anywhere in
`binary-ops.ts`: the **standalone externref-vs-externref loose-eq tail**
(`compileStringBinaryOp`, the `noJsHost` arm of the not-eqref-identical branch).
It boxes two opaque `any` externrefs to `$AnyValue` via `__any_from_extern` (tag5
string / tag3 number / tag4 bool / tag1 null) and calls `__any_eq` — the §7.2.15
native IsLooselyEqual (#2081). That is the tag-5-sensitive dispatch; the strict
externref path goes through `__host_eq` + numeric-unbox (NOT the keystone), and
its routing-to-`__any_strict_eq` is the deferred #1986 behaviour change.

**New `emitAnyEqFromExternTemps(ctx, tmpLeft, tmpRight, negate): Instr[] | null`**
in `coercion-engine.ts` — returns the `__any_from_extern`×2 → `__any_eq` →
optional `i32.eqz` instruction SEQUENCE (the caller builds an `Instr[]` for an
`if`-arm, not a live emit), or `null` when the helpers are unavailable so the
caller falls through to its `__host_loose_eq` import exactly as before. WRAPPER,
not a re-derivation: the tag-5 classifier stays in `__any_eq`'s body
(`any-helpers.ts`). With this, the coercion engine now owns **every** keystone
equality-helper invocation; `binary-ops.ts` no longer references `__any_eq`
directly (its `ensureAnyFromExternHelper` import is dropped).

**Byte-neutral (authoritative gate):** `.tmp/e6-neutrality.mjs` compiled 5 programs
exercising the standalone externref loose-eq path (`"1"==1`, `!=`, mixed any/any,
plus a strict-eq control and an object-identity control) on BOTH the gc (host) and
standalone lanes, SHA-256'd `result.binary`, and diffed against a fresh detached
`upstream/main` (E3-inclusive) worktree: **0 byte differences across all 10
(program × lane) outputs** — including the `standalone` cases E6 actually rewrites.

**Behaviour guard:** new `tests/issue-1917-emit-eq-e6.test.ts` — 6 cases (3/lane),
all pass. `"1" == 1 → true`, `"1" != 1 → false`, same-identity object `==` →
true, on both lanes.

**Pre-existing failure confirmed NOT introduced by E6:** `issue-2081.test.ts`'s
`null == undefined → true` (standalone) fails IDENTICALLY on the E3-only
`upstream/main` control — it is the deferred standalone nullish-coercion gap
(#2081's full behaviour fix), not a code-motion regression. Consistent with the 0
byte-SHA diff.

**#2108 ratcheted DOWN:** `binary-ops.ts` 34 → 33 (the last keystone `__any_eq`
call moved into the sanctioned engine). tsc clean, prettier clean.

**Still deferred (separate PRs):** the strict-externref routing-to-`__any_strict_eq`
(#1986 `null===0`), `0===-0` numeric-merge (#1987), and the standalone
nullish/full-coercion widening (#2081) — these are classifier/gate-logic
*behaviour* changes, not dispatch motion.

## Implementation — Equality finale, slice E3 (any/any) (sendev-eq, 2026-06-24)

Branch `issue-1917-emit-eq` (this PR). The LAST step of the dedup series, phased:
**E3 (any/any) first** as the cleanest byte-neutral wrapper; E5/E6
(tag-5-sensitive externref typed-side boxing) deferred to a separate isolated PR
with extra standalone scrutiny vs the frozen #1888 −794 contract; the deferred
behaviour fixes #1986/#1987/#2081 stay separate (they are classifier-side, not
dispatch-side).

**New `emitStrictEq(ctx, fctx, expr, negate)` / `emitLooseEq(ctx, fctx, expr,
negate)`** in `coercion-engine.ts` — the **dispatch layer** for `any`-operand
equality. They select the helper (`__any_strict_eq` for `===`/`!==`; `__any_eq`
for `==`/`!=`), marshal both operands into the boxed `(ref null $AnyValue)` shape
via the shared `emitAnyEqOperands` helper (the verbatim #1211 boxing sequence),
emit the `call`, and apply the `!=`/`!==` `i32.eqz` negation. They return
`{ kind: "i32" }`, or `null` (helper unavailable / operand failed) so the caller
falls back exactly as before.

**WRAPPER, not a re-derivation (the load-bearing invariant).** The hard part —
the §7.2.15 tag-5 field-4 3-way classifier (`tag5StringEqThen`: genuine-string
content-eq → `__str_equals`; `$BoxedNumber` → `__any_to_f64`+`f64.eq`; both-eqref
objects → `ref.eq`; else conservative content-eq, the unified #2040/#2585 spec) —
lives ENTIRELY in the `__any_eq`/`__any_strict_eq` helper *bodies*
(`any-helpers.ts`). The engine never copies that logic; it only chooses the
helper and boxes the operands. Folding a second classifier copy here would
reproduce the #2585/#2040 disease this issue exists to prevent.

**Migrated:** the four equality arms of `compileAnyBinaryDispatch`
(`binary-ops.ts`, the `compileAnyBinaryDispatch` tail) now early-return into
`emitLooseEq`/`emitStrictEq`; the `__any_eq`/`__any_strict_eq` rows are removed
from the helper-name switch (a comment marks why they never reach it). The
non-equality arms (`+`/`-`/`*`/`/`/`%`/`<`/`>`/`<=`/`>=`) are untouched.

**Byte-neutral by construction:** the extraction reproduces the SAME helper
selection, the SAME operand-boxing sequence (`compileExpression` → `isAnyValue`
guard → `coerceType(ref_null $AnyValue)`), and the SAME `i32.eqz` negation —
verified identical to the prior in-worktree implementation and gated by both-lane
(host + standalone) Wasm-byte-SHA diff over equality programs + `playground/
examples/` vs a fresh detached `origin/main` worktree (0 status changes required).

**Deferred (NOT in this slice):** E5/E6 typed-side externref boxing (tag-5
sensitive — needs the static-class routing + extra standalone scrutiny); the
behaviour fixes #1986 (`null===0`), #1987 (`0===-0`), #2081 (SA `'1'==1`) — those
are classifier/widening changes, intentionally separate from this neutral
extraction.

**Validation (sendev-eq, 2026-06-24):**
- **Byte-SHA neutrality (authoritative):** `.tmp/eq-neutrality.mjs` compiled 7
  programs (`==`/`===`/`!=`/`!==` on several operand shapes + arithmetic +
  relational controls) on BOTH the gc (host) and standalone lanes and SHA-256'd
  `result.binary`, then diffed against a fresh detached `origin/main` worktree:
  **0 byte differences across all 14 (program × lane) outputs.** This is a
  structural proof the extraction is byte-for-byte identical — it does not depend
  on the test262 harness.
- **Behaviour guard:** new `tests/issue-1917-emit-eq.test.ts` — 12 cases (6 per
  lane) via the real `compile` + `WebAssembly.instantiate`; all pass. Pins each
  lane's established equality behaviour (incl. the pre-existing standalone
  `3 === 3.0 → false` numeric-tag gap, verified identical on `origin/main`).
- **tsc clean, prettier clean.** Removed a now-dead `!=`/`!==` negation block in
  `compileAnyBinaryDispatch` that tsc correctly flagged as unreachable once the
  equality ops early-return into the engine (the prior in-worktree draft of this
  slice had left it in and would not have typechecked).
- **#2108 ratcheted DOWN:** `binary-ops.ts` 38 → 34 (the four equality arms
  migrated into the sanctioned engine); baseline committed. No unsanctioned
  growth.
- **Caveat — local faithful test262 disregarded:** a direct `runTest262File`
  probe failed its KNOWN-PASS control (`charAt/S15.5.4.4_A1_T1`) on clean
  `origin/main` on both lanes — the standard broken-local-harness signature
  (`feedback_verify_local_repro_against_known_good_control`). Its status readings
  are therefore non-authoritative and disregarded; the byte-SHA diff above is the
  neutrality gate, and the CI sharded test262 (faithful) is the conformance gate.

## Implementation — Step 3 in progress (sendev-coercion, 2026-06-23)

Branch `issue-1917-emit-toboolean`, predecessor-stacked on the Step-2 branch.

**New `emitToBoolean(ctx, valType, sink)`** in `coercion-engine.ts` — §7.1.2
ToBoolean → i32, appended into a caller-supplied `Instr[]` sink. Consolidates the
two hand-rolled truthiness sites that #2085 already aligned:
- `ensureI32Condition` (`index.ts`, B1 — the canonical, pushes to `fctx.body`);
  now delegates to `emitToBoolean(ctx, condType, fctx.body)` when `ctx` is
  present (a ctx-free fallback subset stays inline for the few legacy
  no-`ctx` callers).
- `buildToBooleanInstrs` (`array-methods.ts`, B2 — returns `Instr[]`); now
  `return emitToBoolean(ctx, retType, [])`.

The `sink` parameter is what makes one function serve both emission styles
(push-to-body vs return-array). **Behaviour-neutral:** the spec's "B2 is
latently divergent (NaN-truthy)" claim is STALE — #2085 already changed B2 to
`|x|>0` (NaN falsy) explicitly "matching `ensureI32Condition`", so there is no
divergence left to surface; the two are equivalent and the engine's rows are
transcribed verbatim.

**#2108 ratcheted DOWN:** `array-methods.ts` 20→19, `index.ts` 34→33 (the
`__is_truthy` uses moved into the sanctioned engine). No unsanctioned growth.

**Remaining ToBoolean sites NOT in scope (documented for a follow-up):** B3
(filter-extern callback truthiness, partial duplicate) and the B4 compile-time
constant-fold tables (`tryConstantFoldToBoolean`) — these are smaller and B4 is a
static-literal fold, not a runtime cascade.

**One intentional, behaviour-safe divergence from the verbatim transcription:**
the engine guards the native-string arm with `ctx.anyStrTypeIdx >= 0 &&
ctx.nativeStrTypeIdx >= 0` (the original `ensureI32Condition` matched on
`condType.typeIdx === ctx.anyStrTypeIdx` *without* the `>= 0` floor). When native
strings are off, `anyStrTypeIdx` is `-1`; an opaque ref whose `typeIdx` is also
`-1` would have wrongly taken the flatten path in the old code. The guard routes
it to the correct non-null arm instead. This is strictly more correct and is the
common WasmGC-string-helper guard idiom; both-lane neutrality (below) confirms it
surfaces no regression.

**Both-lane neutrality proof (sendev-coercion, 2026-06-23).** Faithful
`runTest262File` probe reading `r.status` (NOT `.outcome`), control (charAt) run
first, executed on BOTH the default JS-host (gc) lane AND `--target standalone`,
then diffed against an identical probe on a detached `origin/main` worktree.
13 truthiness-exercising files × 2 lanes — `if`/`while`/`&&`/`||`/`!`/ternary,
`Boolean(x)`, and `Array.prototype.filter`/`every`/`some` callback truthiness
(the B2 `buildToBooleanInstrs` path). Result: **NEUTRAL — 0 status changes across
both lanes.** Pre-existing fails (charAt both lanes; logical-and standalone) are
identical on main and branch; everything else passes on both. `.tmp/` probe:
`neutrality-toboolean.mts` (gitignored). tsc clean, prettier clean.

**Re-verified post-#1962-landing (sdev-coercion-impl-2, 2026-06-23).** After #1962
(emitToNumber) landed on main (merge `96c7cbcb3`), merged `origin/main` into this
branch — the Step-2 commit `d357aaad1` is now subsumed, so the delta vs main is a
clean **Step-3-only** change (`array-methods.ts`, `coercion-engine.ts`,
`index.ts`; `calls.ts` dropped with Step 2). Re-ran the identical both-lane probe
against a FRESH detached `origin/main` worktree (now carrying emitToNumber):
**NEUTRAL — 0 status changes across both lanes.** tsc + prettier clean. New head
`6e9aba31d`. Stacking-hold lifted (predecessor landed); handed to PR-shepherd.

## Implementation — Step 2 (sendev-coercion, 2026-06-23) — PR #1962

Branch `issue-1917-emit-tonumber`, predecessor-stacked on the Step-1 branch
(`emitToNumber` extends the same `coercion-engine.ts`; PR merges after Step 1).

**New `emitToNumber(ctx, fctx, valType)`** in `coercion-engine.ts` — the
consolidated ToNumber cascade (void→NaN, i64→f64, externref→`__unbox_number`
js-host / `coerceType(f64,"number")` standalone, object-ref→`coerceType(f64,
"number")`, i32→f64, f64 no-op). Externref arm gated on `ctx.standalone`
EXACTLY (not `noJsHost`) to match the migrated `Number(x)` site byte-for-byte
under `--target wasi`.

**Migrated:** the `Number(x)` lowering (`calls.ts` ~:10674) — its post-pre-check
cascade now calls `emitToNumber`. The `#2160` array pre-check, the Symbol-throw,
and the native-string-ref→`__str_to_number` typeIdx-keyed pre-check stay in the
caller (each is a *source* special-case that must run before / dispatches on
facts the engine doesn't carry).

**DEFERRED to a follow-up increment (NOT a missed copy — different ToNumber
policy; folding would REGRESS):** the unary `+`/`-`/`~` arms (`unary.ts`) use
`coerceType(f64)` with the **default** hint for externref/ref operands, whereas
`Number(x)` uses the `"number"` hint / `__unbox_number`. Unifying them neutrally
needs `emitToNumber` to take an explicit `hint` AND careful tracing of
`coerceType(externref→f64)` no-hint vs `__unbox_number` equivalence — a separate
neutrality analysis, deferred rather than risked.

**#2108 ratcheted DOWN:** `calls.ts` 27→26 (the `Number(x)` `__unbox_number` use
now lives in the sanctioned engine). No unsanctioned growth.

## Implementation — Step 1 (sendev-coercion, 2026-06-22; user un-parked) — PR #1960

Branch `issue-1917-emit-tostring`. Phased behavior-neutral consolidation per the
user override (deduplicate the coercion code; equality last/isolated). All Step
1-4 named bugs are already fixed per-site, so EVERY step must be byte-neutral; a
non-neutral step = a hidden divergence to surface, not paper over.

**New `src/codegen/coercion-engine.ts`** — `coercionMode(ctx)` (the three ad-hoc
spellings unified), `emitToString(ctx, fctx, valType, tsType, hint)` +
`compileAndEmitToString(...)`. `emitToString` is the faithful consolidation of
the per-operand ToString cascade the expression-based copies shared
(void→"undefined", i32-bool→true/false, f64/i32/i64→number_toString,
externref-null/undef→literal, externref-string→passthrough,
externref-opaque→`__extern_toString`/`__extern_to_string_default` by hint,
ref→`tryStructToString`+`$__any_to_string` native / `coerceType`(hint) host).
Takes an explicit `hint`: templates/`String()` pass "string"; `+`-concat passes
"default" (the #2022 valueOf-first policy on a ref operand) — so the per-context
policy difference is preserved exactly. `emitBoolToString` /
`emitNativeStringRefFromExternref` are bound lazily from string-ops.ts (cycle
avoidance) via `registerStringHelperEmitters`.

**Migrated (all tsc-clean):**
- `compileAndCoerceConcatOperand` (host batched `__concat_N`) →
  `compileAndEmitToString(…, "default")`.
- `compileTemplateExpression` host span loop → `emitToString(…, "string")` (the
  scalar-lowered null/undef pre-guard stays in the caller — the engine classifies
  by ValType and would stringify the i32-0 sentinel as "0").
- `compileNativeConcatOperand` (standalone `+`-concat operand) →
  `emitToString(…, "default")`. Kept the `#2007 tryCompileNativeVecConcatOperand`
  pre-check + the unknown-kind `return false` fall-through in the caller. All
  callers are `noJsHost`-gated, so the engine's native externref tail
  (`__extern_toString` + `emitNativeStringRefFromExternref`, NO `__str_from_extern`
  bridge) is exactly right.

**DEFERRED to a follow-up Step-1 increment (NOT a missed copy — each needs an
engine extension; folding blindly would REGRESS = the hidden-divergence trap):**
- `compileNativeTemplateExpression` — runs in BOTH standalone AND
  native-strings-host mode; in native-strings-host it marshals via the
  `__str_from_extern` externref bridge (`fromExternIdx`) the engine does not model
  (it uses `emitNativeStringRefFromExternref` for both native modes). Concat
  operand was safe only because it is standalone-ONLY.
- `String()` lowering (calls.ts ~:10805) — heavy pre-processing (empty/null/undef
  literals, Symbol descriptive string, array→toString, RegExp→toString) wraps the
  generic cascade and each arm returns a ValType; careful extraction, next.
- array-`join` `elemToStr` (array-methods.ts ~:5240) — operates on a raw array
  SLOT (i8/i16/f64/externref), `$Hole`-aware; folds only once `emitToString`
  grows a slot-source variant.

**Cross-mode policy facts the engine now encodes (were implicit per-copy):**
templates/`String()` hint = "string"; `+`-concat hint = "default" (#2022
valueOf-first ref policy). The `__extern_to_string_default` default-hint externref
tail applies ONLY in js-host mode; native modes always use `__extern_toString`.

**Pending before PR:** ratchet `#2108` baseline DOWN for the migrated files;
diff-neutrality over `playground/examples/`; standalone + host string suites;
merge_group full-baseline watch.

## Implementation — Step 0 landed (sdev1, 2026-06-15)

**Scope: Step 0 only** (the ValType `coercionPlan` table). Steps 1-4 (the
JS-semantic `emitToString`/`emitToPrimitive`/`emitStrictEq`/`emitLooseEq`
engine) remain — they land after value-rep P0 (#2072/#2080, now done) per the
spec's migration order; this issue stays `in-progress` until they do.

### What landed

- **New `src/codegen/coercion-plan.ts`** — a single **pure** function
  `coercionPlan(from: ValType, to: ValType, {boxNumberIdx, unboxNumberIdx})`
  returning the exact instruction sequence for the **scalar / numeric /
  box-unbox** rows the three ValType matrices shared, plus a `lossy` flag for
  the genuine no-bridge rows (funcref→externref; ref→number with no unbox
  helper available → NaN/0 per §7.1.4).
- **`callArgCoercionInstrs` (stack-balance.ts)** delegates its scalar rows to
  `coercionPlan`; keeps only the externref→ref/ref_null guarded cast (needs the
  expected struct typeIdx).
- **`fixBranchType` (stack-balance.ts)** now routes scalar/box-unbox
  conversions through `coercionPlan`, threading `boxNumberIdx`/`unboxNumberIdx`
  down through `fixBranch`/`fixBody` from `stackBalance`. **This kills the
  headline divergence**: it previously emitted lossy `drop; f64.const 0` for
  externref→f64 and ref→f64 (silently zeroing the value during a stack-balance
  fixup) while the call-arg path correctly unboxed via `__unbox_number`. It
  also fixed a latent funcref→externref bug (old code emitted an INVALID
  `extern.convert_any` on a funcref; the table now uses the lossy null
  fallback, matching `coercionInstrs`).
- **`coercionInstrs` (type-coercion.ts)** delegates its non-ref scalar rows to
  `coercionPlan` (kept its own `ref→f64=NaN` / AnyValue→externref helper /
  guarded ref.cast arms, which need `ctx`/`fctx` and a deliberately different
  ref ToNumber policy — those are Step 2 engine concerns, not Step 0).

### Why ref→f64 differs between consumers (intentional, for now)

`callArgCoercionInstrs`/`fixBranchType` unbox a `ref` carrying a boxed number
(`extern.convert_any; __unbox_number`); `coercionInstrs` NaNs a bare GC ref
(ToNumber of an object without valueOf). Step 0 unifies the **box-unbox** rows
that were genuinely divergent-by-accident; the ref→f64 *policy* split is real
JS semantics that the Step 2 `emitToPrimitive` engine will own with a
`staticJsType` hint (boxed-number-ref vs object-ref). Step 0 does not force
them together to avoid changing array-callback-loop ToNumber behavior.

### Validation

- `tests/issue-1917-coercion-plan.test.ts` — 10 table-driven unit cases
  (asserting the exact sequence per `(from,to)` incl. the non-lossy externref→f64
  / ref→f64 guarantee) + 4 end-to-end any→number regression cases (host +
  standalone). All pass.
- Behavior-neutral: full `tests/equivalence/` dir green (exit 0); coercion +
  stack-balance suites unchanged (the 2 pre-existing `stack-balance.test.ts`
  failures and the IR-fallback/void-NaN equivalence failures reproduce
  identically on unmodified HEAD).
- `tsc --noEmit` clean; lint/format clean; `check:ir-fallbacks` OK.

### Next (Steps 1-4, separate PRs, now unblocked by #2072/#2080)

`coercion-engine.ts` skeleton + `emitToString` (Step 1, fixes #2005/#2006/
#1998/#2074), `emitToPrimitive` (Step 2, #1989/#2022/#1990/#1988),
`emitStrictEq`/`emitLooseEq` (Step 3, #1986/#1987/#2081), `emitToNumber`/
`emitToBoolean` (Step 4), then the drift gate (Step 5, #2108).

---

## Implementation Plan — Steps 1-5 (architect, 2026-06-21; consolidated against current main, folds in value-rep keystones)

> **Re-grounding note.** This plan supersedes the bare "Next" line above and
> concretizes report `plan/log/analysis-2026-06/03-coercion-engine-spec.md`
> (the full site inventory — read it; it is still authoritative for the §2
> per-site bug map). Two things changed since report 03 was written (2026-06-11)
> and MUST be folded in rather than re-derived:
>
> 1. **The drift gate (#2108) is already built and wired** —
>    `scripts/check-coercion-sites.mjs` + `scripts/coercion-sites-baseline.json`,
>    `package.json:98` `check:coercion-sites`, run in the `quality` CI job. It
>    already SANCTIONS `coercion-engine.ts` (which does **not exist yet** — it is
>    pre-listed so the gate is live the moment Step 1 creates the file),
>    `any-helpers.ts`, `native-strings.ts`. So Step 5 is **NOT "build the gate"**
>    — it is "ratchet the baseline to ~0 and flip the seal". Every migration PR
>    (Steps 1-4) MUST ratchet the baseline DOWN (`pnpm run check:coercion-sites
>    -- --update-on-decrease`) for the files it drains, or CI's growth check
>    stays flat and the migration shows no progress. **Never let a step grow a
>    per-file count** — that fails the `quality` gate.
> 2. **The value-rep keystones landed.** `#2187`/`#2576` (string-method dispatch
>    by ValType — DONE), `#2583` ($Vec-base any-array brand dispatch — task #27
>    done), `#2584` (dot-vs-bracket dual storage — task #28 done), and the
>    **unified tag-5 field-4 equality spec** (`#2040`/`#2585`, arch commit
>    `4cfb5b9c6`, in-flight impl = task #32 on `sdev-vecdispatch`). Step 3
>    (`emitStrictEq`/`emitLooseEq`) **does not re-derive the equality classifier**
>    — it WRAPS the helper that task #32 produces. See Step 3 below.

### Hard constraint that shapes every step: the tag-5 representation lie is frozen

`boxToAny` (`src/codegen/value-tags.ts:139`, the renamed/relocated successor to
report 03's `type-coercion.ts:1207-1219`) deliberately boxes a generic externref
as **tag 5 / STRING** (`value-tags.ts:185`, `return emit("__any_box_string")`).
This is the #1888 `−794` contract: honest tag recovery at the box site flipped
−794 standalone test262 because the harness `isSameValue` comparator is tuned to
the lie (#2141 tracks retiring it; **blocked on #2167, do not touch it here**).

**Consequence for this engine:** the engine MUST classify by `staticClass`
(static TS type) at emit time wherever resolvable, and where it must fall to the
dynamic tail it MUST go through the **consumer-side** discriminators
(`ref.test`/`ref.eq` over field-4) that the keystone helpers already use — NOT
by trusting the runtime tag for tag-5 values. `__any_to_f64`'s #1888
`$BoxedNumber` recovery arm (`any-helpers.ts:866-905`, gated
`ctx.nativeBoxNumberTypeIdx >= 0`) and the unified eq classifier are the model.
Any engine row that assumes "tag 5 ⇒ it's a string" reproduces the #2585/#2040
disease. This is the single most important invariant in the whole migration.

### Engine API (Step 1 establishes it; current-main types)

Create `src/codegen/coercion-engine.ts`. Exactly the shape from report 03 §3.1,
with these current-main bindings:

- `CoercionMode = "js-host" | "native-strings-host" | "standalone"` — derive
  ONCE from the three ad-hoc spellings that exist today (`noJsHost(ctx)`;
  `ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0`; `ctx.wasi || ctx.standalone`).
- `Operand { valType: ValType | null; staticClass: StaticClass }`. `StaticClass`
  is the classifier from report 03 §3.1; it reuses the **existing** static-type
  facts the matrices already compute — do not invent a parallel type system.
  Source the TS classification from the same `JsStaticType` that `boxToAny`
  already takes (`value-tags.ts:139` param `jsType: JsStaticType`) so the engine
  and the box site agree on the value's static identity.
- Emitters write into an optional `sink?: Instr[]` (default `fctx.body`) so the
  loop builders (join `elemToStr` at `array-methods.ts:5173`, the callback
  truthiness builders) can capture an `Instr[]` instead of emitting inline —
  this is required, the join path constructs an instr array, not a live emit.
- **Representation changes delegate to Step 0's `coercionPlan`**
  (`src/codegen/coercion-plan.ts`, `coercionPlan(from, to, helpers)`). The engine
  is the JS-semantic layer ON TOP; it calls `coercionPlan` for the final
  ValType→ValType bridge and never re-hand-rolls a box/unbox row.

The engine is, per emitter, **one switch over `staticClass` × one switch over
`coercionMode`**, one row per (class, mode). Symbol rows throw TypeError
(absorb `tryThrowOnSymbolStringCoercion`, `emitSymbolToNumberThrow`).

### Step 1 — `emitToString` + skeleton (highest bug density; PR-sized)

**Fixes:** #2005 (`${true}`→"1"), #2006 (`${null}` illegal-cast trap), #1998
(array `join` externref elems trap), #2074 (native-string ref elems null-deref).
Regression-guards the #1997/#2007/#2008 family.

**Files & current-main anchors (verify each before editing — line numbers
drifted from report 03):**

- `src/codegen/string-ops.ts`
  - `compileTemplateExpression` (now `:311`, host templates) — **broken site S4**:
    no bool→"true"/"false" arm (#2005), no null→"null" arm (#2006), opaque
    externref passed raw. Replace its span-conversion with `emitToString`.
  - `compileNativeTemplateExpression` (now `:442`, NS+SA) — **broken site S5**:
    no bool branch (#2005 native half). Same replacement.
  - `compileNativeConcatOperand` (`:127`) and `compileAndCoerceConcatOperand`
    (the batched `__concat_N` site) and the `compileStringBinaryOp` inline
    left/right arms — these are the **correct reference copies** (S1/S2/S3);
    migrate mechanically (behaviour-neutral, diff-checked), they become thin
    `emitToString` callers. `emitBoolToString` (`:380`, `:519`) is the leaf —
    move it INTO `coercion-engine.ts` as a non-exported internal so the seal
    (Step 5) has no exported bypass.
- `src/codegen/array-methods.ts`
  - `compileArrayJoinNative` `elemToStr` (now `:5173`, the `Instr[]` builder) —
    **broken site S7**: handles only f64/i32 (#1998 trap on externref elems,
    #2074 null-deref on native-string ref elems). Build `elemToStr` via
    `emitToString(ctx, fctx, op, sink=elemToStr)`. This is the `sink` motivating
    case.
- `src/codegen/expressions/calls.ts`
  - `String(x)` lowering (report 03 S6, region ~`:8051`+; **re-locate**, calls.ts
    has been split since) — fourth full copy; becomes an `emitToString` caller.

**Dynamic tails stay shared helpers (do NOT inline):** `$__any_to_string`
(`native-strings.ts`, SA tail) and `__extern_toString` (`runtime.ts`, host tail).
The engine's tag-5/dynamic arm calls the mode-appropriate one. **Tag-5 caveat:**
the SA `$__any_to_string` already tag-dispatches over `$AnyValue`; the engine
must hand it the externref unchanged (no "assume string" shortcut like the
current S4 line that says "externref assumed to be string already").

**Ratchet:** after migrating, run `pnpm run check:coercion-sites --
--update-on-decrease`; the per-file counts for `string-ops.ts`,
`array-methods.ts`, `calls.ts` MUST drop. Commit the new baseline.

**Test gate:** repro tests for #2005/#2006/#1998/#2074 (host + standalone),
plus a diff-neutrality pass over `playground/examples/` (reuse the IR-fallback
walker corpus) to prove already-correct programs emit identical Wasm.

### Step 2 — `emitToPrimitive` (+ `+` hint routing)

**Fixes:** #1989 (name-keyed valueOf dispatch — last same-shape literal wins),
#2022 (`+` pre-commits to string concat before ToPrimitive), #1990
(`host_loose_eq` throws on opaque struct with valueOf), #1988 (`__any_to_f64`
ref/string tags fall through to garbage f64val → `1+{}`→NaN).

**Files & anchors:**

- `src/codegen/type-coercion.ts`
  - The `coerceType` ref→f64 ToPrimitive static dispatch (report 03 N3,
    region ~`:1713`+). The **eqref path is the broken half** (#1989) — dispatch
    keyed by struct *type name*. Move the ToPrimitive internals into the engine
    `emitToPrimitive`; keep `coerceType(…, hint)` as a **façade** delegating to
    the engine (do NOT touch its ~100 callers in this PR — report 03 §6 risk).
    Fix #1989 per its own Implementation Plan: per-instance funcref dispatch
    (literals.ts field typing + eqref-path demotion), not name-keyed.
  - `emitToPrimitiveHostCall` / `toPrimitiveHostCallInstrs` (N4, `:94-160`) →
    move into the engine as the host tail chokepoint.
- `src/codegen/any-helpers.ts`
  - `__any_to_f64` (N6, builder around `:830`+; #1888 recovery arm `:866-905`).
    Fix #1988: the ref/string tag arms must do ToPrimitive(number) — route the
    tag-5 externval through the engine's number-ToPrimitive tail, then the
    existing `$BoxedNumber` recovery for genuine boxed numbers. `__any_add`
    (the SA `+` helper) then does ToPrimitive(default) on ref operands before
    re-dispatching concat-vs-add — this is the #1988/#2058 `[]+[]`/`1+{}` fix.
- `src/codegen/binary-ops.ts`
  - `+` operator hint routing (N7, the `compileStringBinaryOp` early-return at
    `:1061`/`:1096`/`:1099`). **#2022 fix:** for ref operands, call
    `emitToPrimitive(op,"default")` FIRST, then branch concat/add on the
    returned primitive `Operand` — do not pre-commit to the string-concat path
    on a string-typed operand. Keep the operator control flow; only the
    conversion source changes.
- SA tail: call #1900's native `$Object` OrdinaryToPrimitive helper
  (`index.ts` ~`:2286` region, PR 1251) — **do not re-implement it**. If #1900
  is still in-review when this lands, the façade isolates the target (report 03
  §6); thread it as the SA `emitToPrimitive` tail.

**Ratchet:** `type-coercion.ts`, `binary-ops.ts`, `any-helpers.ts` (the call
sites, not the sanctioned helper bodies) counts drop. Commit baseline.

**Test gate:** #1989/#2022/#1990/#1988 repros + #2058 (`'1'+1`, `[]+[]`,
`1+{}`) + diff-neutrality.

### Step 3 — `emitStrictEq` / `emitLooseEq` (FOLD INTO the keystone, do not re-derive)

**Fixes:** #1986 (`===` looser than `==`: `null===0`→true), #1987
(`__any_strict_eq` bails on tagA≠tagB before numeric compare → `0===-0`→false),
#2081 (SA any/any loose eq is ref-identity only: `'1'==1`→false), #2073 (SA
`__host_loose_eq` import leak — fix already in flight, engine absorbs its inline
ToNumber closure).

**CRITICAL — this step is a WRAPPER, not a rewrite.** The hard part of equality —
the **tag-5 field-4 3-way classifier** — is owned by the unified spec
(#2040 / #2585, arch commit `4cfb5b9c6`) and being implemented by
**task #32** (`sdev-vecdispatch`, `fix(#2040/#2585)`). That classifier lives in
the **`__any_strict_eq` / `__any_eq` helper bodies** (`any-helpers.ts`, builders
at `:1482` / `:1221`) and does:
- both field-4 externvals genuine strings → `__str_equals` (content);
- either is a `$BoxedNumber` (`ref.test nativeBoxNumberTypeIdx`) →
  `__any_to_f64`+`f64.eq` (keeps `23===23.0` true, `NaN===NaN` false);
- both eqref objects → `ref.eq` (the #2585 proto-identity fix);
- else → conservative content-eq (today's behaviour).

`emitStrictEq`/`emitLooseEq` in the engine are the **dispatch layer that decides
WHICH helper to call and on which boxed operands** — they must NOT contain a
second copy of the classifier. Specifically:

- `src/codegen/binary-ops.ts` equality sites E1-E8 (E2 `__host_loose_eq` at
  `:872`/`:947`/`:952`; E3 `__any_eq`/`__any_strict_eq` dispatch; the
  single-side-any path E4; SA tag dispatch E6) collapse into `emitStrictEq` /
  `emitLooseEq` calls.
- **#1986 fix:** the single-side-any case must BOX the non-any side and route to
  `__any_strict_eq` (so `===` uses the same algorithm as `==`), not fall to the
  numeric `__any_to_f64`+`f64.eq` path that makes `null===0` true. The gate at
  report 03's `:906-908` ("both sides any") is the bug — widen it to "either side
  any" with boxing of the typed side.
- **#1987** is fixed INSIDE the keystone classifier (numeric branch before the
  tag mismatch bail) — the engine just needs to call the fixed helper.
- **#2081 / #2073:** the SA loose-eq tail is the keystone helper plus a
  ToNumber/string-content arm; reuse Step 4's `emitToNumber` (which owns
  `__str_to_number`) — do NOT let #2073's inline `emitToNumber` closure
  (report 03 N9) survive as a 2nd ToNumber matrix; absorb it.
- **Sequencing:** Step 3 BLOCKS ON task #32 landing (the classifier must exist
  before the engine wraps it). If task #32 has merged by the time Step 3 starts,
  this is a clean wrap; if not, Step 3 waits. Do not fork the classifier.

**Ratchet:** `binary-ops.ts` count drops sharply (it is the single largest at
38 in the baseline). Commit baseline.

**Test gate:** #1986/#1987/#2081 repros + #2585 proto-identity (regression-guard
the keystone) + #2073 SA loose-eq + diff-neutrality.

### Step 4 — `emitToNumber` + `emitToBoolean`

**Fixes:** the latently-divergent `buildTruthyCheck`/`buildFalsyCheck` (report 03
B2 — `f64.ne 0` counts NaN truthy; `ref.is_null` counts boxed `0`/`""`/`false`
truthy) — **file this as an issue in this PR** (no number yet per report 03).
Unifies N1 (unary `+`/`-`/`~`) and N2 (`Number(x)`) ToNumber matrices.

**Files & anchors:**

- `src/codegen/expressions/unary.ts` (N1, `:45-165`) and
  `src/codegen/expressions/calls.ts` `Number(x)` (N2, ~`:7907`, re-locate) →
  `emitToNumber`.
- `src/codegen/array-methods.ts` `buildTruthyCheck`/`buildFalsyCheck` (B2,
  region ~`:5121` in report 03, re-locate) and the filter-extern callback
  truthiness (B3) → `emitToBoolean`. This is where the engine's `sink` matters
  again (predicate builders construct `Instr[]`).
- Dynamic tails: `__any_to_f64` (now correct from Step 2), `__str_to_number`
  (`parse-number-native.ts`, SA), `__is_truthy`/`__any_unbox_bool` (host/any).
  `ensureI32Condition` (`index.ts` ~`:11687`, the canonical-ish ToBoolean with
  25 call sites) stays as the primary ToBoolean entry but **delegates its body**
  to `emitToBoolean` so B1 and B2 share one row table.

**Ratchet:** `unary.ts`, `calls.ts`, `array-methods.ts`, `index.ts` counts drop.
Commit baseline.

**Test gate:** `[NaN].filter(x=>x)` drops NaN; boxed-`0`/`""`/`false`
predicates are falsy; unary/`Number()` parity + diff-neutrality. (#1955-family
variadic `fromCharCode`/`fromCodePoint` lowering is a SEPARATE follow-up — it is
arg-forwarding drift, not coercion; do not pull it in.)

### Step 5 — seal the gate (ratchet to ~0, flip to hard)

The gate already exists (#2108). After Steps 1-4 have ratcheted each file's
count down, this step:
1. Confirms the per-file baseline counts are at their floor (the irreducible
   residue is the sanctioned helper bodies + any deliberately-deferred sites,
   each annotated).
2. Moves the remaining engine-internal leaves (`emitBoolToString`,
   `compileNativeConcatOperand`, `compileAndCoerceConcatOperand`,
   `emitToPrimitiveHostCall`) INTO `coercion-engine.ts` as **non-exported**
   internals, and adds the single `ensureCoercionImport()` chokepoint so the
   host-import names have no exported registration path outside the engine
   (report 03 §5.2).
3. Tightens `check-coercion-sites.mjs` from "growth fails" to "any nonzero
   count outside the engine fails" for the tokens whose migration is complete
   (per-token seal, not all-or-nothing — a token seals as soon as its sites are
   all drained).

### Migration order, sequencing & regression plan

- **Order:** 1 → 2 → 4 → 3 → 5 is also acceptable (Step 3 blocks on task #32;
  Step 4's `emitToNumber` is a Step 3 dependency for the SA loose-eq tail, so if
  task #32 is slow, do 1, 2, 4, then 3, then 5). Report 03's 1→2→3→4→5 assumes
  the classifier is ready; honour whichever unblocks first.
- **Each step independently green-mergeable**, ends with: (a) repro tests for
  its named issues, (b) diff-neutrality over `playground/examples/`, (c) a
  RATCHETED `coercion-sites-baseline.json` (counts strictly down for migrated
  files — verify with `pnpm run check:coercion-sites`), (d) `tsc --noEmit`,
  lint/format, `check:ir-fallbacks` clean.
- **Do NOT regress the #2108 gate:** the gate fails on per-file *growth*. Adding
  an `emitToString` call site in `coercion-engine.ts` is free (sanctioned file);
  but if a migration accidentally leaves a NEW hand-rolled token in a
  non-sanctioned file (e.g. a helper extracted to a new file that isn't
  sanctioned), the count grows and CI fails — keep all engine code in the
  already-sanctioned `coercion-engine.ts`/`any-helpers.ts`/`native-strings.ts`.
- **#1888 −794 / −788 contract:** no step changes the boxing (`boxToAny`,
  `value-tags.ts:185`) or the tag table. Steps 1-4 are consumer-side only. CI
  must show no net standalone test262 regression per step (the keystone-touching
  Step 3 is the one to watch — the full-baseline `merge_group` run is gated per
  the #2585 escalation; honour it).
- **`coerceType` entanglement:** Steps 2/4 extract via a delegating façade,
  never a big-bang rewrite of the 1100-line function (report 03 §6).
- **funcidx shifting:** engine tails registered via `ensureLateImport` keep the
  `flushLateImportShifts` discipline (the `addUnionImports` caveats in CLAUDE.md
  apply unchanged); centralizing them in the engine removes a class of
  mid-body-registration index bugs.

### Risks / open questions

- **Task #32 (the equality classifier) is the long pole for Step 3.** Until it
  lands, Step 3 cannot be a clean wrapper. Mitigation: do Steps 1/2/4 first.
- **#1900 (native ToPrimitive) in-review** — if PR 1251 churns, Step 2's SA tail
  target moves; the façade isolates it.
- **Bug-corpus issues remain individually fixable** — nothing here blocks
  #2005/#2006/etc. landing solo first, but each such fix MUST land **as the
  engine row** (Step 1 can split per-issue if scheduling prefers), never as an
  8th hand-rolled copy. The #2108 gate enforces this.

## Downstream signal — standalone `Cannot convert object to primitive` (3,622, /harvest 2026-06-24)

The single largest standalone runtime-failure bucket — `Cannot convert object
to primitive value` at **3,622** records on run `426e28e8` (host lane: 48) — is
a key **acceptance signal** for this engine. After #2503 closed the operator
*routing* slice, the residual is diffuse and substrate-shaped: the shared
standalone ToPrimitive/ToNumber path reached through `Object.{defineProperty,
create,getOwnPropertyDescriptor}` (~720), `{Array,String,TypedArray}.prototype`
method args (~690), RegExp, and class/destructuring coercion. That is the exact
`ref→f64` / `__to_primitive` divergence this issue unifies. Use this bucket
dropping substantially as a coarse post-unification check; the String/Number
slice is owned by **#2160** (`depends_on: [1917]`). Drift note + breakdown in
**#2503** (Harvest update 2026-06-24).

## Stage A + Stage B outcome — criterion #2 RATIFIED, relocation → #3578 (sdev-1917, 2026-07-24)

**Stage A LANDED (PR #3562):** extracted one `guardedRefCastInstrs` helper
replacing the 11 copy-pasted `tee → ref.test → if (cast_null / null)` guarded-cast
idioms in `type-coercion.ts` (7 in `coerceType`, 4 in `coercionInstrs`); net −106
lines, byte-neutral (0 Wasm-SHA diffs across 62 both-lane binaries).

**Criterion #2 is RATIFIED as SUPERSEDED (coordinator, 2026-07-24)** — it is NOT a
bug and NOT in scope. The `ref→f64` split — a *bare* GC object-ref ToNumber → NaN
(§7.1.4, `Number(object without valueOf)`) vs a ref *carrying a boxed number* →
unbox — is spec-correct provenance-dependent behaviour, not the accidental
divergence #1917 was filed to fix (that one — `externref→f64` in `fixBranchType`,
lossy `drop; f64.const 0` — is already GONE via Step 0's `coercionPlan`
delegation). Forcing ValType-level identity between the two rows would REGRESS
correct semantics. Do NOT equalize them.

**Stage B measured outcome — byte-neutral extraction PROVEN feasible; clean
relocation deferred to #3578.** Lifting the ~440-line `ref→f64`
ToNumber/OrdinaryToPrimitive dispatch (`coerceType` ~2333–2772) into a dedicated
`emitRefToNumberPrimitive` is byte-neutral (0 diffs across 62 both-lane binaries +
24 ToPrimitive exercisers identical, tsc clean). BUT a **same-file** extraction is
structurally self-defeating: it GROWS `type-coercion.ts` by ~+34 LOC (wrapper
overhead → trips the #3102 LOC ratchet) and leaves the #2108 count unchanged. The
value only materialises by relocating the dispatch OUT into the #2108-sanctioned
`coercion-engine.ts` — which is blocked by the `coercion-engine.ts ⇄
type-coercion.ts` module-init cycle (the reverse import is the exact TDZ hazard the
line-~2660 comment and #3324 avoid) and needs the lazy-emitter-registry pattern
(already at `coercion-engine.ts:~691`) plus relocating 4 non-exported helpers.
That XL/high-risk relocation + the Stage C #2108 seal is now **#3578**
(`depends_on: [1917]`). #1917's core (single `coercionPlan` table + 4-site
delegation + the `coercion-engine.ts` `emitTo*`/equality engine + #2108 drift
gate) plus Stage A dedup is complete; the relocation is the last refinement,
owned by #3578.
