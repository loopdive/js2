---
id: 3169
title: "standalone: Array.prototype callback methods (reduce/reduceRight/filter/some/every/map/forEach) over array-like receivers via .call/.apply (519 gap tests)"
status: done
completed: 2026-07-12
assignee: ttraenkler/dev-array-hof
created: 2026-07-12
updated: 2026-08-25
priority: high
feasibility: hard
task_type: bug
area: codegen
es_edition: multi
language_feature: array-methods
goal: standalone
umbrella: 2860
sprint: 71
horizon: l
related: [2860, 2670, 3015, 3126, 3098, 2872]
origin: "PO groom of #2860 umbrella, 2026-07-12 lane-baseline diff"
# (#3102) Growth is the receiver-ladder fill + its arms, placed next to their
# established siblings: fillExternArrayLikeStructArms beside
# fillExternGetIdxVecArms (object-runtime owns the reader trio), the
# dynamic-any-index arm in the element-access owner (property-access), the
# #3037 carrier marker in binary-ops/context, the un-refusal in array-methods,
# one finalize call in index.ts.
loc-budget-allow:
  - src/codegen/object-runtime.ts
  - src/codegen/property-access.ts
  - src/codegen/binary-ops.ts
  - src/codegen/context/types.ts
  - src/codegen/index.ts
  - src/codegen/array-methods.ts
  # 2026-08-25 ES5 forEach tail: a constructor instance stored in an object
  # literal's `length` field must cross the dynamic prototype/ToPrimitive
  # boundary. The escape classifier owns that representation decision.
  - src/codegen/fnctor-escape-gate.ts
# (#2108) The added coercion sites INVOKE the sealed engine helpers, not
# hand-rolled vocabulary: `__str_to_number` applies §7.1.20 ToLength →
# §7.1.4 ToNumber to a STRING-ref `length` field (`length: "2"`, the -3-*
# array-like family) via the existing native scanner, and `__unbox_number`
# reads the numeric length. No new ToString/ToNumber matrix.
coercion-sites-allow:
  - src/codegen/object-runtime.ts
  - src/codegen/property-access.ts
---

# #3169 — standalone: Array.prototype callback methods over array-like receivers

## Problem

**519 host-pass tests are not host-free-standalone passes** under
`built-ins/Array/prototype/{reduce,reduceRight,filter,some,every,map,forEach}`
(measured 2026-07-12: `test262-current.jsonl` vs
`test262-standalone-current.jsonl` from `loopdive/js2wasm-baselines`, fetched
via `scripts/fetch-baseline-jsonl.mjs`; gap = host `status==pass` ∧ standalone
NOT a host-free pass, official scope, matched by file+strict). This is the
single largest uncovered method-family cluster in the #2860 gap.

The dominant failure shape is **not** the inline-arrow fast path (that is
native already) — it is the ES5-era conformance corpus applying the generic
methods to **array-like receivers**:

```js
// built-ins/Array/prototype/reduce/15.4.4.21-9-c-ii-29.js and ~500 siblings
var obj = { 0: 11, 1: 12, length: 2 };
Array.prototype.reduce.call(obj, callbackfn, 1); // returned 2 — assert #1
```

plus hole semantics (`HasProperty` before `Get`), `this`-binding of the
callback, deleted-during-iteration mutation rules, and `length` clamping /
`ToUint32` coercion on the receiver — all spec steps the native vec-only HOF
lowering skips.

## Root cause (measured signature)

`fail: returned 2 — assert #1 … Array.prototype.reduce.call(obj, …)` dominates
(hundreds of rows). The native HOF path (`src/codegen/hof-native.ts`,
`src/codegen/array-methods.ts`) only accepts real vec receivers; a `$Object`
array-like routed through `.call/.apply` either misroutes or produces wrong
element/hole semantics. A smaller sub-bucket is method-as-VALUE
(`TypeError: Array.prototype.forEach is not yet callable as a value`) — shared
root cause with #3170; fix the receiver ladder here, the value-read there.

## ANTI-BLOAT directive (stakeholder standing rule: generalize, don't fork)

Do NOT write a parallel "array-like HOF" handler. Extend the EXISTING
machinery:

- **`src/codegen/closed-method-dispatch.ts`** — the closed-method dispatcher
  already brands vec receivers (`$__vec_base` arm). Add ONE generic
  `$Object`-receiver arm per method family that walks `0..ToLength(length)`
  through the existing dynamic reader (`src/codegen/dyn-read.ts` /
  `member-get-dispatch.ts`), with a `HasProperty` gate for holes — the same
  ladder shape #3126 used to admit native closure dispatch for typed
  ref-element arrays, and #3098's native callback-dispatch substrate for the
  callback invocation (NO `__make_callback` / `__call_1_f64` reintroduction).
- Sibling pattern to copy: **#2872** (TypedArray.prototype cluster) and
  **#3126** (typed ref-elem HOF admission) — both widened an existing dispatch
  ladder instead of adding a handler.
