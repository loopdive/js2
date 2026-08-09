---
id: 2670
title: "ES2015: Array.prototype iteration-method semantics residual (~1017 fails — generic array-like receiver, callback/thisArg, holes, length coercion)"
status: ready
created: 2026-06-25
updated: 2026-06-25
priority: high
feasibility: hard
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: array-methods
goal: spec-completeness
related: [2177, 2151, 473, 2580]
sprint: current
---
# #2670 — ES2015 Array.prototype iteration-method semantics residual

## Edition / impact

- **Edition:** ES2015 (the bulk of `built-ins/Array/prototype` fails; pre-ES6
  Array methods overlap ES5 too).
- **Fail count:** **~1017** `built-ins/Array/prototype/*` — the single largest
  built-in cluster in the suite.
- By method: reduce 144, reduceRight 129, map 80, every 68, some 67, forEach 63,
  splice 61, filter 60, lastIndexOf 57, indexOf 55, slice 54, concat 38,
  sort 36, plus pop/push/join/shift/unshift/copyWithin/reverse tails.
- Residual after #2177 (Array.prototype.<m>.call on $Vec/open-object receiver,
  done) and #2151 (any-receiver dispatch, done). Those fixed the dispatch
  plumbing; the spec-algorithm fidelity tail remains.

## Problem

The Array iteration methods are spec'd as **generic** over an array-*like*
receiver (`ToObject(this)` + `ToLength(this.length)` + indexed `[[Get]]`/`[[Set]]`),
not just real arrays. The failing tests overwhelmingly call them via
`Array.prototype.<m>.call(arrayLikeObject, ...)` where the receiver is a plain
object with a numeric `length`, a string, or a sparse/hole-bearing array. The
recurring spec requirements not yet met:

1. **Generic array-like receiver** — `reduce.call({0:'a',1:'b',length:2}, cb)`
   must read `length` (via `ToLength`) and elements `0..length-1` via `[[Get]]`
   on the dynamic object, not assume a compiled `$Vec`. Dominant signature:
   `assert.sameValue(Array.prototype.reduce.call(obj, ...), ...)`.
2. **`length` coercion** — `ToLength(this.length)` (clamp, `ToInteger`,
   non-array length, getter side effects, accessed exactly the spec number of
   times). Ties to open #2580 (`.length` on any/dynamic receiver returns 0).
3. **Holes** — absent indices skipped by forEach/map/every/some/filter/reduce;
   present-vs-absent probed via `HasProperty`. Signature
   `assert(accessed, ...)`.
4. **Callback contract** — `callbackfn(value, index, O)`, `thisArg` binding,
   `TypeError` when callback not callable, `reduce`/`reduceRight` `TypeError`
   on empty array with no initial value, traversal order/direction.
5. **Mutation during iteration** — length captured up front; elements added
   during the callback not visited.

## Failing-test cluster (examples)

```
built-ins/Array/prototype/reduce/15.4.4.21-9-c-ii-29.js   (.call(obj,...) array-like)
built-ins/Array/prototype/reduce/15.4.4.21-8-b-ii-2.js     (empty + no init → TypeError)
built-ins/Array/prototype/every/15.4.4.16-7-c-ii-*.js      (holes / array-like)
built-ins/Array/prototype/map/15.4.4.19-8-c-ii-*.js
built-ins/Array/prototype/filter/15.4.4.20-9-c-ii-*.js
```

## Acceptance criteria

- Target: pass **≥ 700 of ~1017** `built-ins/Array/prototype/*` failing tests.
- Iteration methods operate on a **generic array-like** receiver (object with
  `length`, string) via `ToObject`/`ToLength`/`[[Get]]`, not only `$Vec`.
- Holes skipped; `length` coerced with `ToLength` and read the spec number of
  times; callback receives `(value, index, O)` with `thisArg`.
- `reduce`/`reduceRight` throw `TypeError` on empty + no initial value;
  non-callable callback throws `TypeError`.
- No regression in currently-passing Array tests.

## Notes — feasibility: hard

Core array-builtin machinery; route to architect for a spec before dispatch.
The high-leverage fix is a **shared generic element-access path** (ToObject +
ToLength + HasProperty + Get/Set over a dynamic receiver) that all iteration
methods route through, replacing $Vec-only fast paths when the receiver is not a
compiled array. Coordinate with #2580 (length on dynamic receiver). Slice by
method family (reduce/reduceRight; map/filter/forEach/every/some; index-of;
slice/splice/concat) so each lands independently.

## Verification (sd-2670, 2026-06-25) — VERIFY-FIRST, fresh main HEAD d082e1fee

