---
id: 2809
title: "[SENIOR-DEV ONLY] undefined[] representation conflation — acorn's void-0 evolving array vs genuine undefined[]"
status: done
completed: 2026-06-29
assignee: ttraenkler/senior-developer
supersedes: 2284
sprint: current
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
created: 2026-06-29
task_type: bugfix
area: codegen
language_feature: value-representation
goal: acorn-dogfood
related: [2806, 2801, 2379]
depends_on: []
blocks: [2801]
architect_spec: candidate
---

# #2809 — `undefined[]` representation conflation: acorn evolving-array (refs) vs genuine `undefined[]` (numeric)

**Carved from #2806.** #2806 took compiled-acorn `parse("foo(bar,baz)").arguments`
from `[0,0]` to the correct `[Identifier, Identifier]` end-to-end — but the fix's
third site (the `resolveWasmType` Array branch) is **load-bearing for acorn yet
over-broad for test262**, causing a real merge_group regression. This issue carves
out the underlying **representation-design decision** for an architect spec.

## TL;DR for the architect

Two distinct things share the TypeScript type `Array<undefined>` and must lower
**differently**:

- **acorn's evolving array** — `var elt = (void 0); elt = <nodeRef>;
  elts.push(elt); return elts`. The `void 0` expression pins `elt` to type
  `undefined`, so `elts` and the function's return type infer as `undefined[]`,
  but the runtime values are **references** (AST nodes). This MUST be an
  **externref** vec, or the refs coerce to `0`.
- **genuine `undefined[]`** — `Array(undefined, undefined)`, `[undefined,
  undefined]`, sparse `[,,,]`. These hold real `undefined` VALUES and today
  lower to **numeric** (i32/f64) vecs with the undefined sentinel, and pass
  test262.

**Core design question:** can we route acorn's evolving array to externref via
the **void-0 signal** (at element-type AND return-type inference) so genuine
`undefined[]` stays numeric — WITHOUT the blunt global `resolveWasmType`
override? If not, the fallback is to make `undefined[]` **uniformly**
externref-boxed-undefined across every construction/access/method path.

## Background: the #2806 fix (3 sites)

The #2806 root cause is the `var x = (void 0)` idiom: the `void 0` expression pins
the binding to TS type `undefined` (unlike `= undefined`/`= null`/no-init, which
TS treats as evolving-any → externref), and `resolveWasmType(undefined)` is a
numeric (i32) slot, so a later REFERENCE assignment/push/return is coerced to `0`.
The landed fix (branch `issue-2806-untyped-array-ref-vec`, PR #2284) has three
sites:

1. **Void-expr slot** (`varBindingNeedsExternrefForUndefined` in
   `src/codegen/index.ts`, used by `hoistVarDecl` + `localTypeForDeclaration` in
   `src/codegen/statements/variables.ts`): a `var x = (void 0)` binding gets an
   externref slot. NARROW (void-EXPRESSION only — a bare `undefined`-typed binding
   like `const afterA = obj.a` after `delete` must stay numeric for the f64-sNaN
   delete sentinel, #1112). **CLEAN — keep.**
2. **`inferArrayVecType`** (`statements/variables.ts`): undefined/void/null
   push-value types no longer pin the array's element kind to a numeric vec
   (treated like `any`). Makes the evolving LOCAL `elts` an externref vec.
   **CLEAN — keep.**
3. **`resolveWasmType` Array branch** (`src/codegen/index.ts` ~11610): a purely
   `undefined`/`void` array element → externref vec. **REQUIRED for acorn (the
   function RETURN type of `parseExprList` is `undefined[]` and must match the
   externref local), but OVER-BROAD — it is the regression source.**

Sites #1 + #2 are the clean foundation and should be preserved by any solution.

## The merge_group regression (REAL, net-positive, ratio-gated)

PR #2284 passed PR-level checks but was auto-parked on the merge_group
"check for test262 regressions" required gate. Delta (from the
`test262-merged-report` artifact diffed against baseline):

```
pass  34266 → 34273  (+7 net)
Regressions (pass→other): 5   Improvements (other→pass): 12
GATE FAIL: regression ratio 41.7% (5/12) ≥ 10% limit
Regression categories: wasm_compile 2, null_deref 1, assertion_fail 1, illegal_cast 1
```

The change is **net-positive** (+7 pass, 12 real improvements from the void-0
fix); the gate fails on the **ratio**, and the 5 regressions are **real** (not
drift — confirmed by local reproduction).

### The 5 regressed tests

1. `test/built-ins/Array/S15.4.1_A2.1_T1.js` — `Array(undefined, undefined).length`
   returns 0, expected 2.
2. `test/built-ins/Array/S15.4.2.1_A2.1_T1.js` — `new Array(undefined, undefined)`
   → invalid wasm (`array.new_fixed[0] expected type`).
3. `test/built-ins/Array/prototype/sort/S15.4.4.11_A1.3_T1.js` —
   `new Array(undefined, undefined).sort()` → invalid wasm.
4. `test/built-ins/Array/prototype/reduceRight/15.4.4.22-8-c-4.js` — sparse
   `[, , , ]` → null_deref.
5. `test/language/module-code/top-level-await/syntax/for-in-await-expr-this.js` —
   illegal_cast. **Likely drift/collateral, NOT Array** — verify against another
   PR's regression list / a clean re-merge.

### Mechanism of the regression

Site #3 makes `Array<undefined>` an externref vec on the **TYPE** side (the
variable's declared type, `.length` access, the function return type). But the
**CONSTRUCTION/access** side still builds **numeric (i32) vecs**:

- `compileArrayConstructorCall` (`Array(...)`, `literals.ts:3944`) computes the
  element via `resolveWasmType(undefined)` [SCALAR] = i32 — NOT the Array branch
  — so it builds an i32 vec while consumers resolve the value's
  `Array<undefined>` type to externref → mismatch (wrong `.length`,
  `array.new_fixed` validation failure).
- `new Array(...)` (new-super.ts path) — same, separately.
- Sparse `[, , ,]` holes — externref vec but hole/access path null-derefs.
- `.sort()` — rebuilds the backing array, same mismatch.

The plain array **literal** `[undefined, undefined]` already defaults all-undefined
to externref (literals.ts ~3219), so it is CONSISTENT and was NOT regressed —
which is the existence proof that uniform externref CAN work, just not yet wired
through the builtins/sparse/method paths.

### Why #3 can't simply be reverted

Verified: reverting #3 makes all 4 Array tests pass **but regresses real acorn back
to `[0,0]`** — `parseExprList`'s return type `undefined[]` resolves to a numeric vec
while the local `elts` is an externref vec, and `return elts` coerces every pushed
ref to `0`. #3 is the only site that currently fixes the return type. So the
acorn win and the test262 Array correctness are coupled through `undefined[]`.

## Prototype already explored (in branch worktree)

Aligning `compileArrayConstructorCall` with #3 (a `pureUndefinedVoidElem →
externref` branch) **fixed** `Array(undefined,undefined).length === 2` and left
numeric arrays (`Array(0,1,0,1)`) untouched — but `new Array(...)`, sparse holes,
and sort each still need the same alignment. That spreading across ~4–5
construction/method paths is the **reference_2379 "representation-scale" hazard**:
a representation change that can't be safely validated without full merge_group.

## Options (with assessment)

- **(a) Uniform `undefined[]` → externref-boxed-undefined** across every
  construction/access/method path (literal ✓ already; + `Array()`, `new Array`,
  sparse holes, sort, reduceRight, indexed read/write). More spec-correct
  (undefined boxed as externref, not an f64 sentinel) and keeps the acorn win.
  But broad blast radius; needs 1–2 merge_group rounds to validate. **The correct
  end-state if the void-0 signal can't be exploited.**
- **(b) Surgical func-result-type adaptation** — drop global #3; instead adapt
  `parseExprList`'s function RESULT TYPE to externref at body-end (the
  `func.typeIdx` reassignment infra exists, `function-body.ts:126`) so test262
  undefined-arrays stay numeric. **REJECTED by tech-lead** — funcIdx/caller-order
  desync risk (#1257 class); a hack.
- **(c) Split** — drop #3, land the clean #1 + #2 (real improvements, no Array
  break) now, re-spec the return-type later. **REJECTED by tech-lead** — defers
  the acorn goal.

**Preferred direction (architect to confirm):** a principled inference fix —
make acorn's evolving array infer as `any[]`/evolving-any (→ externref) via the
**void-0 signal**, at BOTH the array-element-type and the function-return-type
inference, so genuine `undefined[]` stays numeric and there is NO test262
regression and NO blunt global override. If that inference path is not feasible,
fall back to (a). Either way, preserve #1 + #2.

## Acceptance

- Compiled-acorn `parse("foo(bar,baz)").arguments` → `[Identifier, Identifier]`
  (the #2806/#2801 milestone) stays green.
- All 4 `built-ins/Array/**` regressions above pass; genuine `undefined[]` /
  `Array(undefined,...)` / sparse arrays keep correct length + element semantics.
- Full `merge_group` + standalone-floor green (ratio < 10%, no bucket > 50),
  watch `built-ins/Array/**` + TypedArray.

## Pointers

- Branch with the full #2806 fix + the `compileArrayConstructorCall` prototype
  to build on / cherry-pick: `issue-2806-untyped-array-ref-vec` (PR #2284,
  PARKED — do not unpark until this is resolved).
- Repros banked in that worktree's `.tmp/`: `repro-variants.mjs`,
  `repro-voidinit.mjs`, `callargs3.mjs`/`elemdbg.mjs` (acorn), `arrundef.mjs`
  (the Array-undefined construction cases).
- Memory: `reference_2379_new_array_n_boxed_any_elem_rep` /
  `reference_2379_new_array_n_arraymethod_invalid_cast` — the representation-scale
  precedent.

## Implementation Plan

**Architect verdict: implement Option 2 (uniform `undefined[]`/`void[]` →
externref-boxed-undefined). Option 1 (distinguish at inference / per-path
wasm-type overrides) was empirically DISPROVEN for full acorn — see below.**
`reasoning_effort: max`, senior-dev only.

### Why Option 1 fails (verified on current main, 2026-06-29)

The conflation is irreducible **at the TS type level**: acorn's evolving array
and genuine `Array(undefined,undefined)` / `[undefined,undefined]` / sparse
`[,,,]` all resolve to the *identical* `ts.Type` `undefined[]`. The `void 0`
signal is purely **syntactic/local** — it never reaches the structural type, so
`resolveWasmType(undefined[])` cannot tell them apart. Option 1 therefore has to
fix the **value-carrying positions** (locals, returns, params, fields) one
registration-path at a time.

I built and ran Option 1 end-to-end (keep #1+#2, drop #3, add a narrowly-gated
function-**return-type** override that fires only when a returned identifier is
bound to an empty-array-literal evolving local). Results:

- Minimal repro (top-level `export function parseExprList(){ var elts=[]; var
  elt=(void 0); elt=ref; elts.push(elt); return elts; }`) → **FIXED**
  (`[Identifier, Identifier]`), and genuine `Array(undefined,undefined).length`
  stayed `2`, `return [undefined,undefined]` / `return Array(undefined,undefined)`
  correctly stayed numeric (override did not fire). Blast radius looked ~zero.
- **BUT real acorn (`tests/dogfood/.acorn/.../acorn.mjs`, 147 s compile) still
  returned `arguments: [0,0]`.** Root cause: acorn's `parseExprList` is a
  **prototype method assigned to a function expression** (`pp.parseExprList =
  function(...){…}`), NOT a top-level `FunctionDeclaration`. Its result type is
  registered on a different code path, so the declaration-path override never
  fires. To make Option 1 cover acorn you would have to replicate the override
  across **every** function-like + field registration path (FunctionDeclaration,
  FunctionExpression, prototype method, ArrowFunction, object/struct field, param)
  and never miss one — any gap silently coerces a ref to `0`. That is exactly the
  uniformity #3 already provides type-side for free. Option 1 is fragile and
  higher-effort than Option 2.

Conclusion: **keep #3 (uniform type→externref) and align the construction/access
side to match it.** Type and value then agree at every boundary with no
per-path coverage table to maintain.

### Root cause (Option 2 framing)

#3 makes `resolveWasmType(undefined[]/void[])` an **externref vec** uniformly
(variable types, return types, params, fields, `.length`). But every
**construction** site computes its element representation from the *scalar*
element type via `resolveWasmType(undefinedElem)` = `i32`/`f64`, NOT from the
array type's vec element. So construction builds a numeric vec while consumers
resolve the value to an externref vec → mismatch (`array.new_fixed[0] expected
type externref, f64`, wrong `.length`, null-deref). The unifying fix: **every
construction/hole/method site must derive its element representation from the
array type's resolved vec (the #3-governed externref vec), pushing
`emitUndefined` / externref-undefined for `undefined`/holes when the vec element
is externref — never the f64 sNaN sentinel.**

### Keep (the clean #2806 foundation — do not touch)

- **#1** `varBindingNeedsExternrefForUndefined` (`src/codegen/index.ts`) + uses in
  `hoistVarDecl` and `localTypeForDeclaration` (`statements/variables.ts`).
- **#2** `inferArrayVecType` unpinnable-write-type rule (`statements/variables.ts`).
- **#3** `resolveWasmType` Array branch (`src/codegen/index.ts`, the
  `sym==="Array"` block, ~line 11610 on the branch): pure `undefined`/`void`
  element → externref vec. **This stays — it is the uniform type-side anchor.**

### Changes — align construction/access to the externref vec

Each site below currently diverges by resolving the **scalar** element. The fix
is the same shape used in the landed `compileArrayConstructorCall` prototype:
detect `pureUndefinedVoidElem` (element flags are only `Undefined`/`Void`) and
force `elemWasm = { kind: "externref" }` so the pushed values, the
`array.new_fixed`/`array.new_default` type, and the vec struct all agree with #3.

**Site A — `Array(...)` (non-`new`). DONE on the branch (keep).**
`src/codegen/literals.ts` `compileArrayConstructorCall` (~3957): the
`pureUndefinedVoidElem → externref` branch. Verified: `Array(undefined,
undefined).length === 2`. ✓

**Site B — `new Array(elem, …)`. `src/codegen/expressions/new-super.ts`, the
`if (className === "Array")` block (~line 4744; line 4780 on current main).**
The bug: `vecTypeIdx` is taken from `resolveWasmType(ctx, exprType)` (externref
vec via #3, line ~4776) but `elemWasm = elemTsType ? resolveWasmType(ctx,
elemTsType) : {f64}` (line ~4780) resolves the **scalar** undefined → `f64`, so
`array.new_fixed` pushes f64 into the externref array → the verified
`CompileError: array.new_fixed[0] expected type externref, f64`. **Fix:** after
computing `elemWasm`, apply the same `pureUndefinedVoidElem` guard (using
`typeArgs[0]`) → `elemWasm = {kind:"externref"}` (vecTypeIdx already externref).
Also ensure the per-arg compile pushes each arg with `expectedType = elemWasm`
(externref → ref/box path), and any padding/default uses `emitUndefined`, not the
f64 sNaN. This fixes regressed tests S15.4.2.1_A2.1_T1 (T2) and unblocks sort
(T3 — its failure was the `new Array` construction, not sort itself).

**Site C — sparse / hole array literals `[, , ,]` and `[undefined, …]`.
`src/codegen/literals.ts` `compileArrayLiteral` (~3080) and the hole path
(`emitHoleSentinel` / the `_isUndefinedLike` + `expectedType.kind === "f64"`
sNaN branch, ~2764).** When the literal's vec element is externref (all-hole /
all-undefined → #3 externref vec), holes and `undefined` elements must be emitted
as externref-undefined (`emitUndefined`) — the existing tuple path at ~2780
already does this for `expectedType.kind === "externref"`; the **vec** literal
path must do the same instead of the f64 sNaN sentinel. This fixes the
reduceRight sparse case (T4: `15.4.4.22-8-c-4.js`); verify holes remain
**absent** for `HasProperty` (reduceRight/forEach must skip holes), i.e. the
hole sentinel for an externref vec must still be recognized as a hole by the
iteration/HasProperty path (`array-holes.ts`), not as a present `undefined`.

**Site D — array methods that rebuild the backing array for an `undefined[]`
receiver.** `src/codegen/array-methods.ts`: `sort`/`toSorted`
(`compileArrayToSorted` ~3336, `array.new_default` ~3262), and any method using
`array.new*`/element copy. These read the receiver's vec type; once B/C build
externref vecs they should largely follow, but **audit every `array.new_fixed` /
`array.new_default` / element load-store in sort/reduce/reduceRight/concat/slice/
splice/copyWithin for the externref-element case** — the canonical failure
signal is `array.new_fixed[N] expected type externref, …`. Spec test: `new
Array(undefined,undefined).sort()` (T3) and the reduceRight test (T4).

**Site E — indexed read/write of an `undefined[]`.** The generic element-access
path should already handle an externref vec (it keys off the vec type), but add a
scoped check: `var a = Array(undefined,undefined); a[0]` and `a[0] = x` must read
back `undefined` / store correctly. Low risk; verify, don't pre-emptively change.

### Wasm IR pattern (the invariant to hold at every site)

```wasm
;; vec element type (from #3) === value pushed === array.new_* element type
;; undefined[] / void[]  ⇒  $vec_externref { (field $len i32) (field $data (ref $arr_externref)) }
;; undefined value / hole ⇒ call $__get_undefined   (NOT i64.const 0x7FF00000DEADC0DE ; f64.reinterpret_i64)
```

The sNaN f64 sentinel is ONLY for f64-vec/scalar undefined; for an externref vec
the undefined/hole sentinel is the host-undefined singleton via `emitUndefined`.

### Edge cases

- **Genuine evolving undefined returned** (`function f(){ var a=[];
  a.push(undefined); return a; }`): verified CORRECT under externref — boxed
  undefined preserves `a[0] === undefined`. No special-casing needed.
- **`number[]` / `boolean[]`**: element flags carry Number/Boolean, not pure
  Undefined/Void → guard does not fire → stay f64/i32. Verified `Array(0,1,0,1)`
  and `[1,2]` untouched.
- **`number | undefined` (union)**: carries the Union flag, NOT pure Undefined →
  must NOT become an externref-of-boxed vec via these guards (it has its own
  union representation). Guard's `& ~(Undefined|Void) === 0` test already excludes
  it; keep that exact predicate at every site.
- **delete/optional-property f64-sNaN sentinel (#1112)**: unaffected — those are
  scalar `undefined`-typed bindings (no array), gated by #1's void-EXPRESSION-only
  rule. Do not widen #1.
- **Holes vs present-undefined for HasProperty**: reduceRight/forEach/every/some
  must still SKIP holes (§ spec). Ensure the externref hole sentinel is
  distinguishable from a stored externref-undefined where the spec requires it
  (array-holes.ts). This is the subtle one — test `15.4.4.22-8-c-4.js` and a
  `forEach` over `[,,,]` (callback must not run).
- **Mixed `[undefined, 1]`**: element type is `number` (or `number|undefined`),
  not pure undefined → stays numeric/union; not in scope.

### Test plan (gate: ZERO regressions — the ratio gate requires clean, not net-positive)

Scoped local (dev, fast):
1. `parse("foo(bar,baz)").arguments` → `[Identifier, Identifier]` via the acorn
   dogfood harness (`tests/dogfood/acorn-harness.mjs`) — the milestone MUST hold.
2. The 4 regressed tests must PASS:
   - `built-ins/Array/S15.4.1_A2.1_T1.js` (`Array(undefined,undefined).length===2`)
   - `built-ins/Array/S15.4.2.1_A2.1_T1.js` (`new Array(undefined,undefined)`)
   - `built-ins/Array/prototype/sort/S15.4.4.11_A1.3_T1.js`
   - `built-ins/Array/prototype/reduceRight/15.4.4.22-8-c-4.js`
3. `tests/issue-2806.test.ts` stays green.
4. Quick smoke (the probes used to validate this spec, banked in the architect's
   `.tmp/probe-opt2.mjs`): `Array(undefined,undefined).length`, `new
   Array(undefined,undefined).length`, `.sort().length`, sparse-`[,,,]`
   reduceRight visit-count (0), numeric `Array(0,1,0,1)` / `[1,2]` unchanged.

Full CI (REQUIRED — representation-scale, reference_2379): full `merge_group` +
standalone-floor. Watch `built-ins/Array/**`, `built-ins/Array/prototype/**`, and
TypedArray buckets. **Do not enqueue on net-positive-with-regressions** — the
ratio gate (≥10% = 5/12 last time) requires a clean run. Budget 1–2 merge_group
rounds to chase any straggler `array.new_*` divergence (the canonical signal:
`array.new_fixed[N] expected type externref, …`).

### Blast radius + classification

- **Files:** `literals.ts` (Site A done + Site C), `expressions/new-super.ts`
  (Site B), `array-methods.ts` (Site D audit), `array-holes.ts` (hole-sentinel
  for externref), plus the preserved #1/#2/#3. ~4–5 files, all in the array
  construction/access lane.
- **Class:** representation-scale change (reference_2379 hazard) — **senior-dev,
  `reasoning_effort: max`**, validate on full `merge_group`, not a scoped sweep.
- **Base branch:** build on the preserved `issue-2806-untyped-array-ref-vec`
  (commit `babfff3ce`, has #1+#2+#3 + Site A). Add Sites B–D; re-merge
  `origin/main`; enqueue only on a clean merge_group.

## Resolution (2026-06-29, branch `issue-2809-rep-final`)

All five sites resolved; the four regressed test262 cases pass, the acorn
milestone holds, and numeric arrays are untouched.

- **#1 / #2 / #3** (the #2806 foundation), **Site A** (`Array(...)`), **Site B**
  (`new Array(...)`) — preserved from the base branch
  `issue-2809-array-rep-impl` (commit `39e8d7e2`). Verified still correct.
- **Site C — the only remaining code change.** The spec framed Site C as a
  *construction* fix in `literals.ts`, but the literal hole path already emitted
  the `$Hole` sentinel correctly (#2001 S1). The real regression was downstream
  in **`compileArrayReduceRight`** (`src/codegen/array-methods.ts`): a sparse
  `[,,,]` externref vec with **no initial value** trapped
  ("dereferencing a null pointer").

  **Root cause (reference_1461 class — late-import funcIdx shift, NOT a
  representation bug).** The no-init seed (`acc = data[len-1]`) and the
  per-iteration element load map a `$Hole`→`undefined` via
  `holeToUndefinedInstrs`, which runs `emitUndefined` into a **detached** body.
  `emitUndefined`'s internal `flushLateImportShifts` therefore patches that
  detached array, not the real `fctx.body` holding the callback closure's
  `ref.func`. When `__get_undefined` is *first* registered there, the
  late-import funcIdx shift is silently consumed and the closure `ref.func` is
  left pointing at the wrong (pre-shift) function — so `call_ref` dereferences a
  stale/null funcref and traps. An *explicit* `[undefined, undefined]` array did
  NOT regress, because it registers `__get_undefined` during construction
  (before the closure is emitted) — that asymmetry was the diagnostic key.

  **Fix:** pre-ensure `__get_undefined` + flush against the real body at the top
  of `compileArrayReduceRight`, *before* `setupArrayCallback` emits the closure
  `ref.func`. The later `holeToUndefinedInstrs` registrations are then idempotent
  (no further shift). Surgical: it relocates the function's existing pre-ensure
  block earlier. An earlier exploration also widened the reduce/reduceRight
  accumulator to externref for externref vecs, but the funcIdx fix alone is
  sufficient, so that change was reverted to keep the blast radius minimal.
- **Site D** (sort/toSorted backing) and **Site E** (indexed read/write) —
  **verified, no change needed.** `new Array(undefined,undefined).sort()` already
  builds an externref vec via Site B and passes; indexed reads of
  `Array(undefined,…)` behave byte-identically to `main` (so any divergence there
  is pre-existing, not a regression of this work).

### Test Results (local)

- 4 regressed test262 tests PASS: `S15.4.1_A2.1_T1`, `S15.4.2.1_A2.1_T1`,
  `prototype/sort/S15.4.4.11_A1.3_T1`, `prototype/reduceRight/15.4.4.22-8-c-4`.
- acorn milestone HOLDS: compiled-acorn `parse("foo(bar,baz)").arguments` →
  `["Identifier","Identifier"]` (full pinned acorn, 85 s compile).
- `tests/issue-2806.test.ts` green (5/5); new `tests/issue-2809.test.ts` green
  (6/6); broad array-method smoke (numeric reduce/reduceRight/sort/map/filter,
  string reduce, `Array`/`new Array(undefined,…)` length) clean.

Supersedes #2284 (the PARKED #2806 PR). Closes the #2801/#2806 acorn-arguments
milestone path. Full `merge_group` + standalone-floor validation on the PR.
