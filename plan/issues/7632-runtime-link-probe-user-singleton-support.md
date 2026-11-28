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
related: [2928, 7631, 7633, 7634]
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
`ensureFuncClosureSingleton` returns null, and the planner throws the invariant.

**The flag is not the only stale input (plan review PRV-7632).** The whole push/pull sync is *filled* at that early
point (`ensureRuntimeEvalGlobalBindingSync`, filled once: `runtimeEvalGlobalSyncFilled`), and its inputs are only
final once `registerReassignedFunctionGlobals` and `registerAnnexBGlobalLiveBindings` have run:

- push reads `ctx.liveFuncBindingGlobals` to publish a live `$__mod_<f>`;
- pull filters on `ctx.moduleGlobals`, where the `$__mod_<f>` globals do not exist yet;
- both read the global types that registration widens to `externref`.

Measured on the minimal repro (standalone, main 28ca865e, IR off): `__runtime_eval_pull_globals` has 0 `global.set`,
so an interpreted `d = …` never reaches AOT code. Moving only the flag earlier would make the repro compile and keep
that hole.

**How often.** test262 sources are scripts without exports, so they never reach the early fill:

| corpus (150 eval/`Function` test262 files, assert + sta harness) | compiles | early fills |
| ------------------------------------------------------------------ | -------- | ----------- |
| as is, gc + standalone                                              | 300      | 0           |
| with `export function __probeAny(x: any): any` and `__probeStr(s: string): string` appended | 300 | 22 (11 files × 2 targets) |

All 66 fills in the plain corpus happen in a runtime-eval consumer (`ctx.runtimeEvalGlobalFunctionBindings` set).

## Other failures in the runtime-link test

`tests/issue-2928-runtime-link.test.ts` has two more failures that are not this bug. Both are measured on main with
`experimentalIR: false` too:

1. **#7634: the probe's stub parser.** Its function ASTs lack the body span #7441 checks. That accounts for 11 of the
   12 execution errors. It has its own issue file and plan, and lands as its own commit in this PR, because the probe
   can only be shown green once this fix lets the user module compile.
2. **#7633: `aotThrowRoundTrip`.** An AOT throw is not caught by interpreted `try/catch` across the module boundary.
   It is out of scope.

## Implementation Plan

**Module.** `src/codegen/expressions/runtime-eval-provider.ts`, which already splits
`reserveRuntimeEvalGlobalBindingSync` (mint the two empty functions) from the fill.

**Change: fill once the bindings are settled.**
- The emitters (`emitRuntimeEvalGlobalBindingSeed`, `emitRuntimeEvalResultUnwrap`) still call
  `ensureRuntimeEvalGlobalBindingSync`. That now reserves, and fills only if the bindings are already settled.
- A new `settleRuntimeEvalGlobalBindings(ctx)` marks them settled, and fills if the sync was already reserved.
- The fill moves unchanged into `fillRuntimeEvalGlobalBindingSync`.
- `runtimeEvalGlobalSyncFilled` is replaced by `runtimeEvalGlobalBindingsSettled` (`src/codegen/context/types.ts`), so
  the flag count stays the same.
- The fill now runs exactly once, when the second of the two events happens (reserved, settled), whichever order
  they come in. No flag stays whose value depends on when it is read.
- Both generators call `settleRuntimeEvalGlobalBindings(ctx)` right after `registerAnnexBGlobalLiveBindings`, the
  last registration of eval-visible bindings: `generateModule` (index.ts ~5898) and `generateMultiModule` (~10279).
- Only these two generators create a `CodegenContext`, so no path reserves without ever settling.

**What this removes.** The declaration-time `emitCachedFuncClosureAccess(d)` is gone, because the early seed now only
reserves. So `ctx.runtimeEvalGlobalFunctionBindings` stays where it is, next to its var widening (the index.ts ~9208
invariant), and nothing reads it before it is written.

**Shared plan block (review item 6).**
- The two identical blocks "build `ctx.runtimeEvalBoundaryPlan`, then set `runtimeEvalCallableBoundaryEnabled`"
  (index.ts ~5439 and ~9901) become one `applyRuntimeEvalBoundaryPlan(ctx, sourceFiles)` in the same module.
- It owns the plan and `runtimeEvalCallableBoundaryEnabled`, and nothing else.
- The fold offsets the two settle calls, so `index.ts` does not grow. The prototype's settle calls alone were +2
  against the LOC ceiling.

**Tests.**
- A new `tests/issue-7632-runtime-eval-binding-sync.test.ts`, red on main and green after:
  - (a) the minimal repro compiles on gc and standalone, each with `experimentalIR` on and off;
  - (b) semantics, from the emitted module: `__runtime_eval_pull_globals` writes `$__mod_d`, and
    `__runtime_eval_push_globals` reads `$__mod_d` rather than `$__fn_closure_d`. Prototype, standalone: pull writes
    global 1255 = `$__mod_d`, and push reads 1255.
  - If the review prefers a runtime check, `new Function("d = …")` visible to AOT through the runtime-link probe is
    the alternative. The probe needs #7634 for that.
- `tests/issue-2928-runtime-link.test.ts`: the expected user-module import order becomes `apply_interpreted,
  indirect_eval, new_function, direct_eval`.
  - This is compiled output and has nothing to do with the stub. Measured with the prototype: the order is the same
    with the original and the stub-fixed probe, because the stub lives in the provider source, not the user module.
  - `indirect_eval` comes first because the declaration-time `Function` companion seed lowers `Function` to
    `indirect_eval("Function")` (`emitStandaloneIntrinsicFunctionValue`) before any body asks for `new_function`.
  - Unverified (the clone is shallow): the old expectation predates that seed. The user module has not compiled on
    main since then, so the expectation could not be refreshed.
  - `aotThrowRoundTrip` stays excluded, citing #7633.

**Byte identity (prototype, 2026-11-28, main 28ca865e).**
- Plain corpus above: 300 compiles, gc + standalone, 0 byte differences.
- Export-bearing corpus above: 300 compiles, all succeed. Exactly the 22 early-fill rows differ (11 per target),
  and none of the other 278. Those 22 are the bug: their sync bodies were filled before the bindings were settled.
- In the implementation PR, rerun on the same corpora with the Prepared lane added, plus the #7631 literal-`Function`
  corpus. The changed rows must be exactly the early-fill rows, and they are listed in the PR.

## Acceptance

- (a) Red → green pin for the minimal repro: gc and standalone, IR on and off.
- (b) Semantic pin: pull writes back `$__mod_d`, and push reads `$__mod_d`.
- (c) Code quality:
  - one plan/flag block for both generators;
  - the sync fill in one place;
  - the settled/reserved pair replaces the filled flag, with no new ordering-dependent flag;
  - no change to the singleton reuse check, which was right to refuse a mismatched ABI.
- (d) gc and standalone byte-identical on everything but the early-fill rows of an export-bearing eval sample.
- (e) `tests/issue-2928-runtime-link.test.ts` passes, together with #7634, except `aotThrowRoundTrip`, which cites
  #7633.
- All gates are green, including `LOC_GATE_BASE=origin/main` with no grant for `src/codegen/index.ts`.
