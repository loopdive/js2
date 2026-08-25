---
id: 3959
title: "`Error(msg)` without `new` compiles to `ref.null.extern` — every React production error path traps"
status: done
sprint: 78
created: 2026-08-01
updated: 2026-08-18
completed: 2026-08-01
priority: high
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: bug
area: compiler
language_feature: errors
goal: core-semantics
# The new dispatch arm is 9 lines in compileCallExpression's guard ladder — the
# only place a call-expression guard can live. The emitter itself went into
# new-builtin-globals.ts (the subsystem module), not the driver.
loc-budget-allow:
  - src/codegen/expressions/calls.ts
func-budget-allow:
  - src/codegen/expressions/calls.ts::compileCallExpression
---

# `Error(msg)` without `new` compiles to null

## Problem

ECMA-262 §20.5.1.1 defines the Error constructor's [[Call]] and [[Construct]]
behaviour in the same clause: "When `Error` is called as a function rather than
as a constructor, it creates and initializes a new Error object." The same holds
for every NativeError (§20.5.6.1.1) and for `AggregateError`.

`new Error(msg)` was handled (`tryCompileBuiltinGlobalNew`). The bare-call form
matched **no arm at all** and fell through to the generic builtin path, which
emits `ref.null.extern`. There was no diagnostic — the call silently produced
`null`, and the next `.message` read null-trapped with an opaque
`WebAssembly.Exception` carrying no message.

Minimal repro:

```js
export function h() {
  const e = Error("boom");
  return "" + e.message;
}
```

emitted, for the whole of `Error("boom")`:

```wat
ref.null extern
local.set 0        ;; e = null
...
ref.is_null
(if (then global.get 3  throw 0))   ;; opaque trap on e.message
```

`TypeError("t")`, `throw Error("bang")` — same.

## Why it matters beyond the repro

This is not a stylistic corner. **React's production bundle raises every one of
its errors this way**, via `Error(formatProdErrorMessage(...))`. Compiled React
therefore threw an opaque Wasm exception instead of the real error for
`Children.only`, `cloneElement(null)`, and every other guarded path — five
upstream React tests failed on it (#3958). Minifiers also prefer the
`new`-less form generally, so any minified dependency is exposed.

## Fix

`tryCompileErrorCtorCallWithoutNew` (`src/codegen/expressions/new-builtin-globals.ts`),
dispatched from `compileCallExpression` alongside the other early guards.
Because the spec defines [[Call]] and [[Construct]] identically here, it
delegates to the _same_ emitter rather than duplicating it — a CallExpression
and a NewExpression expose the same `.expression`/`.arguments` shape that
emitter reads. A shadowed binding (`class Error {}`, a local, an import) is left
alone: `ctx.classSet` plus `resolvesToAmbientGlobal` gate it to the ambient
global, matching the guard `new-super.ts` already applies.

This follows the existing `tryRegExpConstructorCall` precedent, which solves the
identical "callable constructor invoked without `new`" problem for `RegExp`.

## Acceptance criteria

- [x] `Error(m)`, `TypeError(m)`, `RangeError(m)`, `SyntaxError(m)`,
      `URIError(m)`, `EvalError(m)`, `ReferenceError(m)` produce a real Error
      with the correct `.message` and `.name`.
- [x] `throw Error(m)` is catchable with an intact `.message`.
- [x] A user-shadowed `Error` binding keeps its own behaviour.

## Permanent test reference

`tests/dogfood/react-upstream-suite.test.ts` — React's own
`ReactElementClone › throws an error if passed null` / `throws an error if
passed undefined` and the three `onlyChild › should fail when …` tests exercise
this path end-to-end through the real React production bundle. They fail
without the fix and pass with it (part of the 32 → 39 move recorded in #3958).
