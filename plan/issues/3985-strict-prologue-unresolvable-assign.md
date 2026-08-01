---
id: 3985
title: "'use strict' prologue inside a function body does not take effect for unresolvable assignment"
status: in-progress
sprint: current
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
assignee: ttraenkler/g-prologue
goal: core-semantics
---

# `'use strict'` prologue inside a function body does not take effect

## Problem

A `"use strict"` directive prologue **inside a function body** is detected
correctly by the compiler, but the strict branch of the assignment lowering is
missing. An assignment to an identifier the compiler cannot resolve silently
**allocates a fresh Wasm local** instead of throwing `ReferenceError`.

```js
function fun() {
  "use strict";
  test262unresolvable = null;   // must throw ReferenceError
}
assert.throws(ReferenceError, function () { fun(); });   // ← no exception thrown
```

Signature: `Test262Error: Expected a ReferenceError to be thrown but no
exception was thrown at all`.

This is a **silent wrong answer, not a refusal** — nothing downstream can
detect it. The generated Wasm is valid; it just computes the wrong thing.

## This is a BOTH-LANES defect

Every file in the family shows **standalone-only = 0** — i.e. they fail the
**default** (JS-host / WasmGC) lane too, not just standalone. Measured on
`upstream/main` @ `e240e7525` with `runTest262File` (status is the trustworthy
half of that instrument):

```
lane=default   7/22 pass   (15 genuine failures + 7 legitimate passes/controls)
```

So this is a shared **front-end scope-analysis** defect, upstream of either
backend. Consequences:

1. It counts against **both lanes'** conformance — the same fix pays twice.
2. It is fixable **without touching standalone codegen** — small blast radius
   compared with the other levers in the standalone-gap queue.
3. It is NOT part of the standalone-gap program (#2860); filing it there would
   mis-attribute it and hide the default-lane half.

## Root cause

`src/codegen/expressions/assignment.ts`, identifier-assignment path:

```ts
// line 577 — the SLOPPY branch, correctly gated on !isStrictContext
if (!isStrictContext(expr.left, ctx.inferModuleStrictArguments) && isUnresolvableIdent(ctx, fctx, expr.left)) {
  (ctx.sloppyImplicitGlobals ??= new Set()).add(name);
  ...  // §6.2.5.6 PutValue: creates a property on the global object
}

// line 602 — the catch-all fallback that STRICT falls into
{
  const resultType = compileExpression(ctx, fctx, expr.right);
  if (!resultType) return null;
  const newLocalIdx = allocLocal(fctx, name, resultType);   // ← silently swallows the error
  fctx.body.push({ op: "local.tee", index: newLocalIdx });
  return resultType;
}
```

`isStrictContext` itself is **correct** — verified directly against the repro
AST, it returns `true` for the assignment inside `fun` under both
`inferModuleStrict` settings. The defect is the *missing strict arm*, not the
strictness detection. There is no `else` for "strict **and** unresolvable"; it
falls through to a fallback whose comment describes a different case entirely
(class/object method bodies referencing outer-scope variables not yet
captured).

That fallback must be preserved for its real case: it is reached whenever
`isUnresolvableIdent` is **false** (the TS checker resolves the name but
codegen has no slot for it). Gating the new strict arm on
`isUnresolvableIdent(...) === true` keeps those on the existing path.

## Why a static throw is wrong — the fix must be runtime-checked

`isUnresolvableIdent` is a **compiler-knowledge** predicate, not the spec
predicate. Per §9.1.1.4 `GlobalEnvironmentRecord.HasBinding`, a name that
exists as a property of the global object at *runtime* IS resolvable, even
when no declaration is visible to the checker. So a compile-time
`throw ReferenceError` would be a new class of wrong answer.

The lowering therefore mirrors §13.15.2 + §6.2.5.6 exactly:

1. `has := __extern_has(globalEnvObject, "name")` — captured **before** the RHS.
   §13.15.2 resolves the LHS Reference *first*; computing HasBinding after the
   RHS lets an RHS that adds the property change the decision (this is the same
   trap that regressed `S11.13.1_A6_T3` for the dynamic-`with` gate, see
   `emitCaptureWithHasBinding` in `src/codegen/with-scope.ts`).
2. Evaluate the RHS — its side effects are observable **before** the throw.
3. `if (has) { __extern_set(obj, name, rhs); }`
   `else { throw ReferenceError("name is not defined"); }`

`__extern_has` (HasProperty — own **and** prototype chain) is the right
predicate, not `__hasOwnProperty`: the global object inherits from
`Object.prototype`, so `toString = 1` in strict code must **not** throw.
`__extern_has` is available in both lanes (host import in `src/runtime.ts`;
native arm in `src/codegen/object-runtime.ts`), so the fix stays backend-
agnostic.

## Population

Reported family — `language/directive-prologue/*-runtime.js` (11 of 16; the
other 5 legitimately expect *no* throw because the directive is not in the
prologue) plus relatives:

- `language/types/reference/8.7.2-1-s.js`, `8.7.2-3-a-1gs.js`
- `language/statements/block/S12.1_A2.js`
- `language/eval-code/direct/var-env-var-strict-caller-2.js`

Trigger-shape enumeration across the corpus is recorded below — the fix keys
on "strict context + assignment to an undeclared bare identifier", which is
broader than "nested `use strict` prologue".

## Acceptance criteria

- [ ] The 15 measured failures flip to pass in the **default** lane.
- [ ] Same files measured in the **standalone** lane.
- [ ] In-sweep controls do not move.
- [ ] Attribution proven by kill-switch **removal**, not just by the delta.
- [ ] A final arm with the measurement scaffold deleted.

## Implementation notes

(filled in as work proceeds — see `## Implementation log` below)
