---
id: 6886
title: "f(...arr, x) / f(...shortArr) into a fixed-arity compiled function slot the arguments by PARAMETER count, not by the spread's runtime length"
status: ready
sprint: current
created: 2026-10-07
updated: 2026-10-07
priority: medium
horizon: m
feasibility: hard
reasoning_effort: high
task_type: bug
area: codegen
goal: core-semantics
related: [2053, 5093, 6884]
---

## Problem

A spread argument into a compiled, non-rest function is expanded at COMPILE
time into a fixed number of positional slots: `compileSpreadCallArgs`
(`src/codegen/expressions/extern.ts`) gives the spread every remaining
parameter minus the trailing positional arguments (#2053's
`trailingPositionalAfter`). That is only right when the array's runtime length
happens to equal that count.

Measured on upstream/main `75252327a4` (JS-host lane, one module):

```js
function show(v) { return v === undefined ? "U" : v === null ? "N" : String(v); }
function h(a, b, c = "", era = undefined) { return [a, b, c, era].map(show).join(","); }
const e = [1, 2];
h(...e, "x");   // js2wasm "1,2,NaN,x"   node "1,2,x,U"
h(...e);        // js2wasm "1,2,NaN,NaN" node "1,2,,U"
```

The spread reads `e[2]` (out of bounds on an f64 vec → `NaN`, not
`undefined`, so the default does not fire either) and the trailing `"x"` lands
in `era`.

test262 row (unmasked by #6511, previously a vacuous pass):
`built-ins/Temporal/PlainDateTime/prototype/round/roundingmode-halfexpand-is-default.js`
— `TemporalHelpers.assertPlainDateTime(dt.round(…), ...expected, "desc")`
puts `"desc"` into `era` → `Expected SameValue(«null», «undefined»)`. The
reduction above reproduces it without Temporal (`.tmp` probe in the #6884
session).

## Implementation Plan

1. In `compileSpreadCallArgs`'s non-rest arm, keep the static expansion only
   when the spread's length is STATICALLY known
   (`resolveStaticSpreadArgs` in `src/codegen/static-spread-arity.ts` already
   answers this for literals / tuples) or when the spread is the LAST argument
   and fills exactly the remaining formals.
2. Otherwise lower the call through the runtime-length protocol already used
   for `arguments`-reading callees (#2202, `compileSpreadCallArgsWithArguments`
   in `spread-arguments-call.ts`): build the full argument list at runtime
   (`buildSpreadArgList`), then bind formal `i` to `list[i]` when
   `i < list.length` and to the parameter's undefined default otherwise —
   i.e. emit, per formal, `local.get list; i32.const i; vec-len lt; if …
   vec.get … else push-undefined-default`.
3. OOB reads must produce the undefined sentinel (sNaN for f64 so
   `emitDefaultValueCheck` fires; `ref.null`/undefined externref otherwise),
   never a plain `NaN`.
4. Tests: the two calls above, plus `f(...[1], 2, 3)` and
   `f(...a, ...b)` with runtime lengths, each compared with node; standalone
   lane A/B on `language/expressions/call/spread-*` and
   `language/statements/class/*spread*`.

Acceptance: `roundingmode-halfexpand-is-default.js` passes with the CI
Temporal provider; no `spread` test262 row regresses on either lane.
