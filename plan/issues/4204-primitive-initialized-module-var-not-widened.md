---
id: 4204
title: "standalone: a primitive-initialized module `var` reassigned to another JS type silently becomes NaN (slot pinned from the initializer)"
status: in-progress
assignee: ttraenkler/W24
sprint: current
created: 2026-08-07
updated: 2026-08-07
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen
language_feature: type-inference, value-representation
goal: value-rep
es_edition: ES5
related: [4202, 3364, 2372, 2011, 2837, 3369, 1236, 2057]
origin: "#4202's residue census, row 8 — 8 files read as a §10.4.3 receiver bug; the receiver is correct and the BINDING loses the value."
# (#4204) The widening decision lives in `moduleGlobalWasmType`, which is a
# closure inside `collectDeclarations` in declarations.ts — the one place that
# picks a module global's ValType. The bulk of the change is the new leaf module
# `src/codegen/declarations/heterogeneous-scalar-var-widening.ts`; what lands in
# the two god-files is a lazy-init line + a 5-line guard in the type picker, and
# two 4-line unsound-fold guards next to the existing ones in the typeof
# const-folder. Both are in-place additions to existing decision ladders, not
# new subsystem logic that could live elsewhere.
loc-budget-allow:
  - src/codegen/declarations.ts
  - src/codegen/typeof-delete.ts
# (#4204) `moduleGlobalWasmType` is a closure inside `collectDeclarations`, so
# every line added to the type picker is charged to that function. The addition
# is one entry in its existing `?? … ?? …` fallback chain (the analysis, its
# memo and the widening decision all live in the leaf module); the +5 is the
# cost of prettier wrapping a now-three-term return, not of new logic here.
func-budget-allow:
  - src/codegen/declarations.ts::collectDeclarations
---

# #4204 — primitive-initialized module `var` is not widened on a heterogeneous assignment

## Problem

`moduleGlobalWasmType` (`src/codegen/declarations.ts`) commits a top-level
binding's Wasm slot from its **initializer alone**:

```js
var x = 2;              // (global $__mod_x (mut f64) (f64.const 0))
var o = {};
x = o;                  // externref squeezed through an f64 slot
x === o                 // false
String(x)               // "NaN"
```

No diagnostic, no trap — the value is simply gone. The same shape with a
string (`var d = "s"`) or a bare `var e;` answers `true`, because those slots
are a string ref and an externref respectively.

This is what §10.4.3's `10.4.3-1-{56,57,60,61}{-s,gs}` were failing on. They
read as "the setter's `this` is wrong"; the setter fires and its `this` is
correct. The tests write `x = this` where `x` is a top-level `var x = 2`.

The family is wider than `number → object`. Measured on `origin/main@d9feaef47c`
in `--target standalone`: `number→object`, `number→string`, `number→null`,
`number→array`, `number→function` and `boolean→object` all produce a wrong
value; `string→number` **traps** with `dereferencing a null pointer`.

## Why widening to `externref` is the right lowering

A bare `var x;` already gets `(mut externref)`, and that representation is
fully exercised in standalone today — numbers round-trip through it, and so do
arithmetic, `typeof`, string concatenation, relational compare, `switch`,
strict equality, `Math.max`, `.toFixed` and `for`-loop counters (each verified
individually before the fix was written). So the correct representation
already exists; the defect is only that the type picker never selects it.

## Fix

`src/codegen/declarations/heterogeneous-scalar-var-widening.ts` — a pre-pass
over the whole source file (nested functions included: a module global is
routinely written from inside a setter, which is exactly the §10.4.3 shape).
For every `<ident> = <expr>` whose LHS resolves — **by binding identity via
`ctx.oracle.variableDeclarationOf`, not by name** (the #3364 bare-name-keying
failure mode) — to a module-scoped `var`/`let` with a primitive-tagged
initializer, the binding widens to `externref` when the assigned expression's
static JS tag is **known and different**.

Deliberately narrow:

- **A `mixed` RHS does NOT widen.** An unresolvable tag is not evidence of
  heterogeneity. The syntactic upper bound for "assignment with an unknown
  RHS" is 5,943 files corpus-wide against 55 provable ones; widening on
  unknown would move that whole set onto the dynamic representation for no
  measured benefit.
- **One named exception: a bare `this`.** TypeScript declines to type `this`
  in a non-arrow function (`any` → `mixed`), but §10.4.3 defines it as a
  runtime receiver the callee cannot constrain. Without this arm
  `10.4.3-1-{60,61}` (the `Object.defineProperty`-injected setter, where the
  object-literal shorthand's contextual `this` is absent) stay broken while
  `{56,57}` are fixed.
- **Not tagged in `externrefAccessorVars`.** This is a value-carrier widening,
  not a host-property-access reroute.

### Second seam: the checker type outlives the representation

A widened binding keeps its initializer-derived checker type — `var x = 2` is
still `number` to TypeScript after `x = this` forces the slot to `externref`.
Consumers that *lower* from the checker type are fine (they go through the
ordinary externref coercions and observe the real value); the one that
**const-folds** is not. `typeof x` folded to the literal `"number"` and never
read the value at all, in both the general `compileTypeofExpression` path and
the `typeof x === "…"` comparison fast path.

Guarded as `moduleGlobalIsDynamicButStaticallyPrimitive` — a
representation-vs-static-type disagreement rather than a #4204 flag — so it
also covers the pre-existing externref overrides (#2011 / #2837 / #3369),
which carry the same latent mismatch.

## Measurement

See `## Measured population` and `## A/B` below.

## Not in scope

- **`(function () { … }).call(o)` with `a = this` inside an inline function
  expression.** The binding widens correctly; the value never arrives, because
  `calls.ts` rewrites an inline function-expression callee to a direct
  invocation and drops the `thisArg`. That is #4202's row 4 (the seam #4192
  fixed for the variable-held form), not a representation bug.
- **`10.4.3-1-{100,101,102}{-s,gs}`** — `illegal cast in __module_init()` from
  passing a function to `String.prototype.replace`. They carry the `var x = 2;
  x = this` shape too, so they appear in this issue's reachability set, but
  they fail upstream of it and are unchanged by this fix (#4202 row 6).
- **Function-LOCAL `var` with the same shape.** `function f(){ var a = 2; var
  o = {}; a = o; return typeof a; }` is still wrong on this branch. The local
  slot is picked by a different site (`statements/variables.ts`), and moving
  it is a separate, larger blast radius. Filed as follow-up work rather than
  folded in.