- #3015 (ready, low) covers the narrow opaque-externref-callback-param leak in
  the same methods — different root cause (callback rep, not receiver rep).
  Coordinate: this issue owns the RECEIVER ladder; don't absorb #3015's
  callback-rep fix unless it falls out for free.
- **#2670 (in-progress, sd-2670, sprint 67) is the HOST-lane twin** — same
  generic-array-like-receiver spec algorithm, but its ~1017 tests FAIL on the
  host lane (disjoint from this issue's 519, which host-PASS). By construction
  the test sets don't overlap, but the mechanism does. Before claiming: check
  the #2670 branch state (`sd-2670` has no lock on `issue-assignments`, last
  update 2026-06-25 — likely stale); if partial #2670 work landed, remeasure
  and build the standalone ladder on top of it, not beside it.

## Acceptance criteria

- ≥350 of the 519 measured gap tests under
  `built-ins/Array/prototype/{reduce,reduceRight,filter,some,every,map,forEach}`
  flip to **host-free** standalone passes (no leaked `env::` imports).
- Sample tests that must pass standalone host-free:
  - `test/built-ins/Array/prototype/reduce/15.4.4.21-9-c-ii-29.js`
  - `test/built-ins/Array/prototype/map/15.4.4.19-8-c-ii-1.js`
  - `test/built-ins/Array/prototype/every/15.4.4.16-7-c-ii-9.js`
- Zero host-mode regressions; zero standalone high-water regressions
  (`check-standalone-highwater.mjs`); all changes exercised on both lanes in CI.
- One PR; if the receiver ladder lands but a residual sub-bucket (>50 tests)
  remains, file a follow-on instead of scope-creeping.

## Test Results (2026-07-12, local macOS, target: standalone)

Fix landed as four coupled pieces (all standalone-gated; gc/host byte-identical):

1. **`fillExternArrayLikeStructArms`** (object-runtime.ts, called from index.ts
   finalize after `fillExternGetIdxVecArms`): CLOSED-STRUCT array-like arms
   spliced into `__extern_length` / `__extern_get_idx` / `__extern_has_idx` —
   the dominant receiver `var obj = {0:11, 1:12, length:2}` is a closed
   nominal struct (`$__anon_N`), NOT `$Object` (#1897), and the reader trio
   answered length 0 / miss, so the generic `compileArrayLikePrototypeCall`
   loop ran 0 iterations. Length arm supports f64/i32/bool/externref-unbox AND
   string lengths (`length: "2"` → `__str_to_number`, the `-3-*` family);
   index arms are per-canonical-integer-field `f64.eq` reads with boxing;
   has-arm is the HasProperty OR-chain (hole semantics).
2. **No-init `reduce`/`reduceRight` un-refused** (array-methods.ts): the
   M2.2c funcidx-shift bug the refusal guarded is gone (#16 by-name
   re-resolves); the §23.1.3.24 step-6 hole-scan seed compiles natively.
3. **Standalone dynamic-`any`-index read** (property-access.ts): twin of the
   host-only #2773 arm — `obj[idx]` in a named-function callback reads legacy
   `__extern_get` first, then retries positionally via `__extern_get_idx` on
   miss (numeric, non-string key). `arguments`-rooted receivers excluded
   (order-fragile materialized state — see #3180 bucket 4).
4. **#3037 carrier gating** (binary-ops.ts + context/types.ts +
   property-access.ts): `maybeWrapAnyReadEqualityCarrier` now requires the
   LIVE `ctx.activeAnyEqDispatchExpr` marker, fixing the mid-operand
   `$AnyValue`-registration hazard (spurious `!==` for value-equal operands —
   also fixed the pre-existing `3 === 3.0 → false` standalone gap pinned in
   `tests/issue-1917-emit-eq.test.ts`, now spec-correct 18 on both lanes).

Measured (7-family batch, 1605 files, `runTest262File(..., "standalone")`):

- in-family standalone passes: **672 (baseline) → 876 (+204 net)**
- authoritative gap flips (host-pass ∧ standalone-not-pass): **202 / 513**
- all 3 acceptance sample tests pass host-free ✓
- in-family regressions: **2** — `reduce/15.4.4.21-8-b-ii-2.js`,
  `reduceRight/15.4.4.22-8-b-ii-2.js`: vacuous-pass → honest-fail (previously
  the REFUSED no-init call answered undefined, which happened to satisfy
  `assert.notSameValue`; now the empty hole-scan throws the spec TypeError —
  the receiver needs the #3180 bucket-1 defineProperty MOP to truly pass).
- equivalence: `tests/issue-3169.test.ts` (16 host-free asserts) + all
  related suites green (#3037 carrier ×115, #3098, #3126, #2903, #1461,
  #1917, array-methods, array-prototype-methods).

**Acceptance shortfall (deliberate, per the anti-scope-creep clause):** the
≥350 flip target is NOT reachable with the receiver ladder alone — the
residual ~306 gap tests split into six NON-ladder mechanisms (defineProperty
MOP ~101, fnctor-array-inheritance ~52, builtin expandos ~46, arguments
fidelity ~37, thisArg ~29, ToPrimitive lengths ~26), filed with measured
counts as **#3180**.
