---
id: 7632
title: "Runtime-link probe: the user module fails with 'could not allocate its exact singleton support'"
status: in-progress
sprint: current
created: 2026-11-28
updated: 2026-11-28
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: ir
goal: ir-full-coverage
related: [2928, 7631]
---

# #7632: the runtime-link probe's user module no longer compiles

## Problem

`tests/issue-2928-runtime-link.test.ts` › "returns and invokes an interpreted closure across the Wasm module boundary"
is red on main 234cf440. The report reads:

```
CompileError: WebAssembly.Module(): BufferSource argument is empty
    at main (tests/interp/runtime-function-link-probe.mjs:956)
```

The empty binary is the probe's **user** module (`USER_SOURCE`, compiled with `target: "standalone"`), not the
runtime provider. The provider builds in provider-only mode, so the first case in the same file passes. The user
compile fails with:

```
Codegen error: prepared function-value target ir-unit:v1:ir-source%3Av1%3A0000000000000000%3Aentry%3Aruntime-eval-user.ts:root:top-level-function:0000000000000000 could not allocate its exact singleton support
```

This is the `IrInvariantError` in `src/codegen/ir-imported-call-planning.ts` (~L1126).
`ensureFuncClosureSingletonAccessor` returns no singleton, trampoline, cache global or accessor for the target.

Found while working on #7631 (PR #7565). The cause is not #7631: the probe's provider builds with the old private
`INTERP_FILES` list and with the shared one alike.

## Repro

```bash
node --max-old-space-size=3072 --import tsx tests/interp/runtime-function-link-probe.mjs | head -c 400
```

Greedy deletion over the probe's exports, then over lines, gives the minimal repro below.

## Minimal repro (main 28ca865e, 2026-11-28)

```ts
function d(v: string): string { return v; }
export function c(): number { const fn: any = new Function(d("a")); return 1; }
export function f(): number { const F: any = Function; return 1; }
export function s(): any { return 1; }
```

It fails on standalone with the IR on, and on gc with the IR on. It compiles only with `experimentalIR: false`. Each of
the three exports is needed:

- the non-literal `new Function(d(...))` makes the program a runtime-eval consumer;
- `Function` as a value queues the Function-constructor companion seed;
- an `any`-returning export makes declaration collection build the dynamic boundary bridge, and that flushes the seed.

## Root cause

