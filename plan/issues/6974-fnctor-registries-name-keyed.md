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

## Implementation notes (2026-10-11, senior-dev)

Two defects, both "a bare name stands in for a binding":

1. **Constructor cache keyed by name.** `funcConstructorMap.get(calleeIdent.text)` was taken for
   every `new <identifier>`. The lookup now goes through `funcConstructorForCallee`
   (`src/codegen/fnctor-ctor-decl.ts`), which answers the cached ctor only when the callee
   identifier itself binds a function body (`function K`, `var K = function(){}`, or an import
   alias of one, resolved through `ctx.oracle.declarationsOf` / `aliasedValueDeclarationOf`).
   An alias (`var K = NS.T`), a parameter, or any other non-function binding gets `undefined`
   and constructs from its runtime value through the native construct driver. The same check
   replaces the three other bare-name `funcConstructorMap.has(...)` declines in `new-super.ts`
   (`resolvesToLateAssignedConstructSignatureValue`, `resolvesToDynamicAnyCtorValue`, and the
   driver's own early decline, which is the "driver returned null" the plan describes: the
   driver saw the name in the map and declined).
2. **Inlined IIFEs leaked hoisted function bindings.** Top-level IIFEs are inlined into one
   `__module_init` frame. `enterInlineIifeBindingScope` hid and restored the IIFE's names in
   `localMap` and a dozen other per-name tables, but not in `hoistedFunctionValueBindings` /
   `materializedHoistedFunctionValueBindings`. So after IIFE 1 declared `function K`, a closure
   in IIFE 3 that captured IIFE 3's own `var K = NS.T` "materialized the hoisted function value"
   into that slot first, and the closure saw IIFE 1's `K`. This is the second half of n19: with
   only (1) fixed, `new K` reached the driver but was handed the wrong closure. Both sets now
   join the snapshot/restore list (`src/codegen/expressions/inline-iife-scope.ts`).

`resolveUserFnctorName` (plan step 2) needed no change for the alias case: it resolves through
`resolveFnctorSymbol`, which already requires the identifier's own symbol to declare a function
body, so `var K = NS.T` never selects the `K` prototype global.

### Why step 3 (two *different* `function K` declarations) is not in this change

A first version also routed a second, different same-named declaration off the static path
(owner tracking per name, an escape-gate refusal for in-file collisions, and declaration-checked
`resolveUserFnctorName`). It fixed the ctor body that runs, but measured worse elsewhere, because
the name is also the key of:
- the checker-type → struct mapping (`resolveFnctorInstanceType(ctx, symName)`, called from
  `index.ts` `resolveWasmType`): the second `K`'s instance type is the first `K`'s
  `$__fnctor_K` struct, so the driver's `$Object` result is guard-cast to null;
- typed member reads on that type (a missing field read as f64 `NaN` instead of `undefined`);
- `__closure_proto_of` edges (`__fn_closure_<name>` → `__fnctor_proto_<name>`), so
  `instanceof` on the second `K` answered `false`.

Measured on `n25` (four nested functions, two pairs of same-named `function C`): base
`1,2,5:true,6:true` (only the ctor body is wrong); first version `1,12,5:false,6:false`. Trading
one wrong answer for two is a regression, so the shipped change keeps the legacy behaviour for
that shape. box2d does not need it: of its identifier `new` sites only `Box2D.inherit`'s `new K` targets a function declaration
directly; the other 412 go through aliases.

## Results

- `tests/issue-6974-fnctor-alias-name-keying.test.ts` (standalone, Script goal, no eval
  provider): 3 cases fail on `origin/main` and pass with the fix; 2 controls pass on both.
- n19 itself (`var K = NS.T`, an `any`-typed alias) still returns null on `main`: once the cache
  stops answering, the alias needs #6954's dynamic-new arm, which is not on `main` yet. On
  `c-octane-integ` + this fix n19 prints `number:undefined` (matches node). The gc lane prints
  `number:undefined` on `main` + this fix.
- Octane box2d (`c-octane-integ` + this fix, `--lanes node,standalone --timeout 900`):
  gets past `SetV`: module init and `new b2World(gravity, true)` now complete;
  it now fails in the harness at `shape.SetAsEdge(...)` with `TypeError: called value is not a
  function` (node score 132555, standalone `runtime-error`). That failure is pre-existing on
  `c-octane-integ` (the repro below fails identically without this fix); it was hidden behind
  `SetV`.

## Remaining

- **Same-named distinct declarations (plan step 3).** Needs the instance-type mapping keyed by
  declaration: `resolveFnctorInstanceType` takes only the symbol name from `index.ts`, so the fix
  touches `index.ts`. Proposal: key `fnctorReservedTypeIdx` / `funcConstructorMap` /
  `fnctorPrototypeObject` by a per-declaration key (`<name>` for the first declaration,
  `<name>$<n>` for later ones, assigned once by the escape gate from `ctorDeclByName`'s
  first-seen order), and pass the declaration (not the name) from `resolveWasmType`. Until
  then, a second same-named fnctor runs the first one's ctor body (pre-existing, unchanged).
- **n10 (plan step 4).** Unchanged by this fix on `main` (`function/function/true,undefined`,
  node `…,function`): an IIFE-nested fnctor's prototype written as `w.prototype.m = …` is not the
  object a `new` through an alias links to. Not on box2d's path in the measured run.
- **Next box2d blocker (new issue): a fnctor instance used as a prototype is a struct, and
  `__object_create` drops it.** `Box2D.inherit = function (y, w) { K.prototype = w.prototype;
  y.prototype = new K; … }`. `new K` is an approved empty-body fnctor, but the reconstruct gate's
  consumer check (`fnctorNewResultConsumedAsExternref`, `new-super.ts`) accepts only an
  externref local/global or an inline `new F().x` receiver, not the right-hand side of a member
  assignment. So `new K` stays a `$__fnctor_K` struct and becomes `y.prototype`. The native
  construct driver then calls `__object_create(proto)`, which keeps `proto` only when it is an
  `$Object` and otherwise links null. Every `new <subclass>` instance therefore misses the
  subclass's prototype methods. Minimized (`c-octane-integ`, standalone; node
  `number:number:true:true`, standalone `number:undefined:false:true`):

  ```js
  var NS = {};
  (function () { function q() { this.q = 2; } NS.Poly = q; })();
  function K() {}
  function setProto(y) { y.prototype = new K; }
  setProto(NS.Poly);
  export function main() {
    var P = NS.Poly, pp = P.prototype; pp.tag = 1; var s = new P();
    return typeof pp.tag + ":" + typeof s.tag + ":" + (Object.getPrototypeOf(s) === pp) + ":" + (pp instanceof K);
  }
  ```

  `var t = new K; y.prototype = t;` passes, because the local is externref and the instance is
  reconstructed as an `$Object`. An experiment (not shipped) that also accepts
  `<member> = new F` in `fnctorNewResultConsumedAsExternref` fixes this repro and the
  box2d-shaped `inherit` repros. With it box2d gets further and fails in `b2Island.Solve` at
  `e.m_force.x` (`Cannot access property on null or undefined`, driver line 620:218:
  `m_force`, set by `b2Body`'s static initializer, reads back undefined). Not investigated.
