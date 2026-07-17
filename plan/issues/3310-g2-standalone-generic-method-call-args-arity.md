---
id: 3310
title: "G2 — args-passing on the standalone generic method-call path + `__apply_closure` arity>4 lift (wantArgs is host-gated)"
status: ready
created: 2026-07-16
priority: medium
horizon: m
feasibility: hard
reasoning_effort: high
task_type: feature
area: codegen, standalone
language_feature: dynamic-dispatch
goal: runtime-eval
sprint: current
parent: 2927
related: [2928, 1584, 2151, 1888, 3098]
---

# #3310 — G2: pass args on the standalone generic dispatch path; lift the arity-4 ceiling

Slice **G2** of the #2928 `CallBuiltin` prerequisites
(`docs/architecture/runtime-eval-interpreter.md` §16; #2927 Part-2 audit).
A **hard** prerequisite of E5 alongside G1 (#3309).

## Problem

Two independent caps on the standalone generic `(any, …) → any` call surface:

1. **`wantArgs` is host-gated.** `emitWrapperDynamicMethodCall`
   (`src/codegen/expressions/calls.ts:2696`) builds the args vector only when
   `!ctx.standalone && !ctx.wasi` (line ~2712:
   `const wantArgs = callExpr !== undefined && callExpr.arguments.length > 0 &&
!ctx.standalone && !ctx.wasi`). Under standalone the generic
   `__extern_method_call(recv, name, argsVec)` path is invoked with an EMPTY
   args vector — a dynamic method call that reaches this lane silently drops
   its arguments. (The #2151 fixed-arity/vararg dispatchers cover the
   closed-struct + brand-arm receivers; this gap is the _open-`$Object`_ lane
   — e.g. a method stored on an open object and invoked with args through the
   wrapper path.)
2. **Arity ceiling.** The native `__extern_method_call` → `__apply_closure`
   bridge dispatches on `__extern_length(args)` to `__call_fn_method_0..4`
   (`src/codegen/object-runtime.ts` ~4269–4310, filled by `fillApplyClosure`).
   Calls with >4 args fall off the bridge. The #2928 interpreter's
   `CallBuiltin(name, recv, argsVec)` needs unbounded (or much higher) arity.

## Implementation plan (distilled)

1. **Grow the standalone args builder**: in `emitWrapperDynamicMethodCall`,
   under standalone/wasi build the args vec with the native `$ObjVec` builders
   (`__objvec_new` / `__objvec_push`, `ensureObjVecBuilders` — the exact
   pattern the #2151 dispatcher fill uses for its bottom arm,
   `closed-method-dispatch.ts:448-470`) instead of gating `wantArgs` off. The
   host lane keeps its `arrPushIdx` path.
2. **Arity lift**: extend the `__apply_closure` bridge beyond
   `__call_fn_method_4`:
   - Either generate `__call_fn_method_N` up to the max arity observed in the
     module (compile-time-known), or
   - add a spill arm: for `n > 4`, invoke through a single
     `__call_fn_method_vec(recv, fn, argsVec)` that the closure-struct arms
     read positionally via `__extern_get_idx` (mirror of the #2151 vararg
     dispatcher's arg sourcing, `closed-method-dispatch.ts:1136-1152`).
     The spill arm is the better long-term shape — it is exactly the calling
     convention #2928's `CallBuiltin` wants (recv + boxed args vec).
3. **Reserve/fill discipline (#1719)**: all new helpers minted at reserve
   time; fills only READ funcMap.
4. Probe fixtures: open-`$Object` receiver with a stored closure invoked with
   1–6 args, standalone, asserting 0 function imports and correct arg values;
   a 5-arg closure through `__apply_closure`.

## Acceptance criteria

- [ ] Standalone: a dynamic method call through the generic open-`$Object`
      lane receives its arguments (values observable in the callee).
- [ ] A 5+-arg call through `__apply_closure` dispatches (no undefined
      fall-through).
- [ ] Host mode byte-stable; scoped suites green (#2151/#1888/#3117 families).

## Notes

G1 (#3309) covers the Map/Set brand arms; G3 is done (#3098). This slice is
the remaining "args actually flow" half of the #2927 audit's headline gap 2.
Umbrella: #2927 → #1584.
