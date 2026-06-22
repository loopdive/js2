---
id: 2612
title: "async fn consumed as thenable via variable/expression binding not wrapped in Promise (~18 fails)"
status: done
created: 2026-06-22
updated: 2026-06-22
completed: 2026-06-22
priority: high
feasibility: medium
task_type: bug
area: async, codegen
language_feature: async
goal: async-model
sprint: 65
parent: 1042
assignee: ttraenkler/async-2612-2613
note: "Re-measured 2026-06-22 (arch, ASYNC lane). Bounded detection bug, NOT the CPS epic."
---
# #2612 — async fn assigned to a variable/expression, consumed via `.then`, isn't Promise-wrapped

## Problem

The async-call-site Promise wrap (`wrapAsyncReturn`) only fires when the call is
recognised as async by `isAsyncCallExpression` (`src/codegen/expressions.ts`).
For an async function **expression** bound to a variable in the two-step
declare-then-assign shape —

```js
var ref;
ref = async function ref(x, y = x) { /* ... */ };
ref(3).then(() => { /* ... */ }).then($DONE, $DONE);
```

— the call `ref(3)` was not detected as async: `ctx.asyncFunctions` only holds
async **declarations** / class methods / object-literal methods, and the TS
signature / call-signature fallbacks miss `ref` because `var ref;` has no
initializer type that surfaces `Promise<T>` (confirmed: `getCallSignatures()`
and `getApparentType().getCallSignatures()` both return 0 for this shape).
Result: `ref(3)` returns the raw unwrapped value; `.then` on it →
`Cannot read properties of null (reading 'then')`.

## Fix (landed)

`src/codegen/expressions.ts`, `isAsyncCallExpression`:
1. Added `getApparentType(calleeType)` call-signature `Promise<T>` check (in
   addition to `getTypeAtLocation`).
2. Added `symbolBindsAsyncFunction(ctx, sym)` — resolves the identifier callee's
   symbol and returns `true` when a `VariableDeclaration`/`BindingElement`
   initializer **or** a later `name = async function …` assignment to that same
   symbol is an `async` function expression / async arrow (excludes async
   generators via `asteriskToken`). This catches the `var ref; ref = async
   function …` two-step exactly. Existing `Promise.`-receiver short-circuits
   (lines 162-186) left untouched (no double-wrap of native `$Promise`).

## Test Results (re-measured 2026-06-22, JS-host runner)

**10 rows flip fail → pass** (the discrete detection-gap bucket):
- `expressions/async-function/named-dflt-params-ref-prior.js`,
  `nameless-dflt-params-ref-prior.js`
- `expressions/async-function/named-dflt-params-arg-val-undefined.js`,
  `nameless-dflt-params-arg-val-undefined.js`
- `expressions/async-function/forbidden-ext/b2/async-func-expr-{named,nameless}-forbidden-ext-indirect-access-{prop-caller,own-prop-caller-get,own-prop-caller-value}.js` (6 files)

**Out of scope (separate bugs, still fail after this fix):**
- `*-params-trailing-comma-*` (4) — fail on a function-`.length` reflection bug
  (`ref.length` returns 0 for a trailing-comma anon fn-expr bound to a var), NOT
  detection. Detection now works (the `.then` chain runs); the residual is the
  `.length` own-property.
- `*-dflt-params-arg-val-not-undefined` (2) — pass 6 distinct-typed args
  (`false`/`''`/`NaN`/`0`/`null`/`obj`) through untyped async-fn-expr params;
  value-representation issue, not detection.

No regressions: 20 currently-passing async-function decl/expr tests + 47
Promise/async-arrow tests stay green; tsc + prettier clean.

## Validation
- `tsc --noEmit` ✓, `prettier --check` ✓
- Scoped `runTest262File` on the 10 flips + decl-path + Promise regression sweep
