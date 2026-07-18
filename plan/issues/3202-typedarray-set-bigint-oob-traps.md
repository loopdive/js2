---
id: 3202
title: "CI-sharded-only +4 oob on 4 unsupported-BigInt TypedArray.set tests — nondeterministic ratchet classification (main is 58, NOT 62)"
status: done
completed: 2026-07-17
created: 2026-07-12
priority: medium
feasibility: medium
task_type: bug
area: ci
language_feature: typed-array
goal: crash-free
sprint: current
horizon: m
related: [3189, 3173]
# loc-budget-allow retired by #3358: the +LOC this granted was the
# TypedArray.set bounds check, now relocated to src/codegen/typed-array-set-bounds.ts.
origin: "The #3189 uncatchable-trap ratchet fired oob 58->62 (+4) on EVERY merge_group, wedging the queue. Re-diagnosed 2026-07-12 (dev-find-wasm): main HEAD is verifiably 58 (baseline promoted from main commit c660e830; `git log c660e830..origin/main` = ONLY doc commits; freshly-fetched promoted baseline reads 58; the 4 named tests are `fail`/'undefined is not a constructor' on both baseline and main HEAD, not oob). So the +4 is SPECULATIVE-MERGE / CI-sharded-only, NOT a main regression — a promote-baseline 'refresh to 62' is impossible (it reflects main = 58; the attempted refresh left it at 58). Unwedged via the ratchet's own designed valve TRAP_RATCHET_TOLERANCE=4 (repo var, PR #2963)."
---

# #3202 — TypedArray.prototype.set BigInt args emit uncatchable oob traps

## Problem

