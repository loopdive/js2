---
id: 3180
title: "standalone: Array.prototype HOF residual gap buckets after the #3169 receiver ladder (~306 tests, 6 mechanisms)"
status: ready
created: 2026-07-12
updated: 2026-07-12
priority: medium
feasibility: hard
model: fable
task_type: bug
area: codegen
es_edition: multi
language_feature: array-methods
goal: standalone
umbrella: 2860
sprint: current
horizon: l
related: [3169, 2860, 3170, 2670]
origin: "#3169 measured residual (2026-07-12 local 7-family batch vs baselines)"
---

# #3180 — standalone: Array.prototype HOF residual gap buckets (post-#3169)

## Problem

#3169 landed the CLOSED-STRUCT array-like receiver ladder (+~209 of the 513
measured host↔standalone gap tests under
`built-ins/Array/prototype/{reduce,reduceRight,filter,some,every,map,forEach}`).
The remaining ~306 gap tests split into six DISTINCT mechanisms, none of which
is the receiver ladder — per the #3169 anti-scope-creep clause they are filed
here as a follow-on instead of being absorbed.

## Measured residual buckets (2026-07-12, local batch, files in
`.tmp/gap-still-failing.txt` methodology — recompute before slicing)

1. **defineProperty-during-iteration MOP (~101, sec-7/sec-9)** — accessor
   properties installed via `Object.defineProperty(obj, "0", {get(){…}})` on
   array-like literals; getters that mutate/delete/add elements or `length`
   mid-iteration. Needs: defineProperty on a closed-struct literal to divert
   the literal to the open `$Object` rep at compile time (the host lane's
   `compileObjectLiteralWithAccessors` analog), so the runtime MOP (accessor
   entries, delete tombstones) actually applies. Largest single bucket.
   **ROUTING: this bucket belongs to the #2992 / fable-2984c lane
   (peer-owned) — the standalone defineProperty/accessor-MOP substrate. Do
   NOT double-work it here; the HOF flip is a downstream consumer of that
   substrate. Coordinate before touching.**
2. **fnctor-array-inheritance (~52, sec-8)** — `foo.prototype = new Array(...);
   f = new foo(); f.length = null; f.every(cb)` — constructor instances
   inheriting Array.prototype elements/length through the proto chain.
3. **builtin-expando receivers (~46, sec-1)** — `Math.length = 1; Math[0] = 1;
   Array.prototype.every.call(Math, cb)` (also Date/Function/RegExp/JSON/Error
   /String-object receivers). Needs expando properties on builtin singletons.
4. **arguments fidelity (~37)** — `Array.prototype.every.call(arguments, cb)`
   and `arguments[2][arguments[1]] === arguments[0]` inside 0-declared-param
   callbacks. The materialized arguments object is order-fragile and reflects
   DECLARED params, not actual call args (the HOF inline loop pushes only
   declared params through `call_ref`). #3169 explicitly EXCLUDES
   `arguments`-rooted receivers from its positional dynamic-index read
   (`isArgumentsRootedExpression`, property-access.ts) to avoid flipping
   vacuous passes — remove that exclusion when fixing this properly.
5. **thisArg semantics on direct HOFs (~29, sec-5)** — `arr.every(cb, foo)`
   where `cb` reads `this.res` / compares `this === arg` (function expandos,
   sloppy-mode global this, thisArg identity through `__current_this`).
6. **ToPrimitive lengths (~26, sec-3 residual)** — `length: {toString(){…}}` /
   `{valueOf(){…}}` object-valued lengths. #3169 handles f64/i32/bool/
   externref-unbox/string lengths; an object length needs runtime ToPrimitive
   (the closed-struct method dispatch) inside `__extern_length`'s
   closed-struct arm.

## Notes

- 2 known vacuous-pass→honest-fail conversions from #3169 belong to bucket 1:
  `reduce/15.4.4.21-8-b-ii-2.js`, `reduceRight/15.4.4.22-8-b-ii-2.js`
  (defineProperty length accessor + no-init reduce — previously "passed"
  because the refused call answered undefined; now the spec TypeError from the
  empty hole-scan honestly fails).
- Slice by bucket; each is a separate PR-sized mechanism. Bucket 1 is the
  highest-value and has the cleanest precedent (the host lane's
  accessor-literal divert).

## Acceptance criteria

- Per slice: the targeted bucket's measured gap tests flip to host-free
  standalone passes with zero host regressions; recompute the residual list
  first (main moves).
