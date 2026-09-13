---
id: 6436
title: "A plain `f(x)` call inside a host-dispatched closure inherits the AMBIENT `this` instead of `undefined`"
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

A plain (non-method, non-`.call`) invocation of a named function reads whatever
`__current_this` happens to hold, instead of the `undefined` a plain call is
specified to install (§10.2.1.2 — `thisArgument` is `undefined` for an ordinary
`[[Call]]`, and a module body is strict, so there is no global-object
substitution).

```js
function withArguments(a, b) { return (this ? this.t : 'NO-THIS') + '|' + arguments.length; }
const tests = [];
function register(name, body) { tests.push({ name, body }); }
register('x', () => withArguments(1));
export function run() { return tests[0].body({}); }   // native  NO-THIS|1
                                                      // wasm    undefined|1
```

`tests[0].body(...)` is a METHOD call, so `emitClosureMethodCallExportN`
(`src/codegen/closure-exports.ts`) installs the receiver in the `__current_this`
module global for the duration of the arrow's body. The arrow correctly
inherits that `this` lexically — but the *plain* call it makes to
`withArguments` should not. `withArguments` has no `this` binding in scope, so
`ThisKeyword` resolution falls back to `__current_this` and picks up the
dispatcher's receiver. The wrong answer is silent: `this` is a truthy object,
so `this ? … : 'NO-THIS'` takes the wrong branch and reads `undefined` off it.

Measured 2026-09-12 on `upstream/main` `e8a778638f`, probe via `compileProject`
on a two-file untyped `.js` project. It reads identically before and after
[#6416](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6416-arguments-length-under-applied-call)
— that fix repaired the `arguments.length` half of the same expression
(`|2` → `|1`) and left the receiver half untouched, which is how this was
isolated.

## Where to look

- `ensureCurrentThisGlobal` / the `__current_this` fallback in `ThisKeyword`
  resolution (`src/codegen/statements/nested-declarations.ts`).
- `emitClosureMethodCallExportN` (`src/codegen/closure-exports.ts` ~L1265)
  already save/restores `__current_this` around its `call_ref`; the gap is that
  nothing clears it for a plain call made *inside* that window.
- The #3796 named-`this` trampoline is the model for the correct shape: a call
  that knows its receiver installs one. A plain call knows its receiver is
  `undefined` and should install that, rather than leaving the global alone.

The cost question is whether every plain call to an `arguments`/`this`-reading
named function has to null the global (two globals' worth of stores on a hot
path), or whether the callee can be told at compile time that it has no `this`
binding — most plain call targets are statically known.

## Acceptance criteria

1. The repro above answers `NO-THIS|1`.
2. `.call`/`.apply`/`.bind` receivers are unchanged (#5341's suite stays green).
3. A method call's own `this` is unchanged, including nested method calls.
4. Regression test with untyped `.js` two-file fixtures, failing on the parent
   and passing with the fix, plus an anti-vacuity control.
5. A/B over the 17 dogfood suites — no regression.
