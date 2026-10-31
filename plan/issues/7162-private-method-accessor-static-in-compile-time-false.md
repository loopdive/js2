---
id: 7162
title: "All lanes: `#m in v` for a private method, accessor or static private name is compile-time false for every operand"
status: done
sprint: current
created: 2026-10-25
updated: 2026-10-31
completed: 2026-10-31
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: classes
goal: correctness
parent: 6979
related: [7150, 7160, 7163]
---

# #7162 — private `in` only works for instance fields

Found by the fresh-context review of PR #6915 (#7150, finding 3). Pre-existing
on `origin/main`, every lane:

```js
class C { #m() {} static has(o: unknown) { return #m in o; } }
for (const v of [new C(), {}, null, 1, "s"]) { try { console.log(C.has(v)); } catch (e) { console.log(e.name); } }
// node: true false TypeError TypeError TypeError
// js2 (all lanes): false false false false false
```

Same for `get #a() {}` / `set #a(v) {}` and `static #s = 1` (`#s in C` is true
in node, `#s in new C()` false).

## Cause (as diagnosed; verify before fixing)

`compileInOperator`'s private arm (`src/codegen/binary-ops-in.ts`, around the
`resolveDeclaringClassForPrivateName` call) resolves the declaring class only
for private instance fields; for a method, accessor or static field it finds
nothing, and the whole arm falls through to the legacy compile-time path which
folds the expression to `false`.

## Implementation Plan (Fable, 2026-10-25; implement on Opus)

1. Reproduce the three programs on gc native-first, standalone and wasi
   (and host-assisted, which is also wrong).
2. Extend the private-name resolution to methods, accessors and static
   fields (via `ctx.oracle`; never the raw checker): a private method or
   accessor name is "in" `v` exactly when `v` carries the class's instance
   brand (same brand test as the field case, since methods live on the brand,
   not per instance); a static private name is "in" `v` exactly when `v` is the
   class constructor itself (compare identity with the class value). Non-object
   operands throw the #7150 TypeError on the no-host lanes.
3. Tests: `tests/issue-7162-private-in-method-accessor-static.test.ts` with
   the three programs plus a subclass instance (method brand inherited → true)
   on the no-host lanes vs node; keep #7150's 39 rows green.

Acceptance: node's output for all three programs on gc native-first,
standalone and wasi; host-assisted gc bytes unchanged unless the host arm must
change (then state the delta); equivalence gate no new regressions.

## Resolution (2026-10-31)

`compileInOperator`'s private arm now resolves its target with a local
`resolvePrivateInTarget` (`src/codegen/binary-ops-in.ts`): the innermost class
that declares the name in its own body decides.

- **Instance field**: unchanged, via `resolveDeclaringClassForPrivateName`.
- **Instance method or accessor**: the declaring class's struct, then the
  same own-brand test as fields (`emitOwnPrivateBrandPredicate`, which keeps
  the #7160 constructor/prototype exclusion).
- **Static private name** (field, method or accessor): `ref.eq` with the
  declaring class's `__class_<C>` singleton, so a subclass constructor answers
  false.

Non-objects throw the #7150 TypeError on every lane, through the existing guard.
No shared helper, `ref.test` legality or classifier changed, and no host
import was added.

Tests: `tests/equivalence/issue-7162-private-in-method-accessor-static.test.ts`
has 104 rows, diffed against node on gc native-first, standalone and wasi. It
covers methods, accessors (pair, getter-only, setter-only), static fields,
methods and getters, subclass instances and constructors, `C.prototype`,
Proxy, `Object.create`, unrelated same-named classes, typed parameters,
`this`, class expressions (anonymous and named) and nested shadowing.

Bytes (unoptimized, 3 lanes): the 13 playground examples plus 268 equivalence
sources. Only the 104 #7162 programs changed. Every other program, including
the 39 other private-`in` sources, is byte-identical.

Left out: a static method's `this` is compiled as the declaring class on every
lane, so `class D extends C {}; D.st()` with `static st() { return #st in this; }`
answers true; node answers false. This is a separate defect (`this === C` is
also true inside `D.who()`), not the `in` arm.
