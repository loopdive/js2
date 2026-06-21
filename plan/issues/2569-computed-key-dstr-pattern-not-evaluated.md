---
id: 2569
title: "Computed property key in a destructuring pattern is not evaluated (no side effect / throw)"
status: done
completed: 2026-06-21
assignee: ttraenkler/sd-6
created: 2026-06-21
priority: medium
feasibility: medium
goal: test262-conformance
sprint: Backlog
parent: 820
test262_fail: 4
---
# #2569 — Computed property key in a destructuring pattern is not evaluated

## Problem

A destructuring pattern whose property name is a *computed key*
(`{ [expr()]: x }`) must **evaluate `expr()`** as part of the destructuring
operation (ES2024 13.15.5.3 / 8.6.2 `PropertyDefinitionEvaluation` →
`Evaluation of ComputedPropertyName`). If `expr()` throws, the destructuring
throws; the side effect must happen exactly once, in source order.

The compiler currently does **not** evaluate the computed key in a binding /
assignment destructuring pattern. So:

```js
function thrower() { throw new Test262Error(); }
class C { async *method({ [thrower()]: x } = {}) {} }
var method = C.prototype.method;
assert.throws(Test262Error, function() { method(); });
// expected: Test262Error (thrower() runs during destructuring)
// actual:   no throw — method() returns the async generator normally
```

The `[thrower()]` key is never emitted, so the poison never fires.

### test262 coverage (~4 official fails, after #820/#1543 dynamic-dispatch fix)

All `…-dflt-obj-ptrn-prop-eval-err.js` under
`language/{statements,expressions}/class/dstr/`:

- `async-gen-meth-dflt-obj-ptrn-prop-eval-err.js`
- `async-gen-meth-static-dflt-obj-ptrn-prop-eval-err.js`

(The sync `meth-`, `gen-meth-`, `async-meth-` `prop-eval-err` siblings may
share the gap; re-bucket once this lands. The async-gen variants surfaced
only after the dynamic-dispatch illegal-cast fix unmasked them — previously
they trapped before reaching the key.)

## Root cause

The object-binding-pattern destructure path resolves each property by its
*static* name (`element.propertyName` text) and never compiles a
`ts.ComputedPropertyName` expression for its side effect / ordering. The
fix belongs in the object-pattern destructure emitter — evaluate the computed
key first (for its side effect and to derive the property key), then read the
field under the resulting key.

### Where to look

- `src/codegen/destructuring-params.ts` — object-pattern param destructure
  (`destructureParamObject` / `destructureParamObjectExternref`); the
  per-element loop reads `element.propertyName` but does not handle
  `ts.isComputedPropertyName(element.propertyName)`.
- `src/codegen/destructuring.ts` — the statement/assignment destructure path
  (same gap likely applies to `let { [k()]: x } = obj`).

## Acceptance criteria

- `{ [expr()]: x }` evaluates `expr()` exactly once, in source order, during
  destructuring; a throwing key propagates.
- The 4 `…-prop-eval-err` async-gen fails flip to pass; no regressions.

## Notes

Carved from #820 by sd-4 on 2026-06-21 while fixing the
`async-gen-meth-dflt-*` illegal-cast cluster (96/100 of that cluster fixed
via the dynamic-call-dispatch funcref-signature fix; these 4 computed-key
residuals are a distinct, orthogonal defect).