The #3189 uncatchable-trap ratchet caught the `oob` trap category growing
**58 -> 62 (+4)** on main HEAD (`9626103a`). Four `TypedArray.prototype.set`
BigInt tests newly emit an **uncatchable Wasm `oob` trap** where they should
either pass or throw a **catchable** JS error (RangeError/TypeError). An
uncatchable trap escapes `try`/`catch` and aborts the whole test file (#3179),
so each one poisons every test that shares the pattern — exactly the robustness
the crash-free goal + the #3189 ratchet exist to protect.

### The 4 newly-trapping tests

- `test/built-ins/TypedArray/prototype/set/BigInt/array-arg-offset-tointeger.js`
- `test/built-ins/TypedArray/prototype/set/BigInt/array-arg-primitive-toobject.js`
- `test/built-ins/TypedArray/prototype/set/BigInt/typedarray-arg-offset-tointeger.js`
- `test/built-ins/TypedArray/prototype/set/BigInt/typedarray-arg-set-values-diff-buffer-same-type.js`

These exercise `%TypedArray%.prototype.set(source, offset)` where `offset`
undergoes `ToInteger` coercion and the source is an array / typedarray, on a
BigInt-element typed array.

## Root cause (RE-SCOPED 2026-07-12 — the +4 is NOT on main)

**Prior suspects #3162 / #3183 / #3190 / #2947 are RULED OUT.** The +4 does not
exist on main (main HEAD is 58 — see `origin` above, three-way verified), so no
merged PR introduced it:

- #2947 — disproven by dev-number-resid's revert-and-diff A/B (0 per-test change).
- #2954/#3190 — its `$__vec_base` write fill is bounds-GUARDED ("OOB/negative
  store → silent no-op, no trap"), so it introduces no oob (diff read directly).
- #3162 (my two-arm `find`) touches only find/findIndex dispatch, not `set`.
- #3183 landed BEFORE the baseline source commit c660e830, so its effect is
  already reflected in the 58 baseline (still `undefined-constructor`, not oob).

The +4 appears **only in the merge_group's speculative merged-state run**, never
on main — that is why re-admits re-park and never-batched PRs (#2960/#2959) park
on the identical delta. The 4 tests are BigInt `%TypedArray%.prototype.set`
tests whose constructor is `undefined` (BigInt typed arrays unsupported) on main
— they score `fail`/"undefined is not a constructor", not `oob`.

**Two hypotheses to investigate:**

1. **CI-sharded nondeterminism** — a shard-dependent / load-dependent
   classification flips these 4 to `oob` intermittently in the sharded merged
   run (most likely given they're a stable `fail` on main + baseline).
2. **A genuine speculative-merge trap** — some queued PR, when speculatively
   merged, defines the BigInt constructor AND the `set` offset-bounds then falls
   to an unguarded `array.set`. If so, identify the PR and fix its `set`
   offset/length bounds to emit a **catchable** RangeError (spec: RangeError when
   `srcLength + targetOffset > targetLength`, and offset < 0).

Reproduce in the CI sharded harness (NOT the local `runTest262File` — the local
`wrapTest` harness leaves `BigInt64Array` undefined on ALL branches, so the oob
is not locally reproducible). Compare merged-report JSONL across consecutive
merge_group runs to see whether the 4 are stably-oob or flip.

## Fix

Make the offset/length bounds check on `TypedArray.prototype.set` emit a
**catchable** RangeError (per spec: `set` throws RangeError when
`srcLength + targetOffset > targetLength`, and offset < 0 -> RangeError) rather
than falling through to an unguarded `array.set` that traps `oob`. Mirror the
guarded-bounds pattern used elsewhere in the standalone array path.

## Acceptance criteria

1. Determine which hypothesis holds (CI nondeterminism vs a real speculative
   trap) from consecutive merge_group merged-report JSONLs.
2. If nondeterminism: stabilise the sharded classification of these 4 (or
   confirm they never actually oob on any real merged main).
3. If a real speculative trap: fix the offending queued PR's `set` offset/length
   bounds to emit a **catchable** RangeError, not an unguarded `array.set` oob.
4. **Tighten the valve back:** `gh variable set TRAP_RATCHET_TOLERANCE --body 0
-R loopdive/js2wasm` (no PR needed — it's a repo variable, PR #2963) once the
   +4 is resolved, restoring the strict 0-tolerance ratchet.
5. Zero net test262 regressions; no NEW trap category or growth beyond the
   current +4 flaky window while the valve is at 4.

## Context

- The merge queue wedged 2026-07-12: the #3189 ratchet fired on every
  `merge_group` (oob 58->62). Unwedged via the ratchet's own designed safety
  valve — `TRAP_RATCHET_TOLERANCE` (repo variable, wired in PR #2963), set to
  **4** (the exact flaky delta). This does NOT bake the +4 into the baseline
  (main stays 58) and still blocks ANY further trap growth beyond +4.
- A `promote-baseline` "refresh to 62" was attempted but is a no-op: it reflects
  main HEAD, which is 58 (freshly-fetched baseline still reads 58).
- Gate/ratchet: `scripts/diff-test262.ts` `evaluateTrapCategoryGrowth`
  (`TRAP_ERROR_CATEGORIES`), #3189.

## Resolution — 2026-07-17 (opus-d)

**Root cause confirmed (codegen, not CI-nondeterminism):** `compileTypedArraySet`
(`src/codegen/array-methods.ts`) had **no offset bounds check** — it extracted the
receiver's `data` array (vec field 1) but not its `length`, then fell straight
into `emitArrayCopy` / an element-wise store. An out-of-range `offset` (or a
source longer than the remaining space) therefore ran the raw `array.copy` /
`array.set` past the end and emitted an **uncatchable Wasm `oob` trap** instead
of the spec-mandated **catchable RangeError** (§23.2.3.24). That is the trap the
#3189 ratchet caught in the speculative `merge_group` merged-state run.

**Fix:** extract the receiver length (vec field 0 → `dstLen`) alongside the data
array, then gate the copy on `offset < 0 || offset + srcLen > dstLen`, emitting a
real `RangeError` instance via `buildThrowJsErrorInstrs(ctx, "RangeError", …)` in
a structured `if` before the copy. Dual-mode: standalone uses the in-module
`__new_RangeError` constructor, so **no `env::*` host import is requested**
(verified by instantiating the standalone module against `{}`).

**Verified** (`tests/issue-3202.test.ts`, 8 cases): valid/exact-fit sets still
copy correctly; `offset+srcLength > targetLength`, an off-by-one overrun, a
negative offset, and a cross-type (Float64Array) overrun all throw a **catchable**
`RangeError`; standalone OOB set throws catchably with **zero** env leak. All 25
existing `#1664` / `#2593` TypedArray tests still pass (no regression).

This is **#3335 Part 1** (turn the six `TypedArray/prototype/set/BigInt/*` oob
regressions back into catchable JS errors → the #3189 oob-ratchet should drop
back toward its ≤45 floor). **Out of scope / follow-ups (left for #3335 Part 2 +
this issue's criterion 4):**

- #3335 Part 2 — make the baseline-refresh **refuse/flag an oob-trap-count
  INCREASE** so a main-side trap regression cannot self-legalize (a CI-guard
  task, separate from this codegen fix).
- Criterion 4 — once CI confirms the ratchet has dropped, tighten the valve back
  with `gh variable set TRAP_RATCHET_TOLERANCE --body 0 -R loopdive/js2wasm`.
  Deferred to the lead/shepherd post-merge (a repo-variable change, not a code
  change; premature tightening risks re-wedging on any residual flaky delta).
