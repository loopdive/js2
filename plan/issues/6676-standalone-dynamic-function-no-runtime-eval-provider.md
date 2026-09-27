---
id: 6676
title: "standalone: Function('return this')() and dynamic Function(src) imported js2wasm:runtime-eval into zero-import binaries (lodash-es _root/template)"
status: done
sprint: current
created: 2026-09-24
updated: 2026-09-24
completed: 2026-09-24
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
language_feature: eval
goal: standalone
requested_by: ttraenkler/sendev-standalone
related: [6675, 2924, 2928, 2960, 6659]
---

# #6676 — `Function(...)` pulled the runtime-eval provider into lodash-es

## Problem

Second half of the lodash-es `standaloneDynamic` `host-import-error` (see
[#6675](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6675-standalone-timer-globals-no-event-loop)):
`js2wasm:runtime-eval.__runtime_new_function` and
`__runtime_apply_interpreted`. Two lodash-es shapes emit them, each on its own
(measured separately with a two-file `.js` probe):

| source | shape | why it reached the provider |
| --- | --- | --- |
| `_root.js` (module init) | `Function('return this')()` | the #2924 constant compile-away bails on any body mentioning `this` (its splice binds `this` to `undefined`) |
| `template.js` | `Function(importsKeys, sourceURL + 'return ' + source)` | genuinely dynamic body |

Standalone's design links a core-Wasm runtime-eval provider (QuickJS or the
refusal provider, #2928) at instantiation — test262's standalone lane does
exactly that, so the import must stay the default. The npm-compat standalone
lanes instantiate with **zero** imports, so for them no provider exists.

## Implementation Plan

1. **Constant global probe** — `tryStandaloneReturnThisFunctionCall`
   (`src/codegen/expressions/standalone-dynamic-code.ts`, new): the immediate
   call `Function("return this")()` / `new Function("return this;")()` with
   the global `Function` (checked via `ctx.oracle.valueDeclarationOf`) and a
   literal body matching `return this` folds to the realm global object
   (`emitGlobalEnvironmentObject`). A dynamic function is sloppy unless its own
   body says otherwise, so the call's `this` is the global object (§10.2.1.2).
   Standalone only (`environment === "none"`); no option needed.
2. **`runtimeEvalProvider: false`** (new `CompileOptions` field, standalone
   only; refused on other targets): declares the module will instantiate
   without the provider. Then `Function(src)` / `new Function(src)` (value,
   `new`, and immediate-call forms) evaluate their argument expressions in
   order and throw `EvalError: Code generation from strings disallowed for
   this context` — HostEnsureCanCompileStrings refusing, as V8 does under a
   CSP without `unsafe-eval` — instead of importing the interpreter. Hooked
   at the single dynamic chokepoint `emitStandaloneDynamicFunctionRuntime`
   (value/`new` forms) and in `tryStandaloneHostFreeCall` (immediate form).
   Default (`true`/omitted) is byte-identical.
3. `scripts/generate-npm-compat-report.mjs`: both standalone lanes pass
   `runtimeEvalProvider: false` — the report owns its deployment tier, and that
   tier links nothing.

## Resolution

- lodash-es `standaloneDynamic`: `host-import-error` (4 imports) →
  `runtime-error` at module-init with **0 imports**; next blocker verbatim:
  `TypeError: Date.now is not yet implemented in --target standalone`.
- `tests/issue-6676-standalone-dynamic-function-no-provider.test.ts`: parent
  3 fail / 1 pass (the default-provider control); fix 4/4.
- Scoped STANDALONE test262 (311 rows: every `Function('return this')` file,
  every file mentioning a timer or including `atomicsHelper.js`, and
  `built-ins/Function/*.js`; `scripts/run-test262-paths.mts --standalone`,
  QuickJS provider linked): parent `pass 172 / fail 10 / compile_error 112 /
  skip 17` → fix identical, per-row verdicts identical.
- JS-host control: lodash-es upstream suite 59/62 (unchanged). Related
  standalone suites (#2924, #2960, #2928 refusal provider, #3436, #6659):
  42/42.

Residual: `eval(src)` / indirect eval under `runtimeEvalProvider: false` still
import the provider (no npm-compat lane needs it yet); the bare `Function`
value read (`var F = Function`) likewise.
