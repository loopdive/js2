---
id: 5324
title: "A lifted arrow/function-expression frame never pops the function names it hoists"
status: done
sprint: current
created: 2026-09-05
updated: 2026-09-05
completed: 2026-09-05
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
# 2026-09-05 — +3 lines in src/codegen/closures.ts and +2 in
# compileLiftedClosureBody, and they cannot go anywhere else: the scope has to
# OPEN before that function hoists its declarations and CLOSE beside its other
# frame unwinds, so the two call sites belong to this function by construction.
# Everything that could be moved out already was — the rationale, the pairing
# contract and the wrappers live in the new subsystem module
# src/codegen/closures/lifted-frame-name-scope.ts, which cut the first
# implementation's +17/+13 to +3/+2. What remains is one import line and the two
# call sites.
loc-budget-allow:
  - src/codegen/closures.ts
func-budget-allow:
  - src/codegen/closures.ts::compileLiftedClosureBody
---

## Problem

A `function f` declared inside an arrow or function-expression body permanently
stole the module-level name `f`. Two symptoms, both measured:

1. **Wrong call target.** After the arrow frame closes, an outer `f(...)` call
   resolves to the frame's private function.

   ```js
   let seen = "";
   function pick(a, b) { seen = "outer:" + a + "," + b; return 0; }
   const frame = () => { function pick(x) { seen = "inner:" + x; return 1; } return pick(9); };
   frame();     // 1, seen = "inner:9"   — correct
   pick(1, 2);  // Wasm: 1, seen = "inner:1"   native: 0, seen = "outer:1,2"
   ```

2. **Whole-module compile failure, multi-source graphs only.**

   ```
   Codegen error: stack-balance invariant (entry): 'test' references local 1,
   but only 1 params + 0 locals are declared
   ```

   This is what took redux's `applyMiddleware.spec.ts` to **0/5** — a compile
   failure, so all-or-nothing. It also has no per-test `wasmError`: for a whole-
   module failure the message is only in
   `report.compile.details[0].errors[0]`, so first-error-line grouping files
   these under "(no wasmError)".

The shim the upstream harness generates declares `function test(name, body)` at
top level, and two of the spec's `it()` bodies declare `function test(spyOnMethods)`.
Any package whose tests declare a local helper named `test`/`it`/`describe`
inside a test body hits the same shape.

## Root cause

