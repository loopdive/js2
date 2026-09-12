---
id: 6416
title: "`arguments.length` inside an under-applied `.call`/`.apply` target reports the FORMAL count, not the supplied one"
status: ready
sprint: current
created: 2026-09-12
updated: 2026-09-12
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
---

## Problem

A named function invoked reflectively with fewer arguments than it declares
sees `arguments.length` equal to its FORMAL count, not the count the call site
actually supplied.

```js
function f(a, b) { return arguments.length; }
f.call({}, 1);   // native 1 · wasm 2
```

Found while fixing [#5341](https://js2wasm.loopdive.com/dashboard/issue.html?slug=5341-axios-residual-buckets)
(the under-applied `.call` receiver drop). It is a **separate, pre-existing**
mechanism: it reads identically before and after that fix, and it is
independent of the receiver — the receiver is now correct while
`arguments.length` is still wrong.

Measured 2026-09-12 on `upstream/main` `cf82f78d6d`, probe via
`compileAndRunUpstreamModule`, two-file untyped `.js` fixture:

| call                                 | native  | wasm (before #5341) | wasm (after #5341) |
| ------------------------------------ | ------- | ------------------- | ------------------ |
| `withArguments.call({t:'T'}, 1)`     | `T\|1`  | `NO-THIS\|2`        | `T\|2`             |

with `function withArguments(a, b) { return (this ? this.t : 'NO-THIS') + '|' + arguments.length; }`.

## Where to look

`maybeSetArgcForKnownCall` (`src/codegen/statements/nested-declarations.ts`
~L3760) does push `i32.const min(actualArgCount, paramCount)` into the
`__argc` global at the `.call` site — so the value written appears to be
right (1). The reader side is what to check: whatever computes
`arguments.length` for a plain named FunctionDeclaration is falling back to
the formal count rather than honouring the global. Candidates: the argc
global is reset to `-1` before the callee reads it, or the `arguments`
materialisation for a non-closure target never consults it.

Note that the `.call` path now goes through the `#3796` named-`this`
trampoline for these arities. The trampoline does not touch `__argc` — it
only saves/installs/restores `__current_this` — so it is not the cause, but
confirm that on the emitted WAT rather than assuming it.

## Acceptance criteria

1. `f.call(t, 1)` into `function f(a, b)` answers `arguments.length === 1`,
   and `arguments[1] === undefined`.
2. The same for `.apply(t, [1])` and for an immediately-invoked
   `f.bind(t)(1)`.
3. Over-application is unchanged (the extras-argv ABI already carries it).
4. Regression test with untyped `.js` two-file fixtures, failing on the
   parent and passing with the fix, plus an anti-vacuity control.
5. A/B over the 17 dogfood suites — no regression.
