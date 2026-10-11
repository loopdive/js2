---
id: 6956
title: "standalone with `runtimeEvalProvider: false`: a direct `eval(nonConstant)` still imports `js2wasm:runtime-eval.{__runtime_direct_eval,__runtime_apply_interpreted}` (only `Function(...)` is refused) — module cannot instantiate (Octane earley-boyer `sc_jsNew`)"
status: in-progress
assignee: ttraenkler/senior-dev
sprint: current
created: 2026-10-10
priority: high
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: compiler
language_feature: eval
goal: standalone-gap
related: [874, 6676, 2960, 4195, 2928]
# 2026-10-10: the refusal helper (+51 lines) and its one-line guard live in calls.ts because the
# Session C file release for this issue covered calls.ts only; candidate to move into
# standalone-dynamic-code.ts next to emitRefusedDynamicFunction.
loc-budget-allow:
  - src/codegen/expressions/calls.ts
func-budget-allow:
  - src/codegen/expressions/calls.ts::compileCallExpression
---

# Direct eval ignores the "no runtime-eval provider" switch

Found by the Octane standalone triage (Session D, 2026-10-10). `earley-boyer` fails at instantiation on
standalone: the module leaks `js2wasm:runtime-eval.__runtime_apply_interpreted` and
`js2wasm:runtime-eval.__runtime_direct_eval`. The only dynamic-code site in the 4,684-line benchmark is
`sc_jsNew` (earley-boyer.js:1867-1874), a Scheme2Js runtime helper that is **never called**:

```js
function sc_jsNew(c) { var evalStr = "new c("; … evalStr += ")"; return eval(evalStr); }
```

## Minimized (`.tmp/eb1.js`, node `1`)

Same function + `export function main() { return typeof sc_jsNew === "function" ? 1 : 0; }`.
Standalone, with AND without `runtimeEvalProvider: false`: `LEAKED IMPORTS: js2wasm:runtime-eval.__runtime_apply_interpreted,
js2wasm:runtime-eval.__runtime_direct_eval` → `WebAssembly.instantiate(): Import #0 module="js2wasm:runtime-eval"`.

## Root cause

`isRuntimeEvalProviderAbsent` (`src/codegen/expressions/standalone-dynamic-code.ts:51`) is consulted by the
`Function(...)` constructor path (`eval-inline.ts:2204`), the generator dynamic path and the global-object
carriers — but NOT by the direct-eval route in `compileCallExpression`
(`src/codegen/expressions/calls.ts:7912-7924`):

```ts
: ctx.standalone && ensureRuntimeEvalCallableCarrier(ctx, fctx)   // ← imports __runtime_apply_interpreted
    ? emitStandaloneDirectEvalRuntime(ctx, fctx, expr)              // ← imports __runtime_direct_eval (runtime-eval-provider.ts:1006)
```

nor by `emitStandaloneIndirectEvalRuntime` (`eval-inline.ts:2030`, `__runtime_indirect_eval`). The `(#2960)
noJsHost` refusal arm right below (calls.ts:7927-7940) already produces the correct catchable throw — it is
simply never reached because the carrier materialises first.

## Implementation Plan

1. **`src/codegen/expressions/calls.ts` ~L7912**: guard both standalone runtime-eval routes with
   `!isRuntimeEvalProviderAbsent(ctx)`:
   - `directEvalRunsAtScriptGlobal(expr, ctx) ? emitStandaloneIndirectEvalRuntime(…)` → only when the provider is not absent;
   - `ctx.standalone && !isRuntimeEvalProviderAbsent(ctx) && ensureRuntimeEvalCallableCarrier(…)`.
   With the provider absent, `runtimeEval` stays `undefined` and control falls into the existing `noJsHost(ctx)`
   refusal arm (`dynamicEvalRefusalMessages` → argument side effects → `emitThrowTypeError(refusal.thrown)`).
   Keep `ctx.directEvalMode === "reified-host"` (host import `env.__extern_direct_eval`) unchanged — it is host-only.
2. **`src/codegen/expressions/eval-inline.ts:2030` `emitStandaloneIndirectEvalRuntime`**: return `undefined`
   early when `isRuntimeEvalProviderAbsent(ctx)` (belt and braces: it is also reached from the spread/global paths).
3. The spec answer is a catchable **EvalError** per `DYNAMIC_FUNCTION_REFUSED` (§20.2.1.1.1 HostEnsureCanCompileStrings),
   whereas the `#2960` arm throws a TypeError — align the direct-eval refusal on `emitRefusedDynamicFunction`
   (standalone-dynamic-code.ts:55) so both dynamic-code forms throw the same EvalError.
4. **Harness** (`benchmarks/octane/worker-js2.mjs`, lane `standalone`): pass `runtimeEvalProvider: false` — the
   worker instantiates with `{}` imports, so a module that needs the provider can never run there anyway; this
   turns a linker failure into a program-visible EvalError at the (dead) call site.

