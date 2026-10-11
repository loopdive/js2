---
id: 6974
title: "standalone: fnctor registries are keyed by identifier text, so `new K` where `var K = <other fnctor>` runs an unrelated same-named `function K` from another IIFE (Octane box2d `SetV` on undefined)"
status: in-progress
assignee: ttraenkler/senior-dev
sprint: current
created: 2026-10-11
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: compiler
language_feature: constructor-functions, new, scoping
goal: standalone-gap
related: [6970, 6969, 6951, 6949, 4241]
loc-budget-allow:
  # 2026-10-11 (#6974) new-super.ts +1: the import of `funcConstructorForCallee`;
  #   the identity check itself lives in fnctor-ctor-decl.ts and replaces four
  #   bare-name `funcConstructorMap` lookups line for line.
  - src/codegen/expressions/new-super.ts
---

# Fnctor registries keyed by name resolve `new <alias>` to the wrong constructor

Found by the #6970 implementer (Session D, 2026-10-11). This is box2d's next standalone blocker
after #6969 and #6970 (PR #6649). Box2d now compiles, instantiates and passes module init, then
`octane_run` throws `TypeError: Cannot read properties of undefined (reading 'SetV')` at
`this.m_xf.position`.

box2d's minifier reuses short names (`K`, `F`, `w`, `m`, …) in every IIFE. So
`this.m_xf = new K`, with `var K = Box2D.Common.Math.b2Transform`, runs `$__fnctor_K_new`: the
synthesized constructor of a **different** `function K` declared in another IIFE.

## Repro (`n19.js`, fails on `main` too)

```js
var NS = {};
(function () { function K() { this.wrong = 1; } NS.k = new K(); })();
(function () { function m() { this.right = 1; } NS.T = m; })();
(function () { var K = NS.T; NS.make = function () { return new K; }; })();
export function main() { var x = NS.make(); return typeof x.right + ":" + typeof x.wrong; }
```

node `number:undefined`, standalone `undefined:number`.

## Cause

`compileNewExpression` (`src/codegen/expressions/new-super.ts`, identifier arm ~L7637) takes
`ctx.funcConstructorMap.get(calleeIdent.text)` before checking that the callee's symbol is that
function. Keying by name runs through the whole fnctor substrate: the `__fnctor_<name>` structs,
`funcConstructorMap`, `nestedFuncCaptures`, and `fnctorPrototypeObject` via
`resolveUserFnctorName` → `sym.name`.

A guard on the cache alone is not enough. A simulation that skipped the cache when the callee had
no function declaration sent `new K` to the native construct driver, which then returned null:
`resolveUserFnctorName` also answers by `sym.name`.

## Plan

1. In the `new <identifier>` arm, resolve `getSymbolAtLocation(calleeIdent)` to its declaration
   (through `ctx.oracle` where possible). Take the static fnctor path only when that declaration
   IS the registered function declaration or expression (compare nodes, not names). Otherwise
   use the native construct driver, which reads the callee's `prototype` at runtime.
2. Make the driver's fnctor-name resolution (`resolveUserFnctorName` and its callers) declaration
   based too, so an alias never selects a same-named struct.
3. Where two fnctors share a name, either give the registries a per-declaration key (for example
   `K$<pos>`, or a `WeakMap<ts.Node, …>`), or show that step 1 + step 2 make every lookup
   declaration-checked. Prefer the smallest change that makes the repro and box2d correct.
4. Related, not on box2d's path (`n10.js`): an IIFE-nested fnctor constructed through an alias
   sees a different `prototype` object than `w.prototype.m = …` writes inside its own IIFE. Fix
   it if it falls out naturally; otherwise record it as Remaining.

## Acceptance

- `n19.js` matches node on standalone (and gc).
- A regression test in `tests/issue-6974-*.test.ts` covers: an alias of a same-named fnctor; an
  alias of a uniquely named fnctor (control); a direct `new K()` of a local fnctor (control).
- The box2d harness row (`--only box2d --lanes node,standalone --timeout 900`) gets past
  `SetV`. Report how far it gets: PASS, or the next blocker.
