---
id: 5284
title: "npm upstream suites: namespace imports and curried calls answered `undefined` instead of running"
status: done
sprint: current
created: 2026-09-03
updated: 2026-09-03
completed: 2026-09-03
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
loc-budget-allow:
  - src/compiler.ts
---

## Problem

Running every `tests/dogfood/*-upstream-suite.mjs` locally against this branch
surfaced two defects that **compile clean and only fail at run time**. Both are
instances of the same family the graceful `ref.null.extern` fallback creates:
an unrecognised shape is rendered as the VALUE `undefined`, with the callee
never invoked.

### 1. `import * as ns` had no binding on the multi-file paths

`generateMultiModule`'s import-alias pass skips namespace imports on purpose —
"resolves to a module object, not a single function/global binding". Nothing
else bound them, so `ns` reached codegen unbound and every `ns.member(...)`
lowered to `__extern_method_call` on a `ref.null extern` receiver:

```
Cannot read properties of null (reading 'parseCookie')
```

`preprocessImports` handles the shape, but only on the **single-source**
`compile()` route; `compileMulti` / `compileProject` never call it. A named
import of the very same module links correctly.

Reproduced in six lines:

```ts
// mod.js
export function f(s) { return s.length; }
// entry.ts
import * as m from "./mod.js";
export function test(): number { return m.f("abc"); }   // → null deref
```

### 2. `f(a)(b)` dropped the outer call

The signature-directed dispatcher in `call-tail-dispatch.ts` engages only when
the callee expression's TS type carries a call signature. An `any`-typed callee
— every untyped `.js` dependency, anything behind an `as any` — has none, so
the shape fell through to `compileCallDispatchTail`'s fallback. The **inner**
call ran, its closure was built, and then the closure and every outer argument
were dropped:

```wat
(func $test (result f64)
  f64.const 1
  call 1          ;; h(1) runs
  ...
  struct.new 8
  extern.convert_any
  drop            ;; the closure is thrown away
  f64.const 2
  drop            ;; …and so is the argument
  ref.null extern ;; answer: undefined
  return)
```

## Fix

- `src/multi-namespace-import.ts` (new) rewrites the namespace form into the
  named form for specifiers that resolve **inside the compiled graph**;
  `node:*` and other host modules are untouched (that is #4422's work, and a
  named import there would only move the failure). Every in-place edit is the
  same byte length as the text it replaces (`ns.member` → `ns$member` plus
  padding; the import statement → a same-length block comment) and the
  generated named imports are appended after EOF, so no pre-existing source
  offset moves — the discipline `foldGroundCallsInMulti` already keeps. It
  declines when the namespace name is shadowed anywhere in the file, when the
  namespace is used as a value, or when a member is not in the target's
  export set.
- `compileCallDispatchTail` routes a **call-expression callee** through
  `tryEmitInlineDynamicCall`, the runtime ladder identifier and element-access
  callees already use. No new dispatch vocabulary.

## Measured

Local upstream suites, before → after:

| package | before | after |
| ------- | ------ | ----- |
| cookie  | 65/63740 | 77/63740 |
| axios   | 21/231 | 23/231 |
| redux   | 13/82 | 13/82 |

Redux nets zero: the namespace fix makes `applyMiddleware.spec.ts` reach a
pre-existing `RuntimeError: illegal cast` in `dispatch` (−1), and the curried
fix recovers the row (+1). Sixteen other packages are unchanged. The 18 test
files that fail on this branch fail **identically** with and without the change
(51 failing cases either way): missing `test262` / `test262-fyi` submodules,
plus exactness pins that were already red.

## Why the corpus barely moved — the real blocker (follow-up)

`__module_init` runs from the Wasm **`start` section**, i.e. INSIDE
`WebAssembly.instantiate`, before the host wires the struct getters
(`__setExports`). So a closure read out of an object property during module
init comes back non-callable, with byte-identical lowering to the working
in-function case:

```ts
const o: any = {};
o.p = function () { return 7; };
const t = typeof o.p;             // module init → "object"
export function test() { return o.p(); }   // at runtime → 7
```

Every upstream test file registers its cases in module init, so
`it.each(rows)(name, body)` registers **zero** tests: 63,491 of cookie's
63,740 rows never run and are scored as silent failures with no error text
(the runner iterates the Wasm-side `upstreamTestCount()` and reads
`statuses[index]` as `undefined` for every row that was never registered).

The mechanism to fix this already exists for the **read** path: #2800's
`__in_module_init` flag plus the host-free `__get_member_<name>` dispatcher,
in `tryEmitDeleteAwareDynamicGet`. That arm explicitly declines for
function-typed members ("must keep its closure/funcref lowering"), which is
exactly this case. Extending the same flag-gated, host-free read to the
any-receiver **method-call** path is the next slice, and is worth more than
every other npm-compat item combined.

## Acceptance criteria

- [x] `import * as ns` from an in-graph module binds and calls on
      `compileProject` / `compileMulti`.
- [x] An out-of-graph specifier (`node:os`) is left byte-identical.
- [x] A namespace name shadowed by a local binding is left alone.
- [x] `f(a)(b)` invokes the returned closure for `any`-typed callees.
- [x] Regression tests: `tests/multi-namespace-import.test.ts`,
      `tests/curried-call-dispatch.test.ts`.