### Acceptance
- `tests/issue-<id>.test.ts` standalone + `runtimeEvalProvider: false`: `.tmp/eb1.js` → `1` with
  `WebAssembly.Module.imports(mod).length === 0`; calling `sc_jsNew(Object)` throws EvalError; indirect
  `(0, eval)("1+1")` likewise; control: constant `eval("1+1")` still folds to `2`; without the option the
  imports are still emitted (provider mode unchanged).
- earley-boyer: instantiates on standalone and runs until the NEXT blocker, the fnctor-param inference issue
  (`.tmp/#6958`) — measured with `.tmp/patch-eb-noeval.mjs`:
  `TypeError: Cannot read properties of undefined (reading 'appendJSString')`.
- Size: **S** (two guards + harness flag).

## Implementation Notes (2026-10-10)

Done in `src/codegen/expressions/calls.ts` only (`emitRefusedEvalCall`, called from the eval branch of
`compileCallExpression` right after the compile-away shapes — constant inline, comment/RegExp peepholes,
spread — and before the runtime-eval route is chosen). Deviations from the plan, and why:

- **One guard instead of two.** The single `isRuntimeEvalProviderAbsent(ctx)` check sits before the
  direct/indirect/script-global selection, so it covers `emitStandaloneDirectEvalRuntime`,
  `ensureRuntimeEvalCallableCarrier` and `emitStandaloneIndirectEvalRuntime` at once; plan step 2
  (`eval-inline.ts`) is not needed for the call forms. The `ctx.directEvalMode === "reified-host"` route is
  host-only and unaffected (`isRuntimeEvalProviderAbsent` is false off standalone).
- **EvalError only for a string source.** PerformEval (§19.2.1.1 step 2) returns a non-String argument
  unchanged before HostEnsureCanCompileStrings runs, so `eval(42)` is `42`, `eval(o) === o`, `eval()` is
  `undefined`. The emitted code evaluates every argument in order, keeps the first, and throws the
  `Function(...)` refusal EvalError (`emitRefusedDynamicFunction`, same message) only when it is a native
  string (`any.convert_extern; ref.test $AnyString`). A host string passed in across the zero-import
  boundary is opaque without an import and passes through unchanged.
- **Harness step 4 not done here** — `benchmarks/octane/worker-js2.mjs` is out of this PR's scope; the harness
  branch (`claude/874-octane-harness`) already passes `runtimeEvalProvider: false` on standalone.
- Spread `eval(...args)` (`eval-spread-args.ts`) is not touched.

### Found, out of scope
- A compound `s += "x"` on a `var` of a function that contains a direct eval (the binding is reified into a
  `__direct_eval_cell_*` externref cell) miscompiles on standalone, with or without the provider:
  `function f(){ var s = "a"; s += ")"; if (0) eval(s); return s; }` → `NaN` (numeric `f64.add` on the
  cell value); `var r = "a"; r += eval("1+1") + ";"` → `null`. gc lane is correct. So `sc_jsNew` with its
  real `evalStr += …` build returns `NaN` instead of throwing — harmless for earley-boyer (never called).
- On `origin/main` alone, earley-boyer's `sc_jsNew` loop also fails validation
  (`local.tee expected (ref null cell), found i32`); fixed by #6955.

## Remaining (2026-10-10) — needs `src/codegen/index.ts`, outside this slice's file release

Measured on a local merge of this branch into `c-octane-integ` (with #6950/#6955), harness flags
`target: standalone, runtimeEvalProvider: false, inferModuleStrictArguments: false`:

- earley-boyer now **instantiates** (zero imports), but the run is **SIGKILLed** (memory blow-up, ~25 s after
  compile; `--max-old-space-size` does not turn it into a V8 OOM). The plan's `.tmp/patch-eb-noeval.mjs`
  measurement did not see this because it deletes the `eval` token; any surviving eval call — direct or
  indirect `(0, eval)(evalStr)` — triggers it, while `return String(evalStr)` does not.
- Cause: program-wide runtime-eval pessimizations in `src/codegen/index.ts` stay switched on although no
  provider can ever run code:
  - `runtimeEvalConsumer` (`index.ts` ~L9864; sets `ctx.runtimeEvalGlobalFunctionBindings` and keeps script
    `var` storage representation-neutral) — **this one causes the kill**;
  - `ctx.runtimeEvalCallableBoundaryEnabled` (`index.ts` ~L5333 and ~L10672, `callableBoundaryRequired`).
- Local experiment (not committed), adding `&& ctx.runtimeEvalProviderAbsent !== true` to:
  - `runtimeEvalConsumer` only → `Error: Earley or Boyer did incorrect number of rewrites`;
  - `runtimeEvalConsumer` and both callable-boundary sites → `TypeError: Cannot read properties of
    undefined (reading 'appendJSString')`, the expected #6958 blocker (acceptance met);
  - the callable-boundary sites only → still killed.
- Follow-up: gate those three `index.ts` sites on `!isRuntimeEvalProviderAbsent(ctx)` (an eval refused
  in-module cannot observe or replace any binding), then re-measure. Separately, `runtimeEvalConsumer`
  mode itself blows up on earley-boyer — a provider-present standalone bug.

