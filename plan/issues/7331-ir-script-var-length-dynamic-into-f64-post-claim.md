---
id: 7331
title: "IR: `.length` of a dynamic script var (`print.length`) is claimed, then withdrawn (dynamic result into a declared f64 return)"
status: ready
sprint: Backlog
created: 2026-11-07
updated: 2026-11-07
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: ir
goal: ir-full-coverage
related: [7287, 7330, 7332]
---

# #7331: `return p.length` on a dynamic script var withdraws the function

## Problem

`function h() { return p.length; }` over a script var in its dynamic module
home is claimed. The read lowers to the dynamic carrier, but the function's
declared result is `f64` (the checker types `length` as `number`), so from-ast
withdraws the unit after the claim (`irPostClaimErrors`). The output is still
correct (legacy fallback), but this breaks the claim-then-withdraw rule (the
"#7147 standard" in the #7164 review).

## Repro (bare compile; standalone, wasi and gc alike)

Pre-existing on main `b631a4bc`:

```js
var p = function (a, b) {}; function h() { return p.length; } h();
```

`h`: `return[0] type dynamic not assignable to declared result f64`.

Exposed by #7164 (head `c0dcb01a`), whose slice A binds a lib-named script var
(`print`, `isNaN`) to its `var` (main gives `[]`):

```js
var print = function (a, b) {}; function h() { return print.length; } h();
var isNaN = function (a, b) {}; function h() { return isNaN.length; } h();
```

## Direction

Either the return converts the carrier with ToNumber for a declared `f64`
result (the conversion legacy applies), or the selector refuses a dynamic
`.length` read into a typed return. Pin a bare compile of the three repros
with `irPostClaimErrors` empty.