**Verified fail count: 1202** `built-ins/Array/prototype/*` (baseline jsonl,
refreshed today). The ~1017 estimate is accurate-to-conservative. **NOT
deflated** (contrast #2668, which collapsed 25x). This genuinely IS the largest
built-in cluster.

**BUT the stated root cause is largely WRONG.** The "generic array-like receiver
dispatch is broken / need a shared generic element-access path" premise does
**not hold on main** — #2177/#2151 already made it work for the common case.
Confirmed WORKING on main (direct probes):
- `Array.prototype.reduce/map/indexOf.call({0:..,1:..,length:n}, cb)` → correct
- `Object.defineProperty(obj,"0",{get})` getter **fires** during iteration
- `length` via `{valueOf(){return n}}` ToLength coercion → correct
- non-callable callback → throws TypeError

**Real residual root causes (probe + source-classified over all 1202):**
| count | sub-cluster | status on main |
|------:|-------------|----------------|
| 446 | unclassified (mostly sparse-array + inherited-receiver combos) | mixed |
| 278 | defineProperty getter on receiver/**prototype** + inherited indices | getter fires, but inherited-via-prototype `[[Get]]` / accessed-tracking still fail |
| 136 | TypeError contract (non-extensible / non-configurable target on map/fill/…) | only non-callable throws; extensibility checks missing |
| 96  | holes / HasProperty | **BROKEN** |
| 61  | result-array descriptor (extensible/configurable/enumerable) | broken |
| 51  | callback-args (value,index,O)/thisArg edge | mixed |
| 38  | species / @@species | broken |
| 38  | ToLength/ToInteger length-valueOf ordering | mostly works; ordering edges fail |
| 21  | wasm_compile (unsupported syntax) | crash |
| 20  | Symbol-edge | broken |
| 17  | primitive-wrapper-object identity (`new Number()` accumulator) | broken |

**Probe evidence (current main):**
- `[1,,3].forEach` visits 3 elements (exp 2) — literal-elision hole NOT skipped by HOFs
- `new Array(10); a[1]=1;a[2]=2; a.forEach` visits 10 (exp 2) — `new Array(N)` holes not represented as `$Hole`
- `delete arr[1]` then `forEach` visits 3 (exp 2) — delete-holes not represented
- `Array.prototype.lastIndexOf.call(fnObject, "b")` → -1 (exp 1) — function-object / exotic receiver element Get fails
- `indexOf.call(child,…)` with prototype-inherited index → wrong

**Hole infra status:** `src/codegen/array-holes.ts` (#2001 S1) defines a `$Hole`
sentinel + read-boundary `$Hole→undefined` mapping for `any[]` literal elisions,
but (a) HOFs do not gate iteration on HasProperty/`$Hole` for a compiled `$Vec`
receiver, and (b) `new Array(N)` / `delete` do not produce `$Hole`. So holes are
a bounded extension of #2001, not greenfield.

**Recommendation: do NOT pivot** (count is real, >>200) — but **re-slice along
the verified root causes, not the mis-stated generic-receiver axis.** Proposed
slices: (A) holes-in-HOFs [extends #2001], (B) inherited/prototype-chain indexed
`[[Get]]` + getter-on-receiver, (C) TypeError extensibility/configurability
contracts, (D) @@species, (E) primitive-wrapper accumulator identity. Biggest
tractable independent first slice = **(A) holes-in-HOFs** (~150-250 fails across
forEach/map/every/some/filter/reduce/indexOf/lastIndexOf). Coordinate (B) with
#2580 (length on dynamic receiver) and the #2659-family receiver-dispatch
(sd-2674b/sd-2679) — inherited-index Get likely bottoms out in the same
`__current_this`/receiver-threading + dynamic `[[Get]]` cluster.


## Slice A attempt + REVERT — holes-skip is NOT separable from prototype HasProperty (sd-2670, 2026-06-25)

Implemented a compiled-`$Vec` HOF hole-SKIP for forEach/filter/some/every
(`wrapHoleSkip` + a `br`-depth-rebasing `shiftEscapingBr`, gated on
`usesArrayHoles && externref`). All local gates + 9 new equivalence cases passed,
PR-level CI was green — **but the merge_group floor caught a REAL js-host
regression** (run 28200774875, PR #2080): **net −3, 0 improvements, 3 regressions**:
- `every/15.4.4.16-7-c-i-22.js`, `some/15.4.4.17-7-c-i-22.js`,
  `filter/15.4.4.20-9-c-i-22.js`

**Root cause:** all three do `Object.defineProperty(Array.prototype, "0",
{set…})` then `[, ].<m>(cb)`. Per spec, `HasProperty(O, 0)` walks the **prototype
chain**, so the inherited index makes the literal hole *present* → the callback
MUST fire (with `undefined`, since the inherited accessor has no getter). A purely
**local** `ref.test $Hole` skip ignores inherited props and wrongly skips. The
pre-change "visit hole → undefined" (S1) behaviour coincidentally produced the
correct observable for exactly these tests.

**Why slice A cannot stand alone (the real lesson):** in the authoritative
js-host lane the skip produced **zero** test262 improvements, because the
test262 hole tests overwhelmingly construct holes via `new Array(N)` / `delete`
(deferred to A2), while the *literal-elision* ones that exist are precisely the
inherited-prototype edge where local skip regresses. So holes-skip is **net-zero
upside / net-negative downside** until it is built on a **prototype-aware
HasProperty over the receiver** — i.e. the slice-B machinery
(#2674/#2679 member-get-dispatch + #2580). The standalone lane in that run was
stale-baseline drift (a9d7be6: 9389 regress / 1046 improve), and the hole fixes
*did* appear among its 73 Array improvements — confirming the code is correct,
just mis-sequenced.

**Disposition:** implementation reverted; this PR carries the verification +
re-slice record only. The `wrapHoleSkip`/`shiftEscapingBr` helpers (correct and
reusable) are recoverable from PR #2080 commit `509351a45` when holes are picked
up AFTER slice B lands. **Re-sequenced:** fold "A — holes-skip" into / after
slice B (prototype-chain HasProperty), not before it.

## Residual (as of #2199, PO reconcile 2026-06-28)

NOT done — sliced. Slice A (forEach/filter/some/every hole-skip on the $Vec path) landed. Remaining methods (map/reduce/reduceRight/indexOf/lastIndexOf/slice/splice/concat...) + generic array-like receiver + length coercion (~1017-fail cluster) remain; slice per method. Stays in-progress.