`ensureFuncClosureSingleton` (`src/codegen/closures/method-trampolines.ts`) picks the wrapper's result type from
`ctx.runtimeEvalGlobalFunctionBindings` (the #6647 live-binding result bridge: `ref` results become `externref`).
That flag is set in `registerReassignedFunctionGlobals` (`src/codegen/index.ts`, called after `collectDeclarations`),
but it is a pure function of `ctx.runtimeEvalBoundaryPlan`, which is built earlier. In between, `collectDeclarations`
already builds singletons:

```
collectDeclarations → recordExportSignature → ensureNativeDynamicBoundaryBridge → ensureAnyHelpers
  → ensureObjectRuntime → flushPendingNativeProtoSeeders → (Function companion seed)
  → emitStandaloneIntrinsicFunctionValue → ensureRuntimeEvalGlobalCall
  → emitRuntimeEvalGlobalBindingPushBody → emitCachedFuncClosureAccess(d)
```

That builds `__fn_tramp_d_cached` with the flag still unset, so its result is `(ref $string)`. Prepared IR planning
(`prepareTopLevelFunctionValueTargetSupport` → `ensureFuncClosureSingletonAccessor`) later asks for the same
singleton with the flag set, so it wants an `externref` result. The reuse check rejects the existing trampoline,
`ensureFuncClosureSingleton` returns null, and the planner throws the invariant. The flag is read before it is
written: the bug is ordering, not the IR. The legacy path keeps the stale `ref`-result wrapper silently, which is the
shape #6647 fixed for live global bindings.

`tests/issue-2928-runtime-link.test.ts` has two more failures that are not this bug. Both are measured on main with
`experimentalIR: false` too:

1. **A stale probe stub (fixed here).** Since #7441, `compileDynamicFunctionMeta` checks the body span
   (`fitsFunctionSourceText(…, fnBody.start, fnBody.end)`). The probe's stub `parse` returns hand-built function ASTs
   without `start`/`end`, so every dynamic `Function` in the probe throws a SyntaxError. That covers 11 of the 12
   execution errors.
2. **`aotThrowRoundTrip` (out of scope).** An exception thrown by an AOT function and caught by interpreted
   `try/catch` crosses the module boundary uncaught. It fails the same with the IR on or off. Routed separately.

## Implementation Plan

**Module.** `src/codegen/expressions/runtime-eval-provider.ts`, which owns the provider linkage state
(`runtimeEvalProviderLinkable`).

**Change.**
- A new `applyRuntimeEvalBoundaryPlan(ctx, sourceFiles)` builds `ctx.runtimeEvalBoundaryPlan` and sets the two flags
  derived from it, `runtimeEvalCallableBoundaryEnabled` and `runtimeEvalGlobalFunctionBindings`.
- Both generators call it: `generateModule` (index.ts ~5439) and `generateMultiModule` (~9901).

**Reuse / duplicate removed.**
- The two identical "build plan, then set `runtimeEvalCallableBoundaryEnabled`" blocks in index.ts become the one call.
- `registerReassignedFunctionGlobals` reads `ctx.runtimeEvalGlobalFunctionBindings` instead of recomputing its local
  `runtimeEvalConsumer` from the plan, and stops writing the flag.
- It keeps the eval-visible var widening, which must stay after declaration collection.
- No new predicate and no change to `ensureFuncClosureSingleton`: the singleton becomes correct because its input is
  final before the first reader.

**Tests.**
- `tests/interp/runtime-function-link-probe.mjs`: the stub `parse` gives the four function ASTs their body span, via
  one `withBodySpan(source, ast)` helper next to `parse`.
- `tests/issue-2928-runtime-link.test.ts`: the user module's import order becomes `apply_interpreted, indirect_eval,
  new_function, direct_eval`. The first request now comes from the declaration-time seed, which asks for the global
  call support first. The assertion stays exact. The `aotThrowRoundTrip` expectation is not touched: that row stays
  red, with the reason in the routed issue.
- A new `tests/issue-7632-runtime-eval-binding-singleton.test.ts` compiles the minimal repro on gc and standalone,
  each with `experimentalIR` on and off. It asserts success, and that `__fn_tramp_d_cached` returns `externref` in
  each, so the wrapper ABI no longer depends on emission order.

**Byte identity (measured with a prototype, 2026-11-28, main 28ca865e).**
- 150 test262 files that use `eval(`/`Function(` (built-ins/Function, language/eval-code, built-ins/global,
  language/statements/function, with the assert and sta harness): 450 compiles across gc, standalone and Prepared,
  all succeeding, 0 byte differences.
- In the implementation PR: the same A/B, plus the 20-program literal-`Function` corpus from #7631, gc and standalone.
- Any byte difference must be in a program where a function-value singleton was built during declaration
  collection, and it is listed in the PR.

## Acceptance

- The minimal repro compiles on gc and standalone, with the IR on and off, and the new test pins the wrapper ABI.
- `tests/issue-2928-runtime-link.test.ts` passes, except the `aotThrowRoundTrip` row, which has its own routed issue.
  (Prototype: user module compiles; 11 of 12 execution errors are gone; with the import-order update only
  `aotThrowRoundTrip` remains.)
- The byte A/B above shows 0 differences outside the affected shape.
- All gates are green.
- Code quality:
  - one helper replaces two duplicated blocks and one recomputation;
  - no defensive branch;
  - no change to the singleton reuse check, which was right to refuse a mismatched ABI.

