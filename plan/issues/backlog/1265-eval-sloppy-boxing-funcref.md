---
id: 1265
title: "eval tier 5: sloppy-mode direct eval — full local boxing + funcref globals"
status: backlog
created: 2026-05-02
updated: 2026-05-02
priority: low
feasibility: hard
reasoning_effort: max
task_type: feature
area: codegen
language_feature: eval, sloppy-mode
goal: compatibility
depends_on: [1261]
---
# #1265 — eval tier 5: sloppy-mode direct eval — full local boxing + funcref globals

## Background

Sloppy-mode direct eval is the hardest tier. Unlike strict mode, sloppy eval can:

1. Introduce new variables into the enclosing scope (the compiler can't know what variables
   exist after eval returns)
2. Replace top-level function declarations via `function greet() {}` inside eval

The shadow-scope approach from #1264 doesn't work here because the set of variables is open —
eval can create new ones.

## Approach

For modules that contain sloppy-mode direct eval:

### Local variables → full boxing

All locals in functions reachable by the eval site must be `externref` (boxed). This is the
only correct approach given the open variable set. At function entry/exit, unbox/rebox as needed
to interface with callers that use unboxed types.

### Function replacement → mutable funcref globals

Each top-level function gets a mutable funcref global:

```wat
(global $__fn_greet (mut funcref) (ref.func $greet))
```

All call sites to top-level functions use `global.get` + `call_ref` instead of `call`:

```wat
;; before: (call $greet ...)
;; after:  (global.get $__fn_greet) (call_ref $fn_type ...)
```

When eval replaces `greet`, the host runtime updates `$__fn_greet` to point to the new function.

### Blast radius analysis

The compiler statically identifies which functions are reachable by the eval site through
shared state (closures, globals, parameters, return values). Only those functions need boxing.
Functions that have no data path to the eval site are unaffected. This keeps the blast radius
bounded to the statically analyzable subgraph.

## Cost

- One `global.get` per top-level function call in affected modules
- `externref` locals in eval-reachable functions (boxing overhead on each use)

This is acceptable because sloppy-mode scripts are an increasingly rare target — TypeScript and
ESM (which are always strict) never hit this tier.

## Acceptance criteria

1. `function greet() { return "hello" }; eval("function greet() { return 'world' }"); greet()` → "world"
2. Locals in eval-reachable functions remain correct after eval introduces new variables
3. Functions with no data path to eval site have no funcref indirection (static blast radius)

## Depends on

#1261 (tiering classifier)

## Note

TypeScript/ESM consumers never hit this tier. This exists purely for sloppy-mode legacy script
compatibility and can be deferred indefinitely unless a specific use case requires it.

## Implementation Plan

(Author: architect, 2026-05-21. Defer-indefinitely tier. Spec
included for completeness.)

### Recommendation: defer

Per the issue note, TypeScript/ESM users never hit this. Cost is
high (full boxing of locals in affected functions, indirect call
through funcref globals). Recommend keeping this in backlog
unless a specific user demands sloppy-script support.

### If pursued

1. **Blast-radius analysis**: extend #743 type flow with an
   `eval-reachable` flag. Any function transitively reachable
   through closures/globals/params from a sloppy direct-eval site
   is marked.

2. **Boxing in reachable functions**: every local becomes
   externref; reuse the codegen path that exists for
   `noUsageInfer` cases.

3. **Funcref globals**: every top-level function declaration
   emits a `(global $__fn_<name> (mut funcref) (ref.func $<name>))`.
   All call sites to top-level functions in reachable modules
   change to `global.get + call_ref`.

4. **Host eval helper**: `__eval_sloppy(str, scopeRef)` parses
   inside JS host, executes, and patches the funcref globals via
   `__set_global_fn(name, funcref)` import.

### Edge cases

- **`function foo() {}; var foo = 1` after eval** — global is now
  `1` (non-callable). Subsequent call_ref throws TypeError
  (correct).
- **Nested closures**: reach-analysis must walk capture chains.
- **Hoisting**: `eval("function f(){}")` hoists `f` to the
  enclosing var environment per sloppy semantics.

### Test262 paths

- `test/annexB/language/eval-code/*` — sloppy var-env-funcs.
- `test/language/eval-code/direct/*-no-strict.js`.

Acceptance: tier 5 enabled by `--allow-sloppy-eval` flag; tests
pass when flag is set.

### Dependencies

- **#1261** — tiering.
- **#1264** — strict eval; lands first.
- **#1102** — wasm-native eval; alternative path for const-string
  cases.

### Risks

- **Performance cliff**: any module using sloppy eval pays the
  full boxing cost. Document clearly. Default flag = off.
