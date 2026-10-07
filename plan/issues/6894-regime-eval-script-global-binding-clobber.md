---
id: 6894
title: "Regime: in an eval-mentioning script a top-level `var` re-initialises a hoisted function binding — `called value is not a function` on harness/deepEqual-*.js and S13.2.1_A6_T3"
status: ready
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
