---
id: 4185
title: "perf: attribute standalone acorn's 607k-allocation stream; kill the top elidable stream (dead $ObjVec pairs on dynamic closure .call)"
status: in-progress
assignee: "ttraenkler/claude-fable-7"
sprint: current
created: 2026-08-06
updated: 2026-08-06
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: performance
area: codegen
goal: performance
related: [4157, 3927, 3921, 4173, 4174, 3685, 743]
loc-budget-allow:
  - src/codegen/closed-method-dispatch.ts
func-budget-allow:
  - src/codegen/closed-method-dispatch.ts::fillClosedMethodDispatch
origin: "#4157 umbrella — GC/alloc bucket is 20.66% of parse self-time (largest); #3927's census counted 607,469 allocs/parse with only 32,468 attributed to __fnctor_Node"
---

# #4185 — attribute the standalone allocation stream, kill the top elidable one

## Problem

The GC bucket is the largest in the standalone acorn parse profile (20.66%
post-#4174), and the #3927 census counted **607,469 allocations per parse** of
which `__fnctor_Node` — the retained AST — is only 32,468 (5.3%). The other
~575k were unattributed. Nobody knew what the compiler was allocating.

## Mandate 1 deliverable — the attributed allocation table

Census machinery extended (`src/codegen/alloc-census.ts`, all env-gated,
byte-identical off): `JS2WASM_ALLOC_CENSUS_BY_FUNC=1` (per-function×type
counters), `JS2WASM_ALLOC_CENSUS_FOCUS=<substr,…>` (type filter),
`JS2WASM_ALLOC_CENSUS_CALLS=<substr,…>` (per-caller→callee call counters),
plus a stderr shape/size report per counted type.

> Implementation note (WHY, for the next census user): per-caller matching
> MUST resolve callees through `ctx.funcMap`, not by position in
> `ctx.mod.functions` + `numImportFuncs`. Bodies carry mint-time HANDLES that
> the emitter resolves through the layout seam at encode time;
> `ctx.numImportFuncs` is additionally stale after dead-import elimination
> (reads 4 on a 0-import standalone module). Positional matching found 0 of
> 261k measured calls; funcMap matching found all of them.

Measured on main @ 431ea77d5, standalone-dynamic lane, optimize 4 (counts
identical at optimize 0 — the census installs pre-wasm-opt), checksum 422×3
intact, **614,820 allocations/parse** (drift from #3927's 607,469 is
main-advance). Top 10 by count, with per-function and per-caller attribution:

| count/parse | share | type (shape, est. bytes) | attributed to |
| ---: | ---: | --- | --- |
| 283,370 | 46.1% | `$AnyValue` (5 fields, ~32 B, transient) | `__any_from_extern` 261,362 — **100.0% called by `__extern_strict_eq`** (the #4173 stream); `__any_from_extern_honest` 20,454 (typed-this closures 18.7k + `__ir_dyn_string_replace` 1.7k); `__any_box_f64` 1,554 |
| 57,973 | 9.4% | `$AnyString` header (3 fields, ~20 B) | `__str_substring` 30,449 (header-only view — no char copy), `__str_concat` 19,786, `__str_slice` 3,683, rest string runtime |
| 41,811 | 6.8% | `$ObjVecArr` (externref array, cap 8 → ~40 B) | ALL in `__objvec_new`; callers: `__closure_method_call` 20,849 + `__call_m_call_2` 20,680 |
| 41,811 | 6.8% | `$ObjVec` header (2 fields, ~16 B) | same — **two dead arg-vec pairs per dynamic closure `.call`** |
| 33,761 | 5.5% | `__anon_14` (i32 array) | `__regexp_test_carrier` 29,117 (per-`.test` captures scratch), typed-this closure 4,291 |
| 32,468 | 5.3% | `__fnctor_Node` (69 fields, 292 B, retained) | `__fnctor_Node_new` — the AST; demoted per #3927 §6 |
| 31,415 | 5.1% | `__vec_externref` header (~16 B) | closure_550 17,091, `__call_fn_method_1` 5,160, `__fnctor_Scope_new` 4,125, `__vec_push` growth 2,970 |
| 27,668 | 4.5% | `__str_data` (i16 array) | `__str_concat` 19,786 (real char copies), `__str_slice` 3,683, rest |
| 27,361 | 4.5% | `__arr_externref` (backing arrays) | same producers as the vec headers |
| 18,722 | 3.0% | `type_187` (2×i32+ref, ~20 B) | `__regex_run` — per-run engine state |

Tail: `$DestructuringErrors` 7,252 (acorn's own per-`parseMaybeAssign`
allocation — real program behavior), `$BoxedNumber` 3,862, `$ConsString`
3,726, `$Scope` 1,375+4,125 vecs, object-runtime `$PropEntry`/`$PropMap`
~1,900.

**Reading of the table:**

- The #1 stream (46%) is `__extern_strict_eq`'s operand boxing — **already
  killed by in-flight #4173** (`JS2WASM_FAST_STRICT_EQ`, default ON, branch
  `claude/issue-4173-boxed-strict-eq`). Not duplicated here.
- The #1 **post-#4173 elidable** stream is the `$ObjVec` pair: 83.6k heap
  objects (~2.3 MB) per parse, all dispatch plumbing for ~20.7k dynamic
  `fn.call(this, x)` invocations (acorn's `update.call(this, prevType)` in
  `updateContext`, per context-sensitive token), unpacked immediately by
  `__apply_closure` and dead. Two pairs per call: `__call_m_call_2` packs all
  args, `__closure_method_call`'s %Function.prototype.call% route re-packs
  args minus thisArg.
- `$AnyString` substring headers and `__str_data` concat copies are the string
  VALUES themselves (not plumbing); `__fnctor_Node` is the retained AST
  (#3927 demotion stands); the regexp streams (48k) are engine-internal
  scratch — priced below, not taken in this slice.

## Mandate 2/3 — the kill: closure-receiver fast `.call` arm

`src/codegen/closure-call-fast.ts` + a one-call hook in
`fillClosedMethodDispatch` (`closed-method-dispatch.ts`, +6 lines — hence the
loc/func-budget allowances: the fill was exactly at both caps, and the
arm-chain hook cannot live outside the arm-chain builder; the arm body itself
is in the new file). Outermost arm in `__call_m_call_<K>` (K ≥ 1):

1. receiver `ref.test` funcref-wrapper root (closures are
   representation-disjoint from every other arm's receiver);
2. own-prop `call` override guard via `__extern_get` + `__nullish_to_null` —
   the same §10.2 [[Get]] precedence check `__closure_method_call` route 1
   performs (an override falls through to the legacy chain and still wins);
3. under-application gate: declared `$arity ≤ K−1`, because
   `__call_fn_method_N` carries only closures with formals ≤ N and the
   missing-arg padding lives in `__apply_closure`'s #3592 widening (silent
   vacuous-undefined hazard otherwise — the 9th-dogfood-wall class);
4. then direct `__call_fn_method_(K−1)(thisArg, fn, a…)` with argc
   preset/reset — byte-for-byte the #3673 round-13 cached-direct-call idiom.

Zero allocations on the fast path (WAT-verified: no `objvec_new`; legacy chain
intact in the else-arm). Flag `JS2WASM_FAST_CLOSURE_CALL`, `=0` restores the
legacy-only dispatcher. Vararg `.call(...xs)`, `.apply`, arity-0 `.call()`,
non-closure receivers: unchanged legacy path.

## Acceptance criteria

- [x] Top-10 attribution table with counts × size × producer × caller (above)
- [x] Mechanism WAT-verified before measurement
- [ ] Census A/B: `$ObjVec` allocations collapse on the standalone acorn parse
- [ ] Profile bucket + wall A/B with order-reversal controls (#3927 §6 rules)
- [ ] Semantics pinned: this-binding, under/over-application, own-prop
      override, flag-off parity
- [ ] Dogfood canaries 2/3/4/5, `functionImports: []`, 3 pre-existing
      IR-FALLBACKs unchanged
