---
id: 2922
title: "Standalone async widen: native Promise.all/race arms 2 & 3 — not-iterable→reject + generic iterable (residual receiver-cast layer after #2919 arm 1)"
status: done
sprint: current
assignee: ttraenkler/fable-4
created: 2026-07-02
completed: 2026-07-02
priority: medium
feasibility: hard
task_type: feature
area: codegen
goal: standalone
horizon: l
related: [2919, 2867, 2918, 2895, 2860]
umbrella: 2860
depends_on: [2919]
---

# Native Promise.all/race arms 2 & 3 (follow-up to #2919 arm 1)

## Context

#2919 landed **arm 1** — native host-free `Promise.all`/`race` over an
array-TYPED non-literal argument (`Promise.all(arrVar)`), clearing the
array-value receiver-cast traps under the wasi async carrier. Two argument arms
remain on the host path (which is suppressed host-free under wasi → leaves
`ref.null.extern` → the trailing `.then`'s `ref.cast $Promise` traps with
"illegal cast"):

## Arm 2 — not-iterable → reject TypeError

`Promise.all(1)` / `(null)` / `(true)` / `(symbol)` … must settle a **rejected**
`$Promise` carrying a native `TypeError`. GetIterator-throws (arm 3) routes here
too. **Check what native error / `Test262Error` construction already exists
under the carrier before re-deriving** (spec note from #2919).

## Arm 3 — generic iterable

`Promise.all(set)` / a custom `[Symbol.iterator]`: host-free `GetIterator(arg)` +
`.next()` loop feeding the shared `__combinator_subscribe`. **Reuse the
standalone for-of iterator lowering — do NOT fork it.** A GetIterator-based path
subsumes arms 1+2+3, but arm 1's direct `array.len`/`array.get` (already landed)
is simpler + highest-coverage, so arm 3 layers on top for the non-array shapes.

## Discipline (non-negotiable — the async-graveyard rule)

Carrier-gated (`isStandalonePromiseActive`, wasi-only — do **not** widen the gate
here), byte-inert on gc/host + standalone (sha256-prove), corpus-verified against
the async leaky-pass corpus and the −16/−29 guard. Watch late-import funcIdx
shifts (`shiftAsyncSideChannelFuncIdxs` / `COMBINATOR_FUNC_IDX_KEYS`). Escalate
if a deeper value-representation change is needed (the Gap-4 output-vec contract).

## Entry points (from #2919 arm 1)

- Gate: `src/codegen/expressions/calls.ts` `isAggregator` block, after the arm-1
  `resolveExternrefVecArg` check falls through.
- Substrate: `src/codegen/promise-combinators.ts` (`__combinator_subscribe`,
  `emitStandalonePromiseCombinatorRuntime`, `ensureCombinatorFunctions`).
- Tests: extend `tests/issue-2867-gap4.test.ts` (add `#2922 arm 2/3` cases).

## Implementation Plan (fable-4, 2026-07-02)

Measured on main @ affc55523. Three sub-arms, all gated behind the existing
`nativeCombinatorEligible` (⊂ `isStandalonePromiseActive`, wasi-only):

### Arm 3a — Set/Map argument (compile-time, reuses #2162 for-of lowering)

`$Map`-backed collections have **no runtime `@@iterator`/`next` dispatch** —
for-of iterates them via the compile-time `emitCollectionIteratorVec`
projection (`compileForOfNativeCollection`, loops.ts). So a runtime
GetIterator path can NEVER see a Set; it must be handled statically.
Gate (calls.ts, before the arm-1 probe): checker symbol name is `Set`/`Map`
AND a #1919-transactional probe confirms the arg lowers to `ctx.mapTypeIdx`.
Emit: `emitCollectionIteratorVec(arg0, isSet ? "values" : "entries", isSet)`
→ canonical externref `$Vec` → local → the UNCHANGED arm-1
`emitStandalonePromiseCombinatorRuntime` loop.

### Arms 2+3b unified — dynamic drain via `__combinator_to_vec` (runtime)

One native fn subsumes not-iterable→reject AND generic iterable AND
any-typed-array args: `__combinator_to_vec(externref) -> externref`
returning a canonical `$Vec` (or the input unchanged when it already IS one)
or **null-extern = not iterable**.

- **Eager body** (registered at the first dynamic call site): null→null,
  `ref.test $Vec`→passthrough, else→null. Conservative and correct for a
  module with no custom iterables.
- **Finalize fill** (`fillCombinatorToVec`, called right after
  `fillNativeIteratorUserArms` in index.ts — the #2038/#1719
  reserve-then-fill discipline): when ALL FIVE closed-struct dispatchers
  exist (`__call_@@iterator`, `__call_next`, `__sget_value`, `__sget_done`,
  `__is_truthy` — same condition as the iterator user-arm fill, so the two
  carriers can never disagree), rebuild with the USER arm:
  `it = __call_@@iterator(x)`; if null, a `ref.test`-chain over structs with
  a registered `next` method admits bare-next iterators (generators-shaped
  objects — mirrors the #2038 obj-itself fallback; spec: GetIterator's
  @@iterator on %GeneratorPrototype% returns this); else null (reject).
  Then a grow-array drain loop (byte-shaped after `__array_from_iter_n`)
  via `__call_next`/`__sget_done`/`__is_truthy`/`__sget_value` → `$Vec`.
  The dynamic call site calls `ensureNativeIteratorRuntime` so
  `emitIteratorMethodExport` actually emits the dispatchers at finalize
  (it early-returns unless `__iterator` is registered).
- **Call site** (calls.ts, after the arm-1 rollback): recompile arg with
  expected externref (committed; the probe was rolled back — same
  compile-twice pattern the host path already uses via `emitIterableArg`),
  `drained = __combinator_to_vec(arg)`, `notIter = drained == null` (with a
  fresh empty `$Vec` substituted so the loop no-ops), then the arm-1 runtime
  loop with a NEW optional `opts: { notIterLocal, rejectReason }`.
- **Reject**: `emitStandalonePromiseCombinatorRuntime` emits, right after
  creating the pending result promise and ONLY when `opts` is present:
  `if (notIter) __promise_reject(result, new TypeError(msg))`. Settlement is
  one-shot (`buildPromiseSettleBody` returns early on non-PENDING), so the
  later `all`-empty-fulfill no-ops — ORDER MATTERS: reject must precede the
  n==0 fulfill, which is why this lives inside the emitter, not after it.
  The TypeError is the native `$Error_struct` via
  `emitWasiErrorConstructor("TypeError", 1)` + `__new_TypeError` (the proven
  host-free path from `emitThrowJsError`); the message string instrs are
  baked AFTER all ensure\* calls so no funcIdx shift window exists, and they
  live nested in `fctx.body` where `shiftLateImportIndices` walks them
  (recurses into then/else/body — verified).

### Static exclusions (keep host fallthrough, byte-identical)

- **strings** (checker `isStringType` or arg lowers to
  `anyStrTypeIdx`/`nativeStrTypeIdx`/`consStrTypeIdx`): strings ARE iterable
  per spec — rejecting would be a wrong observable reject; the drain has no
  string arm yet (follow-up).
- **non-externref `__vec_` vecs** (`number[]` — the documented Gap-4
  output-representation escalation from #2919 arm 1): unchanged.
- **generator-state structs** (`nativeGeneratorInfoForForOfSubject` hit):
  generators iterate via a dedicated compile-time resume path, not the
  runtime dispatchers — routing them to the drain would wrongly reject.
  Unchanged (residual follow-up: drive `__gen_resume_*` at the gate).
- **funcref/i64/v128-typed args**: conservative fallthrough.

### Known residuals (documented, not silent)

- A runtime **string inside `any`** reaches the drain and rejects
  (spec: iterable). Static string args are excluded; `any`-holding-string
  into `Promise.all` is rare×rare. Follow-up: string arm in the fill.
- A runtime **$Map inside `any`** rejects (no runtime dispatch exists for
  collections at all — same class as the string residual).

### Byte-inertness proof

gc/host lanes: all new code is behind `isStandalonePromiseActive` (wasi) or
`opts !== undefined` / `funcMap.has("__combinator_to_vec")` guards — sha256
over representative gc/host compiles proves identity. wasi arm-0/arm-1
shapes: the Set/Map pre-check is checker-only (no emission) for non-Set/Map
args; the dynamic arm only runs where the host path previously emitted the
(trapping) import call — those shapes change intentionally.

## Test Results (2026-07-02, branch issue-2922-async-widen-arms-2-3)

- `tests/issue-2867-gap4.test.ts`: 25/25 (12 pre-existing + 13 new #2922
  cases: not-iterable reject ×6 incl. `instanceof TypeError`, Set/Map ×3,
  any-typed array passthrough, custom iterable ×3 incl. pending-promise
  elements and empty-iterable).
- Byte-inertness: 10-sample sha256 corpus (gc lane ×5 incl. combinator
  shapes, wasi arm-0/arm-1, wasi string-arg + `number[]`-arg exclusions,
  wasi non-async control) — ALL identical branch vs main @ affc55523.
- Quality gates: speculative-rollback OK, stack-balance OK,
  codegen-fallbacks OK, any-box OK, ir-fallbacks OK, coercion-sites OK
  after a sanctioned +1 baseline refresh for `__is_truthy` in
  promise-combinators.ts (the SAME engine-owned ToBoolean dispatcher
  lookup iterator-native.ts is baselined at 2 for — an engine invocation,
  not a new coercion matrix).
- Related async suites: promise-combinators / 2918 / 2867 / 2867-gap2 /
  2895-async-frame / 2895-drain-hook / 2865 / 2906 — 40 passed; the 4
  failures (promise-combinators host-lane ×2, 2865 await-unwrap ×2)
  reproduce IDENTICALLY on main @ affc55523 (verified) — pre-existing,
  untouched by this change.
- Verified pre-existing substrate gaps via non-combinator controls (not
  regressions of this PR): any-typed `e.message` reads on a native error
  return undefined (#2962 scope, in flight), and `pair[0]` index reads on
  an any-typed $ObjVec entries pair read as 0.
