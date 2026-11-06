---
id: 7261
title: "IR: a dynamic method call `o.f()` on an object-literal method traps in an IR body"
status: ready
sprint: current
created: 2026-11-06
updated: 2026-11-06
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: ir
goal: ir-full-coverage
related: [7258, 7260, 2949, 7106, 7119]
---

# IR: a dynamic method call `o.f()` on an object-literal method traps in an IR body

## Problem

Calling a function stored on an object literal through a dynamic receiver
traps in an IR-emitted body, where the legacy body returns the right value.
Found by the fresh-context review of PR #7104
([#7258](7258-ir-move-only-dynamic-truthiness-return.md), comment
6675312601): rule (c) newly routed such bodies into the IR.

## Minimal repro (on main, no #7258 needed)

```js
function g3(o) { if (o.f()) return true; return false; }
function mk(k) { return { f: function () { return k; } }; }
export function t(k) { return g3(mk(k)) ? 1 : 0; }
```

Measured 2026-11-06 on main `92305e40`, `fileName: "p.mjs"`, `allowJs`:

| target | `g3` route | `t(0)`, `t(1)`, `t(2)`, `t("s")` | legacy / JS |
| --- | --- | --- | --- |
| gc | IR | `WebAssembly.Exception` ×4 | `0, 1, 1, 1` |
| standalone | IR | `WebAssembly.Exception` ×4 | `0, 1, 1, 1` |
| wasi | IR | `WebAssembly.Exception` ×4 | `0, 1, 1, 1` |

These variants trap the same way on main:
- `return o.f();` and `var r = o.f(); return r;` (dynamic result);
- `var ws; ws = !!o.f(); if (ws) return true; return false;`;
- `var ws; if (o.k) { return ws; } ws = !!o.f(); return ws;` (traps at `t(0)`);
- the receiver built as a local literal in the CALLER and passed in:
  `export function t(k) { var o = { f: function () { return k; } }; return g3(o) ? 1 : 0; }`.

Two related observations:
- A literal called in the SAME function, as in
  `function g6(k) { var o = { f: function () { return k; } }; return o.f() ? true : false; }`,
  stays on the old compiler and returns the right values. It does not
  reproduce (#7104 delta review).
- `o["f"]()` on the same receiver throws on the OLD compiler too, IR or not
  (base and head alike, review row `a13`). That is a separate legacy failure,
  not this IR bug.

A plain member read (`if (o.g) …`) on the same receiver is correct.

## Where the lowering lives

- `lowerMethodCall` (`src/ir/from-ast.ts`), dynamic-receiver arm. With no
  brand-dispatch wrapper, `recv.f()` lowers to a call of
  `__ir_dyn_method_call_0` / `__ir_dyn_method_call_1`
  (`IR_DYN_METHOD_CALL_0_FN` / `_1_FN`, `src/codegen/dyn-ops.ts`) with
  `[recv, boxed "f", ...args]`.
- The selector admits it in `dynamicUsesAreMoveOnly` → `scanExprInner`, in
  the `isDynShaped(e.expression.expression)` method-call arm
  (`dynamicMethodCallIsAdmitted`).
- Not yet isolated: whether the trap is in `__ir_dyn_method_call_0`'s
  `[[Get]]`, or in its call of the closure value legacy stores for an
  object-literal function (most likely, since the member read is fine).

## Mitigation in place

#7258 withdraws its own new admission (bool return of a `var x;` carrier)
from any body that makes a dynamic method call, so #7258 adds no new trap.
The bodies that main already claims, listed above, still trap.

## Acceptance criteria

- No trap where legacy does not: every variant above returns legacy's values
  on gc, standalone and wasi, IR-claimed or not.
- Typed corpus byte-identical.
- Afterwards, #7258's `callsDynamicMethod` withdrawal can be removed.
