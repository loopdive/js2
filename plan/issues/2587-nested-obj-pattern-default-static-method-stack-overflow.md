---
id: 2587
title: "compiler stack-overflow on nested object-pattern-with-default destructuring param in a (static) class method"
status: done
sprint: 65
created: 2026-06-21
completed: 2026-06-22
assignee: ttraenkler/dev-acorn
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: destructuring, classes
related: [2040, 2545, 2568]
origin: "2026-06-21 sd-3 — found while diagnosing #2040 cluster A. Confirmed PRE-EXISTING on clean origin/main (NOT caused by the #2040 equality work). Likely the source of several of the 13 wasm_compile entries in the #2040 floor run."
---

# #2587 — stack-overflow compiling a nested obj-pattern-default destructuring param in a class method

## Problem

A class method whose parameter is a **nested object binding pattern with a
default initializer** crashes the COMPILER with infinite recursion:

```ts
class C {
  static method({ w: { x, y, z } = { x: 4, y: 5, z: 6 } }: any): number {
    return x as number;
  }
}
```

Compiling this (any target) fails with:

```
Internal error compiling expression: Maximum call stack size exceeded
```

Confirmed on **clean `origin/main`** (not introduced by the #2040 equality work).
The shape is exactly the test262 `class/dstr/*obj-ptrn*-init*` family
(`meth-static-obj-ptrn-prop-obj.js`, `gen-meth-static-dflt-obj-ptrn-*`, …), so
this is very likely the source of several of the **13 `wasm_compile`** regressions
that appeared in the #2040 merge_group floor run (those files compile_error
rather than run).

## Suspected site

The nested-pattern-with-initializer arm of the parameter-destructuring lowering:
`src/codegen/destructuring-params.ts:~523-534` — the `__ext_dparam_nested_*`
recursion (`destructureParamObjectExternref` / `destructureParamArray` recursing
into the nested pattern) combined with the `element.initializer` default-eval

- `ctx.liveBodies` body-swap window. The recursion does not bottom out for a
  nested object pattern that itself carries a default object literal whose fields
  are again bindings — the default-eval re-enters the same nested-pattern compile.

## Suggested approach

1. Build the minimal repro above and bisect which recursion (the nested-pattern
   descent, the default-initializer compile, or the `liveBodies`/body-swap
   re-entry) fails to terminate.
2. Add a visited-set / depth guard, or restructure so the default-initializer is
   compiled ONCE into a temp and the nested pattern destructures the temp (not
   re-entering the param-pattern compile).
3. Verify the `class/dstr/*obj-ptrn*-init*` test262 cluster compiles
   (no `compile_error`), and that `meth-static-obj-ptrn-prop-obj.js` runs.

## Acceptance criteria

- `static method({ w: { x, y, z } = {...} })` compiles (no stack-overflow), host
  and standalone.
- The `class/dstr/*obj-ptrn*-{prop,elem}-*-init*` cluster no longer
  `compile_error`s.
- No regression in the existing destructuring suites.

## Resolution (2026-06-22, dev-acorn)

**Already fixed on `origin/main`** (HEAD `45ae22b3301`). The stack overflow no
longer reproduces — neither the minimal `static method({ w: { x, y, z } = {...} })`
case nor the full double-default test262 shape
(`{ w: { x, y, z } = { x:4, y:5, z:6 } } = { w: { x:10, z:7 } }`) throws.

The issue was filed 2026-06-21 on then-clean main; the nested
destructuring-param-default work that landed during sprint 65 resolved it,
specifically:

- **#2158** (`da9a26cdd05`) — "dstr-param default with nested sub-pattern emits
  valid Wasm"
- **#2568** (`2f24ab71b2e`) — "two-level nested destructuring-param default
  reads 0 — struct-shape match"
- **#2545** — nested destructuring-param default outer-pattern eval

The nested-pattern descent in `destructureParamObjectExternref`
(`src/codegen/destructuring-params.ts`) now bottoms out correctly through the
default-initializer compile + body-swap window.

### Test Results

All six representative test262 files — including
`meth-static-dflt-obj-ptrn-prop-obj.js` whose body the issue quotes, plus the
`gen-meth-static-*` and `async-gen-meth-static-*` variants — **compile cleanly**
(no `compile_error`):

| file                                           | result   |
| ---------------------------------------------- | -------- |
| `meth-static-dflt-obj-ptrn-prop-obj`           | COMPILED |
| `meth-static-obj-ptrn-prop-obj`                | COMPILED |
| `gen-meth-static-dflt-obj-ptrn-prop-obj`       | COMPILED |
| `gen-meth-static-obj-ptrn-prop-obj`            | COMPILED |
| `async-gen-meth-static-dflt-obj-ptrn-prop-obj` | COMPILED |
| `meth-static-dflt-obj-ptrn-prop-obj-init`      | COMPILED |

Runtime semantics verified (host): outer default applied → `997`; inner default
on `{ w: undefined }` → `456`; explicit values → `123`. Standalone
(`nativeStrings`) compiles clean.

Regression-locked by `tests/issue-2587-nested-objpat-default-static-method.test.ts`
(3 cases: host-compile, standalone-compile, runtime semantics).
