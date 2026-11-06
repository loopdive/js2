---
id: 7284
title: "IR: async-test harness units `$DONE` / `__consolePrintHandle__` (doneprintHandle.js) — measured: blocked on a module-var closure call"
status: blocked
sprint: current
created: 2026-11-06
updated: 2026-11-06
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: investigation
area: ir
goal: ir-full-coverage
related: [7277, 7253, 7251]
depends_on: [7277]
assignee: "ttraenkler/c-lead"
---

# #7284: async-test harness units `$DONE` / `__consolePrintHandle__`

## Problem

`test262/harness/doneprintHandle.js` defines `$DONE(error)` and
`__consolePrintHandle__(msg)`. On main's wrapped stride-40 standalone ledger
both are legacy in 139 of 1296 files (in 35 of them among ≤ 3 remaining legacy
units). Both first refuse at `param-dynamic-carrier-diverges-from-legacy: msg`,
which #7277 (string-slot params projected as IR strings) addresses; this
branch is stacked on #7277's branch.

## Measurement (2026-11-06, base #7277 branch `b6c06be1` on main 8b349439)

Wrapped ledger, stride 40, standalone, `JS2WASM_IR_SHAPE_DIAG=1`,
`--files-json`, with #7277 in: 1296 files, zero-legacy 32.

- **130 files** have `$DONE` and `__consolePrintHandle__` legacy (both, in
  every one of them).
- First refusals, in all 130:
  - `__consolePrintHandle__`: `external-call` (`print(msg)`);
  - `$DONE`: `move-only[concrete]` on
    `'Test262:AsyncTestFailure:' + error.name + ': ' + error.message`.
- **Files where these two are the only legacy units: 0.** In 33 files they are
  among ≤ 3 legacy units; the third is always the test's `<module-init>`
  (`vardecl-module-storage-unrepresentable` 10,
  `vardecl-class-expression-unprepared` 6, `expr-call-callee-nonident` 4,
  `objectlit-empty` 3, other 10). So making both units IR adds **0**
  zero-legacy files on this stride.

### `__consolePrintHandle__`: `print(msg)` needs new machinery

`print` is not a host function or a provider. The js2wasm test262 lane prepends
a plain-JS prelude whose first binding is

```js
var print = function (value) {
  console.log(value);
};
```

so `print(msg)` is a call through a **script `var` bound to a function
expression**. The IR has no seam for that callee:

- the module-binding resolver gives `print` no storage (it is not
  representable: no binding comes back for it at the call site);
- the #7106 function-object registry (`functionObjectValues`,
  `lowerTopLevelFunctionValue`) covers top-level function *declarations*
  only;
- `lowerDynamicValueCall` (#7106 Stage 4) lowers a call through a
  dynamic-carrier *local or slot*, but a module `var` closure has neither;
- a plain script's `<module-init>` refuses the initializer itself
  (`vardecl-let-closure`), measured on a minimal
  `var p = function (v) {…}; function h(m) { p(m); }`.

Legacy compiles it as a module-global closure read and a closure call. An IR
lowering needs a closure-typed module-var storage the selector and from-ast
both resolve, plus the call through it — not a bounded admission.

### `$DONE`: one step, measured with the print step stubbed

With `__consolePrintHandle__`'s body emptied (so the call graph admits it),
`$DONE`'s only refusal is the string concatenation of dynamic member reads:

| body variant | `$DONE` |
| --- | --- |
| as written | `move-only[concrete]` on `'…' + error.name + ': ' + error.message` |
| without that concatenation | IR |
| …and without `'name' in error` | IR |
| …and without `String(error)` | IR |

`if (error)`, `typeof error === 'object' && error !== null`, `'name' in error`
and `String(error)` already lower. The remaining step is `string + <dynamic>`
in a concrete-string position, i.e. ToPrimitive (default hint) then ToString of
the member read. That is not `String(x)` (string hint), so its provider must be
legacy's `+` coercion, not `dyn.to_string`. And `$DONE` stays legacy anyway
while `__consolePrintHandle__` does: it calls it, and the call-graph closure
withdraws a caller of a legacy callee.

## Follow-ups (in order)

1. Closure-typed module `var` storage + a call through it (unblocks
   `print(msg)`, then `__consolePrintHandle__`). New machinery; its own issue.
2. `string + <dynamic>` in a concrete-string position through legacy's `+`
   coercion (unblocks `$DONE`).
3. The 33 files' `<module-init>` blockers (listed above) — only then does
   this pair move files to zero legacy.
