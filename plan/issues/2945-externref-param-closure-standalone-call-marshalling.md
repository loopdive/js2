---
id: 2945
title: "Standalone: externref/any-param closure returns a wrong value on multi-arg or two-calls-in-one-expression (call-marshalling temp collision)"
status: ready
created: 2026-07-02
priority: medium
horizon: l
feasibility: hard
task_type: bug
area: codegen
language_feature: closures
goal: standalone
related: [2924, 2442]
blocks: [2924]
---

# #2945 — externref/any-param closure standalone call-marshalling temp collision

## Problem

On the **standalone** lane, a closure whose parameters are `any`/externref
returns a WRONG value when either:

- two calls to the same closure coexist in ONE expression (`f(1)+f(2)`), or
- the call passes **≥3 args**.

Single calls and reuse across **separate statements** are correct, and the
**JS-host lane is correct** on every shape. A **typed**-param closure
(`function(a:number){…}`) is also correct — only the `any`/externref-param path
is affected.

This is a general standalone closure-call correctness bug (not specific to any
feature). It surfaced while shipping #2924 (`new Function(<const>)`
compile-away): a `new Function`-synthesized function has all-externref params
(foreign, binding-less), so it inherits this bug — which is why #2924 slice-1 is
gated to the JS-host lane. **This issue blocks #2924's standalone enablement.**

## Repro (standalone; measured 2026-07-02)

```ts
// WRONG (standalone): returns an empty/garbage value instead of 23
export function test(): any {
  const f: any = function (a: any) {
    return a + 10;
  };
  return f(1) + f(2); // two calls coexisting in one expression
}

// WRONG (standalone): ≥3 args → NaN
export function test(): any {
  const f: any = function (a: any, b: any, c: any) {
    return a + b + c;
  };
  return f(1, 2, 3);
}

// CORRECT (standalone) — same shapes that WORK, for contrast:
//  - typed params:            function (a: number) { … }; f(1)+f(2)  === 23
//  - reuse across statements: const x=f(1); const y=f(2); return x+y === 23
//  - single call:             f(1) === 11
```

Host lane (`compile(src, { fileName })`) returns the correct value for ALL of
the above.

## Suspected mechanism

A **temp-local collision** in the standalone `call_ref`/closure-call arg
marshalling for externref-param closures: when two calls' argument temps (or the
call results) must coexist on the stack in one expression, the second call
reuses a fixed temp that clobbers the first, and the ≥3-arg case overruns a
fixed set of arg temps. Typed-param and single-call paths avoid the shared
temp. Start from the closure-call lowering (`compileClosureCall` /
`tryEmitInlineDynamicCall` and the externref-arg marshalling), auditing temp
allocation for per-call uniqueness (`allocTempLocal`/release scoping).

## Acceptance

- The two repros above return `23` / `6` in **standalone** (and stay correct in
  host); typed-param + single-call + reuse-across-statements stay correct.
- Then #2924 can drop its `ctx.standalone || ctx.wasi` gate and enable the
  compile-away on the standalone lane (host-free `new Function`).
- 0 test262 regressions; full `merge_group` + standalone floor.

## Pointers

- #2924 gate site: `src/codegen/expressions/new-super.ts`
  (`tryCompileConstantFunctionCtor`, the `if (ctx.standalone || ctx.wasi) return`).
- Repro scripts (this branch, `.tmp/probe-2924-anyparam.mjs`, gitignored).