`nestedFuncDeclNeedsShadow` / `shadowNestedFuncName` (#4456) deliberately shadow
an outer same-named registration when a frame hoists its own `function f`, so
the nested declaration gets its own slot instead of aliasing the outer's. The
shadow is popped by `endNestedFunctionNameScope`.

**Only the FunctionDeclaration body-compile paths opened a matching scope** —
`src/codegen/function-body.ts:727` and `:821`, plus
`compileNestedFunctionDeclaration` and the class-constructor path. A LIFTED
frame does not: `compileArrowFunction` → `compileArrowAsClosure` →
`compileLiftedClosureBody` → `prepareLiftedFrameDeclarations` →
`hoistFunctionDeclarations` takes the shadow at
`src/codegen/statements/nested-declarations.ts:3137` and nothing ever pops it.
`ctx.funcMap` and `ctx.funcMapOwnerDecl` stay bound to that frame's private
function for the rest of the compile.

Traced directly (temporary instrumentation, since removed):

```
[PRB] compileDeclarations sf=__empty.mjs mode=discover funcByName(test)=0 funcMap(test)=2097152 dups=[]
[PRB] SHADOW push name=test depth=0
    at hoistFunctionDeclarations (statements/nested-declarations.ts:3137)
    at prepareLiftedFrameDeclarations (closures/lifted-declaration-hoisting.ts:22)
    at compileLiftedClosureBody (closures.ts:3037)
    at compileArrowAsClosure (closures.ts:3620)
[PRB] compileDeclarations sf=entry.ts   mode=full     funcByName(test)=2 funcMap(test)=2097154 dups=[["test",[0,2]]]
[PRB] compileFunctionBody func=test typeIdx=5 typeParams=1 declParams=2 bodyLenBefore=2
```

The last line is the crash in one line: the OUTER declaration (`declParams=2`)
is being compiled into a WasmFunction whose type has **one** param, and which
already holds the nested function's body.

### Why the compile failure needs ≥2 sources

`compileDeclarations` resolves a top-level function's slot through `funcByName`,
which is name-keyed on **both** of its channels — the `ctx.mod.functions` scan is
last-wins by `fn.name`, and the #4133 override reads `ctx.funcMap`. In a
single-source graph the entry's own top-level bodies are compiled before
`__module_init`, so the hijack happens after the outer body is already emitted
and only symptom 1 shows. The multi-source driver
(`src/codegen/index.ts` bodies phase) compiles the accumulated `__module_init`
during the **first** source's pass — before the entry's own top-level bodies —
so by then the hijack is live and the outer body is emitted into the nested
function. With matching arities that is silent; with differing arities the
emitted `local.get <n>` exceeds the nested signature and `stack-balance.ts:278`
reports it.

The imported module's contents are irrelevant — `export const k = 1` triggers it
exactly as redux does. What matters is only that there are two sources.

## Fix

New subsystem module `src/codegen/closures/lifted-frame-name-scope.ts` carrying
the rationale and the two wrappers, plus three lines in
`src/codegen/closures.ts`: `openLiftedFrameNameScope` immediately before
`prepareLiftedFrameDeclarations`, and `closeLiftedFrameNameScope` beside the
frame's existing unwinds (`funcStack` / `parentBodiesStack` / `currentFunc`) at
the single `return`. That is the same contract `compileFunctionBody` already
honours; the lifted lane was simply missing it.

`compileLiftedClosureBody` has no early returns between those two points, so the
pairing is total.

No capture/closure-box logic is touched. The scope is a no-op for a frame that
shadows nothing — `nestedFuncDeclNeedsShadow` only fires on a genuine collision
with a live registration, so the blast radius is exactly "a lifted frame declares
`function f` while an outer `f` exists".

An alternative — resolving the top-level body's slot by declaration identity
(`sourceFunctionHandleForDeclaration`) in `declarations.ts` — was implemented and
**measured, then dropped**: it fixes the compile crash but leaves symptom 1
intact (the functional probe went from COMPILE-FAIL to `pick(1,2) === 1`, i.e. a
different wrong answer). The name-scope fix alone makes all three functional
cases pass, so one root-cause fix beats two partial ones.

## Measurements

redux upstream suite, at `upstream/main` 64f6913141:

| | before | after |
| --- | --- | --- |
| redux total | 60/82 | **63/82** |
| `applyMiddleware.spec.ts` | 0/5 | 3/5 |

Regression test `tests/issue-5324-lifted-frame-fn-name-scope.test.ts` — 3 cases,
untyped `.js` fixtures in two-file projects (annotating the parameters routes the
call sites through a statically-typed arm that never consults the name-keyed
`funcMap`, and the test then passes with and without the fix):

| | before | after |
| --- | --- | --- |
| test file | 0/3 (one of them the `stack-balance invariant (entry)` error verbatim) | 3/3 |

## Cross-package A/B

17 npm upstream suites, both runs at the SAME head (`upstream/main` 64f6913141),
one suite at a time, compared per test FILE as well as per package. `hono` and
`uuid` never print an `admitted` headline, so they are scored per file
(37/52 and 75/75 respectively). Every suite exited 0 in both runs.

| package | before | after |
| --- | --- | --- |
| axios | 191/231 | 191/231 |
| clsx | 32/32 | 32/32 |
| cookie | 63740/63740 | 63740/63740 |
| hono (per file) | 37/52 | 37/52 |
| jest | 299/356 | 299/356 |
| jsdom | 6/6 | 6/6 |
| lodash | 53/62 | 53/62 |
| marked | 2/30 | 2/30 |
| moment | 4/10 | 4/10 |
| prettier | 51/151 | 51/151 |
| **redux** | **60/82** | **64/82** |
| styled-components | 9/9 | 9/9 |
| stylelint | 108/108 | 108/108 |
| tailwindcss | 13/13 | 13/13 |
| three | 17/18 | 17/18 |
| uuid (per file) | 75/75 | 75/75 |
| webpack | 16/16 | 16/16 |

**No package moved except redux, and no individual test FILE moved except
redux's two.** The "after" column is both fixes applied; the split is
`applyMiddleware.spec.ts` 0/5 → 3/5 from #5324 and `createStore.spec.ts`
33/42 → 34/42 from #5325, each confirmed by its own single-fix redux run
(#5324 alone: 63/82; #5325 alone: 61/82).

## Residual

The two remaining `applyMiddleware.spec.ts` failures are unrelated to this issue
(they fail for their own reasons once the module compiles at all).
