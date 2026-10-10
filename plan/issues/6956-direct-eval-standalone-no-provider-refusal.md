---
id: 6956
title: "standalone with `runtimeEvalProvider: false`: a direct `eval(nonConstant)` still imports `js2wasm:runtime-eval.{__runtime_direct_eval,__runtime_apply_interpreted}` (only `Function(...)` is refused) — module cannot instantiate (Octane earley-boyer `sc_jsNew`)"
status: ready
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
