---
id: 6894
title: "Regime: in an eval-mentioning script a top-level `var` re-initialises a hoisted function binding — `called value is not a function` on harness/deepEqual-*.js and S13.2.1_A6_T3"
status: done
completed: 2026-10-07
assignee: ttraenkler/opus-6894
created: 2026-10-07
updated: 2026-10-07
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: runtime-eval, global-bindings
goal: architecture
sprint: current
parent: 5385
related: [6880, 6882, 4394, 4491]
# 2026-10-07 (opus-6894): +5 lines — the $Symbol exclusion arm of
# __typeof_object must go AHEAD of the regime's unconditional boundary arm;
# the finalizer is one ladder builder, splitting it for 5 lines is churn.
func-budget-allow:
  - src/codegen/typeof-natives-finalize.ts::fillStandaloneTypeofClosureArms
---

# #6894 — regime eval-mentioning script: `var` clobbers the hoisted function

Split out of #6882. #6880 attributed its ES5 "group 2" (`TypeError: called
value is not a function` on `harness/deepEqual-{object,primitives,circular,
mapset}.js` and `language/statements/function/S13.2.1_A6_T3.js`) to the
`__apply_closure` `boundary ?? peer` residue. Measured on #6882's branch, that
is not the cause: these are single-module rows (no linked provider is
involved), they fail identically before and after #6882, and they pass on
standalone. The trigger is the runtime-eval global-binding mode
(`ctx.runtimeEvalGlobalFunctionBindings`, set from `runtimeEvalConsumer` in
`src/codegen/index.ts` ≈ L9858/L9982), which every test262 row enters because
the `$262.evalScript` prelude mentions `eval`.

## Reduction (script goal, `deferTopLevelInit`, regime = `semanticProviders:
"native-first", hostBridge: "always"`)

```js
var ev = function (s) { return eval(s); };
var g;
function g() { return 1; }
g();   // regime: TypeError: called value is not a function · standalone: ok
```

Without the `eval` line, or without `var g;`, the regime passes.

`__module_init` (regime WAT) shows the order: the var globals are initialised
to `undefined` at the top, the function binding then stores the `g` closure
into the same global, `ev`'s initializer runs — and then `var g;` (no
initializer) is lowered as a STORE of `undefined` into that global, clobbering
the hoisted function. A `var` without initializer must be a no-op at its
statement position (§14.3.2.1).

`deepEqual-*.js` is the same family: `deepEqual.js` is assembled BEFORE
`assert.js`, so `assert.deepEqual = …` runs before the textual position of
`function assert`, and the later `assert.deepEqual(...)` reads `undefined`
(identity of the function binding in this mode — the #4394 "KNOWN GAP"
distinct-instance note in `global-function-bindings.ts` is the first place to
check).

## Acceptance

- The reduction above answers 1 on the regime.
- `harness/deepEqual-*.js` (7 rows) and `S13.2.1_A6_T3.js` pass on the regime
  lane; standalone unchanged.

## Implementation notes (2026-10-07, opus-6894)

Three independent defects. The reduction is the first; the deepEqual rows
also needed the second (all of them) and the third (`deepEqual-primitives`).

1. **`var g;` stored `undefined` at its statement position.** The module-global
   arm of `compileVariableStatement` (`src/codegen/statements/variables.ts`)
   emitted `emitUndefined; global.set` for every initializer-less module-scope
   binding. On standalone/wasi/regime the `__module_init` prologue already
   seeds every module-scope `var` slot with `undefined` (#4489,
   `declarations/module-var-undefined-seed.ts`), and the function-binding seeds
   run after it, so the statement-position store is either redundant or a
   clobber (§14.3.2.1: a `var` without initializer evaluates to nothing;
   §9.1.1.4.17 never resets an existing binding). The seeder now records which
   names it seeded (`moduleVarSlotIsUndefinedSeeded`), and the statement arm
   skips the store for a `var` (never `let`/`const`, whose TDZ exit is a real
   store) whose slot was seeded. Without eval the clobber was usually invisible
   because `g()` is called statically, but `x = 5; var x;` lost the 5 on
   standalone and regime too — that case is fixed by the same change.
   - **Byte effect:** the change is keyed to the seed, not to eval, so a
     standalone/wasi/regime program with an initializer-less top-level `var`
     loses one redundant `global.set` even without eval. Default gc (no seed)
     is untouched. Deliberate: gating on eval would leave `x = 5; var x;`
     wrong.
   - **Left out:** default gc (`x = 5; var x;` still answers `undefined` there):
     the host lane has no prologue seed, so its store is the only thing that
     turns the null-extern zero-init into JS `undefined`.

2. **A function-valued property of a top-level function lost its identity**
   (`assert.d === assert.d` false; `assert.deepEqual._compare = …` written
   into a throwaway object). In runtime-eval mode the global function binding
   is the AOT callable carrier, and its property-get trampoline
   (`syncedPropertyGetTrampolineBody`, `src/codegen/runtime-eval-callable.ts`)
   wrapped every callable it returned in a FRESH carrier — also for in-module
   reads. The wrap exists for the provider crossing only; it now runs only in
   the provider-active arm (`__runtime_eval_provider_active`), so in-module
   reads return the raw closure.

3. **`typeof sym !== "object"` was false on the regime** (only
   `deepEqual-primitives.js`: `format(Symbol())` fell through to
   `Reflect.ownKeys`). `finalizeTypeofNatives`
   (`src/codegen/typeof-natives-finalize.ts`) appends the `$Symbol` exclusion
   to `__typeof_object` AFTER the callable ladder, and on the regime that
   ladder ends with the boundary callable-kind arm, which returns
   unconditionally — so the symbol arm was dead code. With a boundary arm
   present the symbol arm now goes first; without one (standalone/wasi) the
   order, and the bytes, are unchanged.

Not this issue, found while reducing: `function A() {}; A.x = {}; A.x.f =
function () { return true; }; A.x.f()` throws `called value is not a function`
on every lane (gc included, eval or not) — the TS JS-expando typing of `A.x`.
Needs its own issue.
